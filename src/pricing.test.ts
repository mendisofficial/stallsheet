import assert from "node:assert/strict";
import test from "node:test";
import { baselinePredictQty, buildProposals, capFromConstraint } from "./pricing.js";
import type { SaleRow } from "./csv.js";

const sales: SaleRow[] = [
  row("2026-07-04", "Cinnamon buns", 500, 30, 28, "sunny"),
  row("2026-07-11", "Cinnamon buns", 500, 30, 27, "sunny"),
  row("2026-07-18", "Cinnamon buns", 450, 30, 20, "rain"),
  row("2026-07-04", "Lemon tart", 600, 16, 10, "sunny"),
  row("2026-07-11", "Lemon tart", 700, 16, 15, "sunny"),
];

test("picks the price with the higher expected revenue", () => {
  const proposals = buildProposals(sales, "sunny", (item, priceCents, qtyMade) => {
    if (item !== "Cinnamon buns") return qtyMade * 0.8;
    return priceCents === 500 ? 27 : 18;
  });
  const buns = proposals.find((proposal) => proposal.item === "Cinnamon buns");
  assert.ok(buns);
  assert.equal(buns.priceCents, 500);
  assert.equal(buns.recommendedQty, 27);
});

test("baseline uses the same weather when it has enough rows", () => {
  const predict = baselinePredictQty(sales, "sunny");
  const sunny = predict("Cinnamon buns", 500, 30);
  assert.ok(sunny > 25);
});

test("constraint caps the named item", () => {
  assert.equal(capFromConstraint("Cinnamon buns", "I only have enough butter for 18 cinnamon buns", 30), 18);
  assert.equal(capFromConstraint("Lemon tart", "I only have enough butter for 18 cinnamon buns", 16), 16);
});

function row(
  weekend: string,
  item: string,
  priceCents: number,
  qtyMade: number,
  qtySold: number,
  weather: string,
): SaleRow {
  return { weekend, item, priceCents, qtyMade, qtySold, weather, notes: "" };
}
