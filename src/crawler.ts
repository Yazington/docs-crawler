//
// src/crawler.ts
//
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process"; // For running unstructured
import puppeteer from "puppeteer";

import {
  qdrantClient,
  ensureCollectionExists,
  upsertChunksToQdrant,
} from "./qdrant.js";
import { VECTOR_SIZE } from "./embeddings.js";
import { extractLinksFromPage, extractMarkdownFromPage } from "./textUtils.js"; // Import the new function

// Define the structure for page data items used locally before upserting
interface PageDataItem {
  chunk: string;
  metadata: {
    pageUrl: string;
    linksFound: string[];
  };
}

// No longer needed: UnstructuredElement interface

/**
 * Performs a Breadth-First Search crawl of a website up to depth=2.
 * Extracts content as Markdown using 'dom-to-semantic-markdown', saves locally, and upserts embeddings to Qdrant.
 */
export async function bfsCrawl(
  baseUrl: string,
  forceRecrawl: boolean
): Promise<void> {
  // Slug for storing data on disk & naming the Qdrant collection
  const baseUrlSlug = baseUrl
    .replace(/https?:\/\//, "")
    .replace(/[^\w\d]+/g, "_")
    .toLowerCase();

  // Data folder: e.g. ./data/example_com_docs
  const dataFolder = path.join("./data", baseUrlSlug);

  // Additional folder in user's home directory
  const homeDir = os.homedir();
  const homeCrawlFolder = path.join(homeDir, "crawled-docs", baseUrlSlug);

  // If forceRecrawl => remove existing data & re-crawl
  if (forceRecrawl) {
    console.warn(`Force recrawl enabled for ${baseUrl}. Removing old data...`);
    if (fs.existsSync(dataFolder)) {
      fs.rmSync(dataFolder, { recursive: true, force: true });
      console.log(`Removed old data folder: ${dataFolder}`);
    }
    if (fs.existsSync(homeCrawlFolder)) {
      fs.rmSync(homeCrawlFolder, { recursive: true, force: true });
      console.log(`Removed old home crawl folder: ${homeCrawlFolder}`);
    }
    // Delete the Qdrant collection if it exists
    try {
      const existingCollections = await qdrantClient.getCollections();
      const exists = existingCollections.collections?.some(
        (c: { name: string }) => c.name === baseUrlSlug
      );
      if (exists) {
        await qdrantClient.deleteCollection(baseUrlSlug);
        console.log(`Removed old Qdrant collection: ${baseUrlSlug}`);
      } else {
        console.log(
          `Qdrant collection ${baseUrlSlug} did not exist, skipping removal.`
        );
      }
    } catch (qdrantErr) {
      console.warn(
        `Error during Qdrant collection removal for ${baseUrlSlug}: ${qdrantErr}`
      );
    }
  }

  // Ensure local data folders exist
  if (!fs.existsSync(dataFolder)) {
    fs.mkdirSync(dataFolder, { recursive: true });
  }
  if (!fs.existsSync(path.join(homeDir, "crawled-docs"))) {
    fs.mkdirSync(path.join(homeDir, "crawled-docs"), { recursive: true });
  }
  if (!fs.existsSync(homeCrawlFolder)) {
    fs.mkdirSync(homeCrawlFolder, { recursive: true });
  }

  // Prepare Qdrant collection
  await ensureCollectionExists(baseUrlSlug, VECTOR_SIZE);

  // BFS structures
  const toVisit: Array<{ url: string; depth: number }> = [
    { url: baseUrl, depth: 1 },
  ];
  const visited = new Set<string>();

  console.error(`Launching Puppeteer browser...`);
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  // No longer needed: tempDir, unstructuredCLIPath

  try {
    while (toVisit.length > 0) {
      const { url, depth } = toVisit.shift()!;
      let normalizedUrl = url.split("#")[0];
      if (normalizedUrl !== baseUrl && normalizedUrl.endsWith("/")) {
        normalizedUrl = normalizedUrl.slice(0, -1);
      }

      if (visited.has(normalizedUrl)) {
        console.log(`Skipping already visited: ${normalizedUrl}`);
        continue;
      }
      visited.add(normalizedUrl);

      console.error(`Crawling: ${normalizedUrl} (depth=${depth})...`);
      const page = await browser.newPage();
      let markdownContent = ""; // Renamed from unstructuredText
      let linksFound: string[] = [];
      let pageData: PageDataItem[] = [];

      // No longer needed: fileSlugForTemp, tempHtmlPath, tempJsonPath

      try {
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        );
        await page.setDefaultNavigationTimeout(60000); // Increased timeout for slow sites

        console.error(`Navigating to URL: ${normalizedUrl}`);
        const response = await page.goto(normalizedUrl, {
          waitUntil: "networkidle2",
          timeout: 60000, // Also increase the timeout here for consistency
        });

        // Handle redirects - use the final URL
        const finalUrl = page.url();
        if (finalUrl !== normalizedUrl) {
          console.error(`Redirected from ${normalizedUrl} to ${finalUrl}`);
          normalizedUrl = finalUrl; // Update normalized URL to the redirected one
          // If we've already visited this URL after redirect, skip it
          if (visited.has(finalUrl)) {
            console.error(
              `Already visited the redirect target: ${finalUrl}, skipping`
            );
            await page.close();
            continue;
          }
          visited.add(finalUrl); // Mark the redirected URL as visited
        }

        const status = response?.status();
        if (!response || (status && status >= 400)) {
          console.error(
            `Failed to load page (${
              status ?? "unknown status"
            }): ${normalizedUrl}`
          );
          await page.close();
          continue;
        }

        // Wait an extra second for any dynamic content to load
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // 1. Extract Markdown content directly using the new function
        try {
          console.error(`Extracting Markdown from ${normalizedUrl}...`);
          markdownContent = await extractMarkdownFromPage(page);
          console.log(
            `Extracted ${markdownContent.length} chars of Markdown from ${normalizedUrl}`
          );
        } catch (extractErr) {
          console.error(
            `Error extracting Markdown from ${normalizedUrl}:`,
            extractErr
          );
          // Continue to link extraction even if markdown fails? Or skip? Let's skip for now.
          await page.close();
          continue;
        }

        // DEBUG: Log the extracted markdown content
        console.log(`--- DEBUG: Extracted Markdown for ${normalizedUrl} ---`);
        console.log(
          markdownContent.substring(0, 500) +
            (markdownContent.length > 500 ? "..." : "")
        ); // Log first 500 chars
        console.log(`--- END DEBUG ---`);

        // 2. Extract links if depth=1 (so we can queue depth=2)
        if (depth === 1) {
          try {
            linksFound = await extractLinksFromPage(page, baseUrl);
          } catch (linkErr) {
            console.error(
              `Error extracting links from ${normalizedUrl}:`,
              linkErr
            );
            // Continue processing even if link extraction fails
          }
          for (const link of linksFound) {
            let normalizedLink = link.split("#")[0];
            if (normalizedLink !== baseUrl && normalizedLink.endsWith("/")) {
              normalizedLink = normalizedLink.slice(0, -1);
            }
            if (
              !visited.has(normalizedLink) &&
              normalizedLink.startsWith(baseUrl)
            ) {
              if (!toVisit.some((item) => item.url === normalizedLink)) {
                toVisit.push({ url: normalizedLink, depth: depth + 1 });
              }
            }
          }
        }
      } catch (err) {
        console.error(`Error processing ${normalizedUrl}:`, err);
      } finally {
        if (!page.isClosed()) {
          await page.close();
        }
        // No longer need temp file cleanup here
      }

      // If no markdown content was extracted, skip storing
      if (markdownContent.trim().length === 0) {
        console.log(
          // Keep this log
          `No Markdown content extracted for ${normalizedUrl}, skipping storage.`
        );
        continue;
      }

      // Build a single chunk object using the extracted Markdown
      pageData = [
        {
          chunk: markdownContent, // Use the extracted markdown
          metadata: {
            pageUrl: normalizedUrl,
            linksFound,
          },
        },
      ];

      // Save locally
      const fileSlug = normalizedUrl
        .replace(/https?:\/\//, "")
        .replace(/[^\w\d]+/g, "_")
        .toLowerCase();
      const filePath = path.join(dataFolder, fileSlug + ".json");
      const homeFilePath = path.join(homeCrawlFolder, fileSlug + ".json");

      try {
        // DEBUG: Log before writing
        console.log(`--- DEBUG: Writing data for ${normalizedUrl} ---`);
        console.log(`File path: ${filePath}`);
        console.log(`Data length: ${JSON.stringify(pageData).length}`);
        console.log(`--- END DEBUG ---`);

        fs.writeFileSync(filePath, JSON.stringify(pageData, null, 2), "utf-8");
        fs.writeFileSync(
          homeFilePath,
          JSON.stringify(pageData, null, 2),
          "utf-8"
        );
        console.log(`Saved 1 chunk from ${normalizedUrl} to local files.`);
      } catch (writeErr) {
        console.error(
          `Error writing local files for ${normalizedUrl}:`,
          writeErr
        );
        continue;
      }

      // Upsert to Qdrant
      await upsertChunksToQdrant(baseUrlSlug, fileSlug, pageData);

      console.log(`Successfully processed and stored ${normalizedUrl}`);
    }
  } finally {
    // Close Puppeteer
    await browser.close();
    console.error(`Puppeteer browser closed.`);
    // No longer need final temp directory cleanup
  }

  console.log(`Crawling complete for ${baseUrl}. Data saved in:
  - Local Project: ${dataFolder}
  - Home Directory: ${homeCrawlFolder}
  - Qdrant Collection: ${baseUrlSlug}`);
}
