// src/embeddings.ts
import { pipeline, env } from "@xenova/transformers";

// Set environment variables for Transformers.js
env.cacheDir = "./embeddings-cache";
env.allowLocalModels = true;

// Use MiniLM model with 384 dimensions
// This will be automatically downloaded the first time the server runs
export const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
export const VECTOR_SIZE = 384; // Matches the embeddings from the MiniLM model

// Store the pipeline instance to avoid reloading the model on each embedding call
let embeddingPipeline: any = null;

/**
 * Gets or initializes the embedding pipeline
 */
async function getEmbeddingPipeline() {
  if (!embeddingPipeline) {
    console.error(`Loading embedding model: ${MODEL_NAME}`);
    try {
      embeddingPipeline = await pipeline("feature-extraction", MODEL_NAME);
      console.error("Embedding model loaded successfully");
    } catch (error) {
      console.error("Error loading embedding model:", error);
      throw error;
    }
  }
  return embeddingPipeline;
}

/**
 * Creates text embeddings using a transformer-based model
 * @param text The text to create embeddings for
 * @returns A promise that resolves to an array of embedding values
 */
export async function embedText(text: string): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    console.error("Empty text provided for embedding, returning random vector");
    return Array.from({ length: VECTOR_SIZE }, () => Math.random() * 0.01);
  }

  try {
    // Clean and truncate the text for the model
    const processedText = text
      .replace(/\s+/g, " ") // Normalize whitespace
      .trim();

    // Most models have a token limit, so we'll truncate long texts
    // This is a simplified approach - a better one would be semantic chunking
    const maxChars = 8192; // Rough approximation of token limit for small models
    const truncatedText =
      processedText.length > maxChars
        ? processedText.substring(0, maxChars)
        : processedText;

    // Get the embedding pipeline
    const pipe = await getEmbeddingPipeline();

    // Generate embeddings
    const result = await pipe(truncatedText, {
      pooling: "mean", // Mean pooling for sentence embeddings
      normalize: true, // L2 normalize the outputs
    });

    // Extract the vector from the output and ensure it's a number array
    const vector = Array.from(result.data) as number[];

    console.error(`Generated embedding with ${vector.length} dimensions`);

    return vector;
  } catch (error) {
    console.error(`Error generating embeddings: ${error}`);
    // Fallback to random vector in case of error
    return Array.from({ length: VECTOR_SIZE }, () => Math.random() * 0.01);
  }
}

// Cache for embeddings to avoid recalculating
const embeddingCache = new Map<string, number[]>();

/**
 * Simple hashing function for text
 */
function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString();
}

/**
 * Generate a deterministic but unique vector for text based on its content
 * Not as good as ML-based embeddings, but better than identical placeholders
 */
function generateDeterministicVector(text: string): number[] {
  // Create a seed based on text content
  const seed = simpleHash(text);
  const seedNum = parseInt(seed);

  // Use the seed to generate a deterministic but unique vector
  const vector = new Array(VECTOR_SIZE);

  // Simple pseudo-random number generator with the seed
  let value = seedNum;

  for (let i = 0; i < VECTOR_SIZE; i++) {
    // Generate next pseudo-random value
    value = (value * 9301 + 49297) % 233280;
    // Convert to a value between -1 and 1
    vector[i] = (value / 233280) * 2 - 1;
  }

  // Normalize the vector to unit length
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return vector.map((val) => val / magnitude);
}

/**
 * Synchronous wrapper that provides deterministic embeddings
 * This is a temporary solution until we can properly implement async embeddings
 */
export function embedTextSync(text: string): number[] {
  // Check if we've already calculated this embedding
  const cacheKey = text.slice(0, 100); // Use first 100 chars as cache key

  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey)!;
  }

  console.error(
    "Warning: Using synchronous embedding function with async backend"
  );

  // Generate a deterministic but unique vector based on the text content
  const vector = generateDeterministicVector(text);

  // Cache the result
  embeddingCache.set(cacheKey, vector);

  // Also start the async embedding process in the background for future use
  embedText(text)
    .then((asyncVector) => {
      // Update the cache with the proper embedding when it's done
      embeddingCache.set(cacheKey, asyncVector);
    })
    .catch((error) => {
      console.error("Error in async embedding:", error);
    });

  return vector;
}
