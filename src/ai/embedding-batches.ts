/**
 * Builds inference batches without allowing a few long transcript passages to create a very large
 * padded tensor. The item limit protects low-memory GPUs; the character budget is a cheap,
 * tokenizer-independent proxy for token count. A single oversized passage is always allowed so
 * callers cannot stall.
 */
export function embeddingBatches<T extends { text: string }>(
  items: readonly T[],
  limits: { maxItems: number; maxCharacters: number } = { maxItems: 4, maxCharacters: 6_000 }
): T[][] {
  if (!Number.isInteger(limits.maxItems) || limits.maxItems < 1) {
    throw new Error("maxItems must be a positive integer.");
  }
  if (!Number.isFinite(limits.maxCharacters) || limits.maxCharacters < 1) {
    throw new Error("maxCharacters must be positive.");
  }

  const batches: T[][] = [];
  let batch: T[] = [];
  let characters = 0;

  for (const item of items) {
    const itemCharacters = item.text.length;
    const wouldOverflow =
      batch.length > 0 &&
      (batch.length >= limits.maxItems || characters + itemCharacters > limits.maxCharacters);
    if (wouldOverflow) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(item);
    characters += itemCharacters;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}
