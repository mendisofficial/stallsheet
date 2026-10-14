import type { SaleRow } from "./csv.js";

export type CandidateForecast = {
  priceCents: number;
  expectedQty: number;
  expectedRevenueCents: number;
};

export type ItemProposal = {
  item: string;
  recommendedQty: number;
  priceCents: number;
  lowCents: number;
  highCents: number;
  expectedQty: number;
  candidates: CandidateForecast[];
};

type PredictQty = (item: string, priceCents: number, qtyMade: number) => number;

export function buildProposals(
  sales: SaleRow[],
  weather: string,
  predictQty: PredictQty,
): ItemProposal[] {
  const items = [...new Set(sales.map((sale) => sale.item))];
  return items.map((item) => {
    const history = sales.filter((sale) => sale.item === item);
    const qtyMade = median(history.map((sale) => sale.qtyMade));
    const prices = uniquePrices(history.map((sale) => sale.priceCents));
    const candidates = prices.map((priceCents) => {
      const expectedQty = clamp(predictQty(item, priceCents, qtyMade), 0, qtyMade);
      return {
        priceCents,
        expectedQty: round1(expectedQty),
        expectedRevenueCents: Math.round(expectedQty * priceCents),
      };
    });
    const best = candidates.reduce((winner, candidate) =>
      candidate.expectedRevenueCents > winner.expectedRevenueCents ? candidate : winner,
    );
    const near = candidates.filter(
      (candidate) => candidate.expectedRevenueCents >= best.expectedRevenueCents * 0.85,
    );
    const lowCents = Math.min(...near.map((candidate) => candidate.priceCents));
    const highCents = Math.max(...near.map((candidate) => candidate.priceCents));
    return {
      item,
      recommendedQty: Math.max(1, Math.round(best.expectedQty)),
      priceCents: best.priceCents,
      lowCents,
      highCents,
      expectedQty: best.expectedQty,
      candidates,
    };
  });
}

/** Local stand-in used only when TabPFN is not configured or the API call fails. */
export function baselinePredictQty(sales: SaleRow[], weather: string): PredictQty {
  return (item, priceCents, qtyMade) => {
    const history = sales.filter((sale) => sale.item === item);
    const sameWeather = history.filter((sale) => sale.weather === weather);
    const pool = sameWeather.length >= 2 ? sameWeather : history;
    const samePrice = pool.filter((sale) => sale.priceCents === priceCents);
    const chosen = samePrice.length > 0 ? samePrice : pool;
    const ratio =
      chosen.reduce((sum, sale) => sum + sale.qtySold / Math.max(sale.qtyMade, 1), 0) /
      chosen.length;
    return qtyMade * ratio;
  };
}

export function capFromConstraint(item: string, constraint: string, qty: number): number {
  if (!constraint.trim()) return qty;
  const haystack = constraint.toLowerCase();
  const needle = item.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at === -1) return qty;
  const window = haystack.slice(Math.max(0, at - 40), at + needle.length + 40);
  if (!/\b(only|enough|max|limit|left)\b/.test(window)) return qty;
  const match = window.match(/\d+/);
  if (!match) return qty;
  return Math.min(qty, Number(match[0]));
}

function uniquePrices(prices: number[]): number[] {
  const sorted = [...new Set(prices)].sort((a, b) => a - b);
  if (sorted.length >= 2) return sorted;
  const only = sorted[0] ?? 0;
  return [Math.max(100, only - 50), only, only + 50];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return sorted[mid];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
