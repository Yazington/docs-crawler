// src/qdrant.ts

import { QdrantClient } from "@qdrant/js-client-rest";
import * as fs from "fs";
import * as path from "path";
import { embedText, embedTextSync, VECTOR_SIZE } from "./embeddings.js"; // Added embedTextSync

// Define our own type for vector points since the library doesn't export it
export interface PointStruct {
  id: string | number; // Qdrant requires string IDs or unsigned integers
  vector: number[];
  payload: {
    pageUrl: string;
    chunk: string;
    [key: string]: any;
  };
}

// Define the structure for page data items used in upsert
interface PageDataItem {
  chunk: string;
  metadata: {
    pageUrl: string;
    linksFound: string[]; // Assuming this is part of metadata
  };
}

export const qdrantClient = new QdrantClient({
  // Added export keyword
  url: process.env.QDRANT_URL || "http://localhost:6333", // Allow overriding via env var
});

/**
 * Ensures a Qdrant collection exists with the specified vector size.
 */
export async function ensureCollectionExists(
  collectionName: string,
  vectorSize: number
): Promise<void> {
  try {
    const existingCollections = await qdrantClient.getCollections();
    const exists = existingCollections.collections?.some(
      (c: { name: string }) => c.name === collectionName
    );

    if (!exists) {
      console.error(`Collection "${collectionName}" not found. Creating...`);
      await qdrantClient.createCollection(collectionName, {
        vectors: {
          size: vectorSize,
          distance: "Cosine", // Or another distance metric like "Euclid" or "Dot"
        },
      });
      console.error(`Collection "${collectionName}" created successfully.`);
    } else {
      console.error(`Collection "${collectionName}" already exists.`);
    }
  } catch (error) {
    console.error(
      `Error ensuring collection "${collectionName}" exists:`,
      error
    );
    // Decide if we should throw or handle differently
    throw error; // Re-throw for now
  }
}

/**
 * Upserts chunks of data into a specified Qdrant collection.
 * Handles embedding and batching.
 */
export async function upsertChunksToQdrant(
  collectionName: string,
  fileSlug: string,
  pageData: PageDataItem[]
): Promise<void> {
  console.error(
    `Upserting ${pageData.length} chunks for ${fileSlug} into collection ${collectionName}...`
  );

  const BATCH_SIZE = 50; // Increased batch size for potentially better performance
  let batchCounter = 0;

  for (
    let batchStart = 0;
    batchStart < pageData.length;
    batchStart += BATCH_SIZE
  ) {
    batchCounter++;
    console.error(
      `Processing batch ${batchCounter} (items ${batchStart + 1}-${Math.min(
        batchStart + BATCH_SIZE,
        pageData.length
      )})...`
    );

    const batchItems = pageData.slice(batchStart, batchStart + BATCH_SIZE);
    const points: PointStruct[] = [];

    // Generate embeddings and prepare points for this batch
    for (let i = 0; i < batchItems.length; i++) {
      const item = batchItems[i];
      try {
        // Use the synchronous wrapper for now to maintain compatibility
        const vector = embedTextSync(item.chunk);
        console.error(
          `Generated vector with ${vector.length} dimensions for chunk ${
            batchStart + i
          } of ${item.chunk.length} chars`
        );

        points.push({
          id: batchStart + i, // Use numeric ID instead of string ID
          vector,
          payload: {
            pageUrl: item.metadata.pageUrl,
            chunk: item.chunk,
            fileSlug, // Store the fileSlug in the payload for reference
            // Add other metadata if needed
          },
        });
      } catch (error) {
        console.error(
          `Error embedding chunk ${batchStart + i} for ${fileSlug}: ${error}`
        );
        // Optionally skip this chunk or handle error differently
      }
    }

    if (points.length === 0) {
      console.error(
        `No valid points generated in batch ${batchCounter}, skipping upsert...`
      );
      continue;
    }

    console.error(
      `Upserting ${points.length} points to Qdrant collection "${collectionName}"...`
    );

    try {
      // Batch upsert to Qdrant
      const result = await qdrantClient.upsert(collectionName, {
        wait: true, // Wait for the operation to complete
        batch: {
          ids: points.map((p) => p.id),
          vectors: points.map((p) => p.vector),
          payloads: points.map((p) => p.payload),
        },
      });

      console.error(
        `Batch ${batchCounter} upsert result: ${JSON.stringify(result)}`
      );
    } catch (err) {
      console.error(
        `Error upserting batch ${batchCounter} to Qdrant collection "${collectionName}":`,
        err
      );
      // Log detailed error information if available
      if (err instanceof Error) {
        console.error(`Error name: ${err.name}`);
        console.error(`Error message: ${err.message}`);
        // Avoid logging potentially huge stacks unless necessary
        // console.error(`Error stack: ${err.stack}`);
      }
      // Decide if we should retry, skip, or throw
      // For now, we continue to the next batch
    }
  }
  console.error(`Finished upserting chunks for ${fileSlug}.`);
}

