// src/server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

import { bfsCrawl } from "./crawler.js";
import { searchInQdrant } from "./qdrant.js";

// Create MCP server instance
const server = new McpServer({
  name: "docs-crawler",
  version: "1.0.0",
  capabilities: {
    resources: {}, // No resources defined in this version
    tools: {}, // Tools will be added below
  },
});

// ---------- TOOL #1: crawl-docs-website ----------
server.tool(
  "crawl-docs-website",
  "Crawl a documentation website up to depth=2, store chunks in local Qdrant & disk",
  {
    baseUrl: z.string().url().describe("Base URL of the docs website to crawl"), // Added .url() validation
    forceRecrawl: z
      .boolean()
      .default(false)
      .describe("If true, remove old data first and re-crawl"),
  },
  async (params) => {
    // Type assertion is less safe, prefer schema validation if possible,
    // but Zod handles the parsing and type checking here.
    const baseUrl = params.baseUrl as string;
    const forceRecrawl = params.forceRecrawl as boolean;

    try {
      console.error(`Starting crawl for ${baseUrl}...`);
      // Call the imported crawl function
      await bfsCrawl(baseUrl, forceRecrawl);
      console.error(`Completed crawl for ${baseUrl}.`);
      return {
        content: [
          {
            type: "text",
            text: `Crawl complete for ${baseUrl}. Data stored locally and in Qdrant.`,
          },
        ],
      };
    } catch (err: any) {
      console.error(`Error in crawl-docs-website tool execution:`, err);
      // Provide a more structured error response
      return {
        isError: true, // Indicate that this is an error response
        content: [
          {
            type: "text",
            text: `Error crawling ${baseUrl}: ${
              err.message || "Unknown error"
            }\nStack trace: ${err.stack || "No stack trace available"}`,
          },
        ],
      };
    }
  }
);

// ---------- TOOL #2: search-docs ----------
server.tool(
  "search-docs",
  "Search the previously crawled docs for relevant chunks",
  {
    baseUrl: z
      .string()
      .url() // Added .url() validation
      .describe("Base URL of the docs website that was crawled"),
    queries: z
      .array(z.string().min(1)) // Ensure queries are not empty strings
      .min(1) // Ensure at least one query is provided
      .describe("Array of query strings to search for"),
  },
  async (params) => {
    const baseUrl = params.baseUrl as string;
    const queries = params.queries as string[];
    const topK = 7; // Number of results per query

    // Check if data exists *before* attempting search
    const baseUrlSlug = baseUrl
      .replace(/https?:\/\//, "")
      .replace(/[^\w\d]+/g, "_")
      .toLowerCase();
    const dataFolder = path.join("./data", baseUrlSlug);

    if (!fs.existsSync(dataFolder)) {
      console.warn(
        `No crawl data found locally for ${baseUrl} at ${dataFolder}. Search might yield limited or no results if Qdrant is also empty.`
      );
      // Consider returning an error or warning immediately
      // return {
      //   isError: true,
      //   content: [{ type: "text", text: `No crawl data exists for ${baseUrl}. Please run 'crawl-docs-website' first.` }],
      // };
      // For now, let searchInQdrant handle potential Qdrant emptiness or fallback
    }

    let responseText = `Search Results for ${baseUrl}:\n=================================\n`;
    try {
      for (const query of queries) {
        responseText += `\n--- Query: "${query}" ---\n`;
        // Call the imported search function
        const results = await searchInQdrant(baseUrl, query, topK);

        if (!results || results.length === 0) {
          responseText += `No results found.\n`;
        } else {
          results.forEach((r, index) => {
            responseText += `\nResult ${index + 1}:\n`;
            responseText += `  Score: ${r.score?.toFixed(4) ?? "N/A"}\n`; // Format score
            responseText += `  URL: ${r.pageUrl ?? "N/A"}\n`;
            responseText += `  Chunk:\n    ${(r.chunk ?? "N/A")
              .split("\n")
              .join("\n    ")}\n`; // Indent chunk
            responseText += `---\n`;
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: responseText.trim(),
          },
        ],
      };
    } catch (err: any) {
      console.error(`Error in search-docs tool execution:`, err);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error searching in ${baseUrl}: ${
              err.message || "Unknown error"
            }\nStack trace: ${err.stack || "No stack trace available"}`,
          },
        ],
      };
    }
  }
);

// ---------- Main Function to Start Server ----------
export async function main() {
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
    console.error("Docs Crawler MCP Server running on stdio");
  } catch (error) {
    console.error("Failed to connect or start MCP server:", error);
    process.exit(1); // Exit if server fails to start
  }

  // Graceful shutdown handling
  process.on("SIGINT", async () => {
    console.log("Received SIGINT, shutting down server...");
    await server.close();
    console.log("Server closed.");
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("Received SIGTERM, shutting down server...");
    await server.close();
    console.log("Server closed.");
    process.exit(0);
  });
}
