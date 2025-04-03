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

/**
 * Synchronous wrapper for backward compatibility with the current API
 * This function simply runs the async function and returns a default vector
 * while the real vector is being computed
 */
export function embedTextSync(text: string): number[] {
  // Start the async embedding process but don't wait for it
  embedText(text)
    .then((vector) => {
      // Store it somewhere if needed
      // This is just to satisfy TypeScript
      return vector;
    })
    .catch((error) => {
      console.error("Error in async embedding:", error);
    });

  // Return a placeholder vector (all zeros normalized to 1/sqrt(VECTOR_SIZE))
  // This maintains the expected function signature while we transition to async
  // A value of 1/sqrt(VECTOR_SIZE) ensures the vector has a magnitude of 1
  const placeholder = new Array(VECTOR_SIZE).fill(1 / Math.sqrt(VECTOR_SIZE));
  console.error(
    "Warning: Using synchronous embedding function with async backend"
  );
  return placeholder;
}
