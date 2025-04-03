// src/index.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import * as fs from "fs";
import * as path from "path";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import * as os from "os";

// For local vector DB (Qdrant):
import { QdrantClient } from "@qdrant/js-client-rest";

// Define our own type for vector points since the library doesn't export it
interface PointStruct {
  vector: number[];
  payload: {
    pageUrl: string;
    chunk: string;
    [key: string]: any;
  };
}

const qdrantClient = new QdrantClient({
  url: "http://localhost:6333", // Adjust if needed
});

// We’ll store everything in a named “collection” in Qdrant.
// Each unique baseUrl can be its own collection name, for easy isolation.
async function ensureCollectionExists(
  collectionName: string,
  vectorSize: number
) {
  // If the collection does not exist, create it with a simple configuration
  const existingCollections = await qdrantClient.getCollections();
  const exists = existingCollections.collections?.some(
    (c: { name: string }) => c.name === collectionName
  );

  if (!exists) {
    await qdrantClient.createCollection(collectionName, {
      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
    });
  }
}

// ---------- HELPER: SIMPLE EMBEDDINGS ----------
/**
 * Creates basic embeddings using a very simple TF-IDF approach
 * This is a simplified version that creates a fixed-size vector based on word frequencies
 */
function embedText(text: string): number[] {
  // Use a fixed vector size that matches what we created our Qdrant collection with
  const vectorSize = 384;
  const vector = new Array(vectorSize).fill(0);

  // Normalize and clean the text
  const processedText = text
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // Remove punctuation
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();

  // Get all words
  const words = processedText.split(" ");
  if (words.length === 0) {
    return Array.from({ length: vectorSize }, () => Math.random());
  }

  // Count word frequencies
  const wordFreq: Record<string, number> = {};
  for (const word of words) {
    if (word.length > 1) {
      // Skip single character words
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    }
  }

  // Convert words to a numeric representation and distribute across vector
  for (const [word, freq] of Object.entries(wordFreq)) {
    // Create a simple hash of the word
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash << 5) - hash + word.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }

    // Ensure positive index
    const index = Math.abs(hash) % vectorSize;

    // Add frequency to vector at this position
    vector[index] += freq;
  }

  // Normalize the vector (L2 norm) to make magnitudes comparable
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i] / magnitude;
    }
  }

  console.error(`Generated embedding with ${vector.length} dimensions`);
  return vector;
}

// ---------- HELPER: CHUNK TEXT ----------
/**
 * Splits text into paragraphs first, then ensures each chunk is ~<= 6000 chars.
 * If a paragraph is over 6000 chars, further split by sentences or smaller fragments.
 */
