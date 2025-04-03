// src/textUtils.ts

import type { Page } from "puppeteer"; // Import Page type for type safety
import { convertHtmlToMarkdown } from "dom-to-semantic-markdown";
import { JSDOM } from "jsdom"; // Import JSDOM

// Maximum size for each chunk in characters
export const MAX_CHUNK_SIZE = 4000; // Reduced from 6000 to create more focused chunks
// Minimum size for a chunk that could stand on its own
export const MIN_CHUNK_SIZE = 250;
// Size of overlap between chunks to maintain context
export const CHUNK_OVERLAP = 500;

interface SectionNode {
  title: string;
  level: number;
  content: string;
  children: SectionNode[];
  startPosition: number;
}

/**
 * Splits text into semantic chunks based on headers, paragraphs, and content structure.
 * Uses sliding window approach with overlap for large sections.
 *
 * @param markdown The markdown text to chunk
 * @param metadata Optional metadata to include in the result
 * @returns Array of chunks, each with text and metadata
 */
export function semanticChunking(
  markdown: string,
  metadata: Record<string, any> = {}
): Array<{ text: string; metadata: Record<string, any> }> {
  if (!markdown || markdown.trim().length === 0) {
    return [];
  }

  // Step 1: Parse the document structure into a hierarchical tree based on headings
  const docStructure = parseDocumentStructure(markdown);

  // Step 2: Process the structure into chunks
  return processStructureIntoChunks(docStructure, metadata);
}

/**
 * Parse markdown into a hierarchical document structure based on headers
 */
function parseDocumentStructure(markdown: string): SectionNode {
  // Root node of the document
  const root: SectionNode = {
    title: "Document Root",
    level: 0,
    content: "",
    children: [],
    startPosition: 0,
  };

  // Current position in the parse process
  let currentSection: SectionNode = root;
  let currentContent = "";
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line is a header (markdown headers start with # to ######)
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headerMatch) {
      // We found a header, so commit any accumulated content to the current section
      if (currentContent.trim()) {
        currentSection.content += currentContent.trim();
        currentContent = "";
      }

      // Determine header level and title
      const level = headerMatch[1].length;
      const title = headerMatch[2].trim();

      // Create a new section node
      const newSection: SectionNode = {
        title,
        level,
        content: "",
        children: [],
        startPosition: i,
      };

      // Find the appropriate parent for this section based on header level
      let parent = root;
      for (let j = root.children.length - 1; j >= 0; j--) {
        const potentialParent = findDeepestSectionWithLevelLessThan(
          root.children[j],
          level
        );
        if (potentialParent && potentialParent.level < level) {
          parent = potentialParent;
          break;
        }
      }

      // Add the new section to its parent
      parent.children.push(newSection);
      currentSection = newSection;
    } else {
      // Not a header, accumulate content
      currentContent += line + "\n";
    }
  }

  // Add any remaining content to the current section
  if (currentContent.trim()) {
    currentSection.content += currentContent.trim();
  }

  return root;
}

/**
 * Find the deepest section with a level less than the given level
 */
function findDeepestSectionWithLevelLessThan(
  section: SectionNode,
  level: number
): SectionNode | null {
  if (section.level < level) {
    // If this section has no children, or none have a level less than the target
    if (section.children.length === 0) {
      return section;
    }

    // Try to find a deeper section among the children
    for (let i = section.children.length - 1; i >= 0; i--) {
      const deeperSection = findDeepestSectionWithLevelLessThan(
        section.children[i],
        level
      );
      if (deeperSection) {
        return deeperSection;
      }
    }

    // If no deeper section was found among children, return this one
    return section;
  }

  return null;
}

/**
 * Process the document structure into content chunks
 */
function processStructureIntoChunks(
  rootNode: SectionNode,
  baseMetadata: Record<string, any>
): Array<{ text: string; metadata: Record<string, any> }> {
  const chunks: Array<{ text: string; metadata: Record<string, any> }> = [];

  // Process each top-level section
  for (const section of rootNode.children) {
    processSection(section, "", chunks, baseMetadata);
  }

  // Handle any content in the root node itself
  if (rootNode.content.trim()) {
    addContentToChunks(rootNode.content, "Introduction", chunks, baseMetadata);
  }

  return chunks;
}

/**
 * Process a section and its children into chunks
 */
function processSection(
  section: SectionNode,
  parentPath: string,
  chunks: Array<{ text: string; metadata: Record<string, any> }>,
  baseMetadata: Record<string, any>
): void {
  // Create the section path (breadcrumb) for context
  const sectionPath = parentPath
    ? `${parentPath} > ${section.title}`
    : section.title;

  // Add the section's own content
  if (section.content.trim()) {
    // Create a markdown representation with the heading
    const headingMarks = "#".repeat(section.level);
    const contentWithHeading = `${headingMarks} ${section.title}\n\n${section.content}`;

    addContentToChunks(contentWithHeading, sectionPath, chunks, baseMetadata);
  }

  // Process all children recursively
  for (const child of section.children) {
    processSection(child, sectionPath, chunks, baseMetadata);
  }
}

