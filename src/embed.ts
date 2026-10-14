const DIMS = 64;

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/** Hashed bag-of-words embedding. Sales notes stay in Postgres; nothing is sent to an embedding API. */
export function embedText(text: string): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);

  for (const token of tokens) {
    const hashed = hashToken(token);
    const index = Math.abs(hashed) % DIMS;
    const sign = (hashed & 1) === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => value.toFixed(6)).join(",")}]`;
}

export const EMBEDDING_DIMS = DIMS;
