import type { SaleRow } from "./csv.js";

type Profile = {
  item: string;
  price: number;
  made: number;
  sunny: number;
  cloudy: number;
  rain: number;
  festivalBoost?: number;
};

const profiles: Profile[] = [
  { item: "Sourdough loaf", price: 8, made: 20, sunny: 0.9, cloudy: 0.75, rain: 0.55 },
  { item: "Cinnamon buns", price: 5, made: 30, sunny: 0.92, cloudy: 0.8, rain: 0.5 },
  { item: "Lemon tart", price: 6, made: 16, sunny: 0.7, cloudy: 0.65, rain: 0.4, festivalBoost: 0.22 },
  { item: "Brown butter cookie", price: 3, made: 40, sunny: 0.85, cloudy: 0.8, rain: 0.45 },
  { item: "Weekend quiche", price: 9, made: 12, sunny: 0.6, cloudy: 0.72, rain: 0.88 },
];

const weathers = [
  "sunny",
  "sunny",
  "cloudy",
  "rain",
  "sunny",
  "cloudy",
  "sunny",
  "rain",
  "sunny",
  "cloudy",
  "sunny",
  "rain",
] as const;

/** Twelve Saturdays for the fictional Hearth & Rye stall. */
export function demoSales(): SaleRow[] {
  const rows: SaleRow[] = [];
  const start = new Date("2026-07-04T00:00:00Z");
  for (let week = 0; week < 12; week += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + week * 7);
    const weekend = day.toISOString().slice(0, 10);
    const weather = weathers[week];
    const festival = week === 5;
    const wedding = week === 9;
    const notes = festival
      ? "farm festival nearby"
      : wedding
        ? "wedding order asked for extra lemon tarts"
        : "regular saturday";
    for (const profile of profiles) {
      const premium = week % 4 === 0;
      const price = profile.price + (premium ? 1 : 0);
      const rate = profile[weather] * (premium ? 0.8 : 1);
      const boost = (festival || wedding) && profile.festivalBoost ? profile.festivalBoost : 0;
      const wobble = 0.94 + (week % 3) * 0.03;
      const qtySold = Math.min(
        profile.made,
        Math.max(0, Math.round(profile.made * (rate + boost) * wobble)),
      );
      rows.push({
        weekend,
        item: profile.item,
        priceCents: price * 100,
        qtyMade: profile.made,
        qtySold,
        weather,
        notes,
      });
    }
  }
  return rows;
}

export function demoSalesCsv(): string {
  const header = "weekend,item,price,qty_made,qty_sold,weather,notes";
  const lines = demoSales().map(
    (row) =>
      `${row.weekend},${row.item},${(row.priceCents / 100).toFixed(2)},${row.qtyMade},${row.qtySold},${row.weather},${row.notes}`,
  );
  return [header, ...lines].join("\n") + "\n";
}

export const DEMO_MARKET_ID = "hearth-and-rye";