/**
 * Add content to chunks, splitting if necessary based on size
 */
function addContentToChunks(
  content: string,
  sectionPath: string,
  chunks: Array<{ text: string; metadata: Record<string, any> }>,
  baseMetadata: Record<string, any>
): void {
  // If content is small enough, add it directly
  if (content.length <= MAX_CHUNK_SIZE) {
    chunks.push({
      text: content,
      metadata: {
        ...baseMetadata,
        section: sectionPath,
      },
    });
    return;
  }

  // For larger content, we need to split it into overlapping chunks
  const paragraphs = splitIntoParagraphs(content);

  let currentChunk = "";
  let currentParagraphIndex = 0;

  while (currentParagraphIndex < paragraphs.length) {
    // Add paragraphs until we reach or exceed the chunk size
    while (
      currentParagraphIndex < paragraphs.length &&
      currentChunk.length + paragraphs[currentParagraphIndex].length + 1 <=
        MAX_CHUNK_SIZE
    ) {
      if (currentChunk) currentChunk += "\n\n";
      currentChunk += paragraphs[currentParagraphIndex];
      currentParagraphIndex++;
    }

    // If we've built up a substantial chunk, add it
    if (currentChunk.length >= MIN_CHUNK_SIZE) {
      chunks.push({
        text: currentChunk,
        metadata: {
          ...baseMetadata,
          section: sectionPath,
        },
      });
    }

    // If we've processed all paragraphs, we're done
    if (currentParagraphIndex >= paragraphs.length) {
      break;
    }

    // For overlap, go back a few paragraphs, but ensure we make forward progress
    const backtrackCount = Math.min(
      // Don't go back further than half the paragraphs we've processed
      Math.floor(currentParagraphIndex / 2),
      // And ensure we have some minimum overlap
      Math.max(1, Math.ceil(CHUNK_OVERLAP / 100))
    );

    // Reset to create next chunk with overlap
    currentParagraphIndex = Math.max(0, currentParagraphIndex - backtrackCount);
    currentChunk = "";
  }
}

/**
 * Split text into paragraphs
 */
function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Legacy function maintained for backward compatibility.
 * Splits text into paragraphs first, then ensures each chunk is ~<= 6000 chars.
 */
export function chunkTextTo6000Chars(rawText: string): string[] {
  // Simply delegate to semantic chunking, but discard the metadata and keep just the text
  console.error(
    "Legacy chunkTextTo6000Chars function called, using semantic chunking instead"
  );
  return semanticChunking(rawText).map((chunk) => chunk.text);
}

/**
 * Extracts HTML content from a Puppeteer page, converts it to semantic Markdown.
 * Removes script and style elements before extraction.
 */
