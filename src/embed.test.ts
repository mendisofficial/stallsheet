import assert from "node:assert/strict";
import test from "node:test";
import { embedText, EMBEDDING_DIMS } from "./embed.js";

test("embeddings are normalized and share tokens", () => {
  const rain = embedText("rainy saturday cinnamon buns sold poorly");
  const alsoRain = embedText("rain and cinnamon buns");
  const sun = embedText("sunny festival lemon tart wedding");

  assert.equal(rain.length, EMBEDDING_DIMS);
  const norm = Math.sqrt(rain.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6);

  const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  assert.ok(dot(rain, alsoRain) > dot(rain, sun));
});
