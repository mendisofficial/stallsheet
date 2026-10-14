import assert from "node:assert/strict";
import test from "node:test";
import { parseSalesCsv } from "./csv.js";

test("parses a sales csv into cents", () => {
  const rows = parseSalesCsv(
    "weekend,item,price,qty_made,qty_sold,weather,notes\n2026-07-04,Sourdough loaf,8.00,20,18,sunny,regular\n",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priceCents, 800);
  assert.equal(rows[0].qtySold, 18);
});