function chunkTextTo6000Chars(rawText: string): string[] {
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

// ---------- HELPER: CLEAN TEXT FROM HTML ----------
function extractTextFromHTML(html: string): string {
  const $ = cheerio.load(html);

  // Remove script and style tags
  $("script, style").remove();

  // Get text from body
  const text = $("body").text() || "";
  // Clean up whitespace
  return text.replace(/\s+/g, " ").trim();
}

// ---------- HELPER: BFS-CRAWL (Depth=2) ----------
async function bfsCrawl(baseUrl: string, forceRecrawl: boolean): Promise<void> {
  // Example: baseUrl = "https://example.com/docs"
  // Slug for storing data on disk & naming the Qdrant collection
  const baseUrlSlug = baseUrl
    .replace(/https?:\/\//, "")
    .replace(/[^\w\d]+/g, "_") // make it a safe folder/collection name
    .toLowerCase();

  // Data folder: e.g. ./data/example_com_docs
  const dataFolder = path.join("./data", baseUrlSlug);

  // Additional folder in user's home directory
  const homeDir = os.homedir();
  const homeCrawlFolder = path.join(homeDir, "crawled-docs", baseUrlSlug);

  // If forceRecrawl => remove existing data & re-crawl
  if (forceRecrawl) {
    if (fs.existsSync(dataFolder)) {
      fs.rmSync(dataFolder, { recursive: true, force: true });
    }
    if (fs.existsSync(homeCrawlFolder)) {
      fs.rmSync(homeCrawlFolder, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(dataFolder)) {
    fs.mkdirSync(dataFolder, { recursive: true });
  }

  // Ensure the home directory crawl folder exists
  if (!fs.existsSync(path.join(homeDir, "crawled-docs"))) {
    fs.mkdirSync(path.join(homeDir, "crawled-docs"), { recursive: true });
  }
  if (!fs.existsSync(homeCrawlFolder)) {
    fs.mkdirSync(homeCrawlFolder, { recursive: true });
  }

  // Prepare a Qdrant collection for this baseUrl
  const VECTOR_SIZE = 384; // matches our MiniLM embedding dimension size
  await ensureCollectionExists(baseUrlSlug, VECTOR_SIZE);

  // BFS in memory structures
  const toVisit: Array<{ url: string; depth: number }> = [
    { url: baseUrl, depth: 1 },
  ];
  const visited = new Set<string>();

  while (toVisit.length > 0) {
    const { url, depth } = toVisit.shift()!;
    if (visited.has(url)) {
      continue;
    }
    visited.add(url);

    // Fetch page
    console.error(`Crawling: ${url} (depth=${depth})...`);
    let resp;
    try {
      resp = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!resp.ok) {
        console.error(`Failed to fetch (${resp.status}): ${url}`);
        console.error(`Status text: ${resp.statusText}`);
        continue;
      }
    } catch (err) {
      console.error(`Error fetching ${url}:`, err);
      continue;
    }

    const html = await resp.text();
    const textContent = extractTextFromHTML(html);
    const linksFound: string[] = [];

    // We only want links that share the same baseUrl domain or are relative
    if (depth === 1) {
      const $ = cheerio.load(html);
      $("a[href]").each((_i, el) => {
        const href = $(el).attr("href");
        if (!href) return;

        // Check if it's internal or same domain
        if (href.startsWith("http")) {
          if (href.startsWith(baseUrl)) {
            // same domain
            linksFound.push(href);
          }
        } else if (href.startsWith("/")) {
          // relative link
          const fullLink = baseUrl.replace(/\/+$/, "") + href; // e.g. "https://example.com/docs" + "/subpage"
          linksFound.push(fullLink);
        }
      });
    }

    // For BFS, if we are in depth=1, we add discovered links as depth=2
    // (No deeper than 2).
    if (depth === 1) {
      for (const link of linksFound) {
        if (!visited.has(link)) {
          toVisit.push({ url: link, depth: 2 });
        }
      }
    }

    // Now chunk the text, store to disk as JSON, store vectors in Qdrant
    if (textContent.trim().length === 0) {
      console.error(`No textual content found at ${url}`);
      continue;
    }

    const chunks = chunkTextTo6000Chars(textContent);
    const pageData = chunks.map((chunk) => ({
      chunk,
      metadata: {
        pageUrl: url,
        linksFound,
      },
    }));

    // Write out JSON
    // file name = slug of page url
    const fileSlug = url
      .replace(/https?:\/\//, "")
      .replace(/[^\w\d]+/g, "_")
      .toLowerCase();

    // Write to data folder
    const filePath = path.join(dataFolder, fileSlug + ".json");
    fs.writeFileSync(filePath, JSON.stringify(pageData, null, 2), "utf-8");

    // Also write to home directory crawl folder
    const homeFilePath = path.join(homeCrawlFolder, fileSlug + ".json");
    fs.writeFileSync(homeFilePath, JSON.stringify(pageData, null, 2), "utf-8");

    // Create an array of points with properly awaited embeddings
    console.error(`Creating embeddings for ${chunks.length} chunks...`);

    // Process in smaller batches to avoid memory issues
    const BATCH_SIZE = 5;
    let batchCounter = 0;

    for (
      let batchStart = 0;
      batchStart < pageData.length;
      batchStart += BATCH_SIZE
    ) {
      batchCounter++;
      console.error(`Processing batch ${batchCounter}...`);

      const batchItems = pageData.slice(batchStart, batchStart + BATCH_SIZE);
      const points: PointStruct[] = [];

      // Generate embeddings for this batch
      for (const item of batchItems) {
        try {
          // Generate embedding directly from the chunk
          const vector = embedText(item.chunk);
          console.error(
            `Generated vector with ${vector.length} dimensions for chunk of ${item.chunk.length} chars`
          );

          points.push({
            vector,
            payload: {
              pageUrl: item.metadata.pageUrl,
              chunk: item.chunk,
            },
          });
        } catch (error) {
          console.error(`Error embedding chunk: ${error}`);
        }
      }

      if (points.length === 0) {
        console.error(`No valid points in batch ${batchCounter}, skipping...`);
        continue;
      }

      console.error(`Upserting ${points.length} points to Qdrant...`);

      try {
        // Prepare array of IDs - make sure they're globally unique across all batches
        const ids = points.map((_, idx) => `${fileSlug}-${batchStart + idx}`);
        const vectors = points.map((p) => p.vector);
        const payloads = points.map((p) => p.payload);

        // Batch upsert to Qdrant
        const result = await qdrantClient.upsert(baseUrlSlug, {
          wait: true,
          batch: {
            ids,
            vectors,
            payloads,
          },
        });

        console.error(`Batch ${batchCounter} upsert result:`, result);
      } catch (err) {
        console.error(`Error upserting batch ${batchCounter} to Qdrant:`, err);
        if (err instanceof Error) {
          console.error(`Error name: ${err.name}`);
          console.error(`Error message: ${err.message}`);
          console.error(`Error stack: ${err.stack}`);
        }
      }
    }

    console.error(`Stored ${chunks.length} chunks from ${url}`);
  }

  console.error(`Crawling complete for ${baseUrl}. Data folders: 
  - ${dataFolder}
  - ${homeCrawlFolder}`);
}

// ---------- HELPER: SEARCH ----------
async function searchInQdrant(
  baseUrl: string,
  query: string,
  topK: number
): Promise<any[]> {
  // Collection name
  const baseUrlSlug = baseUrl
    .replace(/https?:\/\//, "")
    .replace(/[^\w\d]+/g, "_")
    .toLowerCase();

  console.error(
    `Searching for query: "${query}" in collection "${baseUrlSlug}"`
  );

  // Try vector search first
  try {
    // Create embedding for the query
    const queryVector = embedText(query);
    console.error(
      `Generated query vector with ${queryVector.length} dimensions`
    );

    // Check if the collection exists and get its info
    try {
      const collectionInfo = await qdrantClient.getCollection(baseUrlSlug);
      console.error(`Collection info: ${JSON.stringify(collectionInfo)}`);
    } catch (err) {
      console.error(`Error getting collection info: ${err}`);
    }

    // Search with vector
    const searchResult = await qdrantClient.search(baseUrlSlug, {
      vector: queryVector,
      limit: topK,
    });

    // Log search results
    console.error(`Vector search returned ${searchResult.length} results`);

    // If we got results, return them
    if (searchResult && searchResult.length > 0) {
      // Return array of { chunk, pageUrl, score }
      return searchResult.map((res: any) => {
        return {
          chunk: res.payload.chunk,
          pageUrl: res.payload.pageUrl,
          score: res.score,
        };
      });
    }
  } catch (err) {
    console.error(`Error during vector search: `, err);
    // Continue to fallback
  }

  // If vector search failed or returned no results, try fallback text search
  console.error(
    `Vector search failed or returned no results, trying fallback text search`
  );

  try {
    // Read from the data folder directly
    const dataFolder = path.join("./data", baseUrlSlug);
    if (!fs.existsSync(dataFolder)) {
      console.error(`Data folder ${dataFolder} doesn't exist`);
      return [];
    }

    // Get all JSON files in the data folder
    const files = fs.readdirSync(dataFolder).filter((f) => f.endsWith(".json"));
    console.error(`Found ${files.length} data files to search`);

    // Normalize the query for better matching
    const queryTerms = query.toLowerCase().split(/\s+/);

    // Keep track of matches
    const matches: Array<{
      chunk: string;
      pageUrl: string;
      score: number;
    }> = [];

    // Search each file
    for (const file of files) {
      const filePath = path.join(dataFolder, file);
      const content = fs.readFileSync(filePath, "utf8");
      const data = JSON.parse(content);

      // For each chunk in the file
      for (const item of data) {
        const chunk = item.chunk;
        const chunkLower = chunk.toLowerCase();

        // Calculate a simple match score based on term frequency
        let score = 0;
        for (const term of queryTerms) {
          // Count occurrences of the term
          const regex = new RegExp(term, "gi");
          const matches = chunkLower.match(regex);
          if (matches) {
            score += matches.length;
          }
        }

        // If we found any matches, add to results
        if (score > 0) {
          matches.push({
            chunk: chunk,
            pageUrl: item.metadata.pageUrl,
            score: (score / chunk.length) * 100, // Normalize by length and scale
          });
        }
      }
    }

    // Sort by score descending and return top K
    console.error(`Text search found ${matches.length} results`);
    return matches.sort((a, b) => b.score - a.score).slice(0, topK);
  } catch (err) {
    console.error(`Error during fallback text search: `, err);
    return [];
  }
}

// ---------- MCP SERVER SETUP ----------
import { z } from "zod";

// Create MCP server
const server = new McpServer({
  name: "docs-crawler",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// ---------- TOOL #1: crawl a docs website ----------
server.tool(
  "crawl-docs-website",
  "Crawl a documentation website up to depth=2, store chunks in local Qdrant & disk",
  {
    baseUrl: z.string().describe("Base URL of the docs website to crawl"),
    forceRecrawl: z
      .boolean()
      .default(false)
      .describe("If true, remove old data first and re-crawl"),
  },
  async ({ baseUrl, forceRecrawl }) => {
    try {
      console.error(`Starting crawl for ${baseUrl}...`);
      await bfsCrawl(baseUrl, forceRecrawl);
      console.error(`Completed crawl for ${baseUrl}.`);
      return {
        content: [
          {
            type: "text",
            text: `Crawl complete for ${baseUrl}.`,
          },
        ],
      };
    } catch (err: any) {
      console.error(`Error in crawl-docs-website:`, err);
      return {
        content: [
          {
            type: "text",
            text: `Error crawling ${baseUrl}: ${err.message || "Unknown error"}
            Stack trace: ${err.stack || "No stack trace available"}`,
          },
        ],
      };
    }
  }
);

// ---------- TOOL #2: search docs ----------
server.tool(
  "search-docs",
  "Search the previously crawled docs for relevant chunks. Please use different queries relateded to the current conversation to find what you are looking for. Do at least 3 queries",
  {
    baseUrl: z
      .string()
      .describe("Base URL of the docs website that was crawled"),
    queries: z
      .array(z.string())
      .describe("Array of query strings to search for"),
  },
  async ({ baseUrl, queries }) => {
    // We fetch top 3 results per query
    const topK = 3;

    // Check if we have a data folder for that baseUrl
    const baseUrlSlug = baseUrl
      .replace(/https?:\/\//, "")
      .replace(/[^\w\d]+/g, "_")
      .toLowerCase();
    const dataFolder = path.join("./data", baseUrlSlug);

    if (!fs.existsSync(dataFolder)) {
      return {
        content: [
          {
            type: "text",
            text: `It appears no crawl data exists for ${baseUrl}. Please run the 'crawl-docs-website' tool first.`,
          },
        ],
      };
    }

    let responseText = "";
    for (const query of queries) {
      const results = await searchInQdrant(baseUrl, query, topK);
      responseText += `\nQuery: ${query}\n`;

      if (!results || results.length === 0) {
        responseText += `No results found.\n`;
      } else {
        for (const r of results) {
          responseText += `\nScore: ${r.score}\nURL: ${r.pageUrl}\nChunk:\n${r.chunk}\n---\n`;
        }
      }

      responseText += "\n";
    }

    return {
      content: [
        {
          type: "text",
          text: responseText.trim(),
        },
      ],
    };
  }
);

// ---------- MAIN ----------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Docs Crawler MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