export async function extractMarkdownFromPage(page: Page): Promise<string> {
  // Extract HTML content from the page
  const htmlContent = await page.evaluate(() => {
    // Remove script and style elements from consideration
    const scripts = document.querySelectorAll("script, style");
    scripts.forEach((script) => script.remove());

    // Try a cascade of common selectors for main content
    const commonSelectors = [
      "main", // Main content
      "article", // Common for blog/docs
      ".content", // Common class for content
      ".documentation", // Common for docs
      "#content", // Common id for content
      ".main-content", // Another common class
      ".docs-content", // Specific to docs sites
      "div.container div.row div.col:not(.sidebar)", // Bootstrap-like layouts
      "div.right-column", // Some doc sites
      "[role='main']", // Accessibility role
    ];

    // Try each selector in order
    let mainContent = null;
    for (const selector of commonSelectors) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement) {
        mainContent = element;
        console.log(`Found content with selector: ${selector}`);
        break;
      }
    }

    // If we found content
    if (mainContent instanceof HTMLElement) {
      // Remove script and style elements from the main content
      const mainScripts = mainContent.querySelectorAll("script, style");
      mainScripts.forEach((script) => script.remove());
      return mainContent.innerHTML || ""; // Return innerHTML
    } else {
      // Fallback to body if no selectors match
      console.warn(
        "No content selectors matched, falling back to document.body"
      );

      // Try to at least exclude obvious non-content areas
      const nonContentSelectors = [
        "header",
        "footer",
        "nav",
        ".navigation",
        ".sidebar",
        ".menu",
        "#menu",
        ".navbar",
        ".footer",
        ".header",
      ];

      // Create a copy of the body
      const bodyClone = document.body.cloneNode(true) as HTMLElement;

      // Remove all non-content elements from the clone
      for (const selector of nonContentSelectors) {
        const elements = bodyClone.querySelectorAll(selector);
        elements.forEach((el) => el.parentNode?.removeChild(el));
      }

      // Remove scripts and styles
      const bodyScripts = bodyClone.querySelectorAll("script, style");
      bodyScripts.forEach((script) => script.remove());

      return bodyClone.innerHTML || ""; // Return innerHTML of cleaned body
    }
  });

  // Create a JSDOM instance to parse the HTML
  const dom = new JSDOM(htmlContent);
  const parser = new dom.window.DOMParser(); // Create an instance of the parser

  // --- DEBUG ---
  console.log(
    "--- DEBUG: HTML content passed to convertHtmlToMarkdown (first 500 chars) ---"
  );
  console.log(
    htmlContent.substring(0, 500) + (htmlContent.length > 500 ? "..." : "")
  );
  // --- END DEBUG ---

  let markdown = ""; // Initialize markdown as empty string
  try {
    // Convert the extracted HTML to Markdown using the library, providing the DOMParser instance
    markdown = convertHtmlToMarkdown(htmlContent, {
      overrideDOMParser: parser, // Provide the parser instance
      // Optional configuration for the library can go here
    });

    // --- DEBUG ---
    console.log(
      "--- DEBUG: Raw Markdown result from convertHtmlToMarkdown (first 500 chars) ---"
    );
    console.log(
      markdown.substring(0, 500) + (markdown.length > 500 ? "..." : "")
    );
    // --- END DEBUG ---
  } catch (conversionError) {
    console.error(
      "--- DEBUG: Error during convertHtmlToMarkdown ---",
      conversionError
    );
    markdown = ""; // Ensure markdown is empty on error
  }

  // Basic cleanup (optional, library might handle this)
  const cleanedMarkdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  // --- DEBUG ---
  console.log("--- DEBUG: Cleaned Markdown result (first 500 chars) ---");
  console.log(
    cleanedMarkdown.substring(0, 500) +
      (cleanedMarkdown.length > 500 ? "..." : "")
  );
  console.log(
    `--- DEBUG: Cleaned Markdown total length: ${cleanedMarkdown.length} ---`
  );
  // --- END DEBUG ---

  return cleanedMarkdown;
}

/**
 * Extracts links from a Puppeteer page that belong to the same base URL.
 * Handles both absolute and relative URLs.
 */
export async function extractLinksFromPage(
  page: Page,
  baseUrl: string
): Promise<string[]> {
  console.log(`Extracting links from page with baseUrl: ${baseUrl}`);

  // Make sure the base URL is normalized
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";

  // Extract all links from the page
  const links = await page.evaluate((baseUrl) => {
    // Helper function to convert relative URLs to absolute
    function resolveRelative(relativeUrl: string, base: string): string {
      try {
        return new URL(relativeUrl, base).href;
      } catch (e) {
        console.log(`Error resolving URL: ${relativeUrl} with base ${base}`);
        return "";
      }
    }

    // Get all anchor elements
    const anchors = Array.from(document.querySelectorAll("a"));
    const results: string[] = [];

    // Process each anchor
    for (const anchor of anchors) {
      let href = anchor.getAttribute("href");

      // Skip if no href or it's a javascript: or mailto: link
      if (
        !href ||
        href.startsWith("javascript:") ||
        href.startsWith("mailto:") ||
        href.startsWith("#") ||
        href === "/"
      ) {
        continue;
      }

      // Resolve relative URLs
      if (!href.startsWith("http://") && !href.startsWith("https://")) {
        href = resolveRelative(href, baseUrl);
      }

      // Only keep URLs if they're not empty
      if (href) {
        results.push(href);
      }
    }

    // Log count for debugging
    console.log(`Found ${results.length} links in total`);
    return results;
  }, normalizedBaseUrl);

  // Filter for links within the same domain and docs path
  const filteredLinks = links.filter((href) => {
    try {
      const url = new URL(href);
      const baseUrlObj = new URL(normalizedBaseUrl);

      // Check hostname
      if (url.hostname !== baseUrlObj.hostname) {
        return false;
      }

      // Check if the path starts with the base path
      // or if it's the docs section in a different path structure
      const isInBasePath = url.pathname.startsWith(baseUrlObj.pathname);
      const isDocsPath =
        url.pathname.includes("/docs/") ||
        url.pathname.includes("/guide/") ||
        url.pathname.includes("/api/");

      return isInBasePath || isDocsPath;
    } catch (e) {
      // If we can't parse the URL, skip it
      console.error(`Error parsing URL ${href}: ${e}`);
      return false;
    }
  });

  // Log results for debugging
  console.log(`Filtered to ${filteredLinks.length} relevant links`);

  // Remove duplicates
  const uniqueLinks = Array.from(new Set(filteredLinks));
  console.log(`After removing duplicates: ${uniqueLinks.length} links`);

  return uniqueLinks;
}
