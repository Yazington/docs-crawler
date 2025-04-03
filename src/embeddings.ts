// src/embeddings.ts

// Use a fixed vector size that matches what we created our Qdrant collection with
export const VECTOR_SIZE = 384;

/**
 * Creates basic embeddings using a very simple TF-IDF approach
 * This is a simplified version that creates a fixed-size vector based on word frequencies
 */
export function embedText(text: string): number[] {
  const vector = new Array(VECTOR_SIZE).fill(0);

  // Normalize and clean the text
  const processedText = text
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // Remove punctuation
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();

  // Get all words
  const words = processedText.split(" ");
  if (words.length === 0) {
    // Return a random vector if text is empty to avoid zero vectors
    return Array.from({ length: VECTOR_SIZE }, () => Math.random());
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
    const index = Math.abs(hash) % VECTOR_SIZE;

    // Add frequency to vector at this position
    vector[index] += freq;
  }

  // Normalize the vector (L2 norm) to make magnitudes comparable
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i] / magnitude;
    }
  } else {
    // Handle zero vector case - return a random vector
    console.error("Generated a zero vector, returning random vector instead.");
    return Array.from({ length: VECTOR_SIZE }, () => Math.random());
  }

  console.error(`Generated embedding with ${vector.length} dimensions`);
  return vector;
}
