// src/textUtils.ts

import type { Page } from "puppeteer"; // Import Page type for type safety
import { convertHtmlToMarkdown } from "dom-to-semantic-markdown";
import { JSDOM } from "jsdom"; // Import JSDOM

/**
 * Splits text into paragraphs first, then ensures each chunk is ~<= 6000 chars.
 * If a paragraph is over 6000 chars, further split by sentences or smaller fragments.
 */
export function chunkTextTo6000Chars(rawText: string): string[] {
  // Split by double newlines / paragraph
  const paragraphs = rawText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= 6000) {
      chunks.push(paragraph);
    } else {
      // If the paragraph is bigger than 6000, try splitting by sentences
      const sentences = paragraph.split(/[.!?](\s|$)/);
      let currentChunk = "";

      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (!trimmed) continue;

        // If adding this sentence exceeds limit, push current chunk and start a new one
        if ((currentChunk + trimmed).length > 6000) {
          if (currentChunk.length > 0) {
            chunks.push(currentChunk);
          }
          currentChunk = trimmed;
        } else {
          currentChunk = currentChunk ? currentChunk + ". " + trimmed : trimmed;
        }
      }

      // Push any remainder
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
      }
    }
  }

  return chunks;
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
