import assert from "node:assert/strict";
import test from "node:test";
import { stripPrices } from "./gemma.js";

test("currency amounts are removed from model captions", () => {
  assert.equal(stripPrices("Buns are $5.00 today and tarts $6"), "Buns are today and tarts");
});