/**
 * Searches for a query within a specified Qdrant collection.
 * Falls back to simple text search if vector search fails or yields no results.
 */
export async function searchInQdrant(
  baseUrl: string, // Keep baseUrl to derive collectionName and dataFolder
  query: string,
  topK: number
): Promise<any[]> {
  // Collection name derived from baseUrl
  const collectionName = baseUrl
    .replace(/https?:\/\//, "")
    .replace(/[^\w\d]+/g, "_")
    .toLowerCase();

  console.error(
    `Searching for query: "${query}" in collection "${collectionName}"`
  );

  // --- Vector Search Attempt ---
  try {
    // Use the synchronous version for now to maintain compatibility
    const queryVector = embedTextSync(query);
    console.error(
      `Generated query vector with ${queryVector.length} dimensions`
    );

    // Verify collection exists before searching (optional but good practice)
    // await ensureCollectionExists(collectionName, VECTOR_SIZE); // EnsureCollection might create it if missing

    const searchResult = await qdrantClient.search(collectionName, {
      vector: queryVector,
      limit: topK,
      // You might want to add `with_payload: true` if not default
      // with_payload: true
    });

    console.error(`Vector search returned ${searchResult.length} results`);

    if (searchResult && searchResult.length > 0) {
      return searchResult.map((res: any) => ({
        chunk: res.payload?.chunk ?? "Chunk data missing", // Safely access payload
        pageUrl: res.payload?.pageUrl ?? "URL missing",
        score: res.score,
      }));
    }
  } catch (err) {
    console.error(
      `Error during vector search in collection "${collectionName}": `,
      err
    );
    // Log specific Qdrant errors if possible
    if (err instanceof Error && "status" in err) {
      // Example: Check for Qdrant-specific error details
      console.error(`Qdrant error status: ${(err as any).status}`);
      console.error(`Qdrant error details: ${(err as any).details}`);
    }
    // Fall through to text search
  }

  // --- Fallback Text Search ---
  console.error(
    `Vector search failed or returned no results for "${query}" in "${collectionName}", trying fallback text search.`
  );

  try {
    const dataFolder = path.join("./data", collectionName); // Use collectionName which is the slug
    if (!fs.existsSync(dataFolder)) {
      console.error(
        `Data folder ${dataFolder} for fallback search doesn't exist.`
      );
      return [];
    }

    const files = fs.readdirSync(dataFolder).filter((f) => f.endsWith(".json"));
    console.error(`Found ${files.length} data files for fallback search.`);

    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    const matches: Array<{
      chunk: string;
      pageUrl: string;
      score: number;
    }> = [];

    for (const file of files) {
      const filePath = path.join(dataFolder, file);
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const pageDataArray: PageDataItem[] = JSON.parse(content); // Assuming file contains array of PageDataItem

        for (const item of pageDataArray) {
          const chunk = item.chunk;
          const chunkLower = chunk.toLowerCase();
          let score = 0;

          for (const term of queryTerms) {
            const regex = new RegExp(
              term.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"), // Escape regex special chars
              "gi"
            );
            const termMatches = chunkLower.match(regex);
            if (termMatches) {
              score += termMatches.length;
            }
          }

          if (score > 0) {
            matches.push({
              chunk: chunk,
              pageUrl: item.metadata.pageUrl,
              // Simple scoring: term frequency normalized by chunk length (avoid division by zero)
              score: chunk.length > 0 ? (score / chunk.length) * 100 : 0,
            });
          }
        }
      } catch (readErr) {
        console.error(`Error reading or parsing file ${filePath}:`, readErr);
      }
    }

    console.error(
      `Fallback text search found ${matches.length} potential matches.`
    );
    // Sort by score and return top K
    return matches.sort((a, b) => b.score - a.score).slice(0, topK);
  } catch (fallbackErr) {
    console.error(`Error during fallback text search: `, fallbackErr);
    return []; // Return empty if fallback also fails
  }
}
