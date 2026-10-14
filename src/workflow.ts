import { mkdir } from "node:fs/promises";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { money } from "./config.js";
import { listSales, hybridSearch, saveSheetOnce } from "./db.js";
import { writeCopy } from "./gemma.js";
import { baselinePredictQty, buildProposals, capFromConstraint } from "./pricing.js";
import { searchCityEvents } from "./serpapi.js";
import { tabpfnQuantities } from "./tabpfn.js";

const similarSchema = z.object({
  weekend: z.string(),
  weather: z.string(),
  notes: z.string(),
  score: z.number(),
  highlight: z.string(),
});

const eventSchema = z.object({
  title: z.string(),
  date: z.string(),
  venue: z.string(),
});

const requestSchema = z.object({
  runId: z.string(),
  marketId: z.string(),
  city: z.string(),
  weekend: z.string(),
  weather: z.enum(["sunny", "cloudy", "rain"]),
  constraint: z.string(),
});

const contextSchema = requestSchema.extend({
  salesCount: z.number(),
  similar: z.array(similarSchema),
  events: z.array(eventSchema),
  eventNote: z.string(),
});

const proposalSchema = z.object({
  item: z.string(),
  recommendedQty: z.number(),
  priceCents: z.number(),
  lowCents: z.number(),
  highCents: z.number(),
  expectedQty: z.number(),
});

const forecastSchema = contextSchema.extend({
  source: z.enum(["tabpfn", "baseline"]),
  predictionNote: z.string(),
  proposals: z.array(proposalSchema),
});

const confirmedSchema = forecastSchema.extend({
  confirmed: z.array(
    z.object({
      item: z.string(),
      qty: z.number(),
      priceCents: z.number(),
    }),
  ),
});

const sheetSchema = z.object({
  runId: z.string(),
  marketId: z.string(),
  city: z.string(),
  weekend: z.string(),
  weather: z.string(),
  constraint: z.string(),
  source: z.enum(["tabpfn", "baseline"]),
  predictionNote: z.string(),
  copySource: z.enum(["gemma", "template"]),
  model: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  prepList: z.array(z.string()),
  caption: z.string(),
  priceTags: z.array(
    z.object({
      item: z.string(),
      qty: z.number(),
      priceCents: z.number(),
      line: z.string(),
    }),
  ),
  similar: z.array(similarSchema),
  events: z.array(eventSchema),
});

const gather = createStep({
  id: "gather-context",
  inputSchema: requestSchema,
  outputSchema: contextSchema,
  execute: async ({ inputData }) => {
    const sales = await listSales(inputData.marketId);
    if (sales.length === 0) {
      throw new Error("No sales history yet. Load the bakery demo or upload a CSV first.");
    }
    const query = [inputData.weather, inputData.city, inputData.constraint, "market stall weekend"]
      .filter(Boolean)
      .join(" ");
    const similar = await hybridSearch(inputData.marketId, query);
    let events: z.infer<typeof eventSchema>[] = [];
    let eventNote = "SerpApi key not set, so no live events were added.";
    try {
      events = await searchCityEvents(inputData.city, inputData.weekend);
      if (events.length > 0) eventNote = `SerpApi returned ${events.length} nearby events.`;
      else if (process.env.SERPAPI_KEY) eventNote = "SerpApi returned no events for this city.";
    } catch (error) {
      eventNote = error instanceof Error ? error.message : "SerpApi lookup failed.";
    }
    return { ...inputData, salesCount: sales.length, similar, events, eventNote };
  },
});

const predict = createStep({
  id: "predict-prices",
  inputSchema: contextSchema,
  outputSchema: forecastSchema,
  execute: async ({ inputData }) => {
    const sales = await listSales(inputData.marketId);
    const items = [...new Set(sales.map((sale) => sale.item))];
    const prices = new Map<string, number[]>();
    for (const sale of sales) {
      const list = prices.get(sale.item) ?? [];
      if (!list.includes(sale.priceCents)) list.push(sale.priceCents);
      prices.set(sale.item, list);
    }

    const trainHeader = "item,price_cents,weather,qty_made,month,festival";
    const xRows = sales.map((sale) => featureRow(sale));
    const yRows = sales.map((sale) => String(sale.qtySold));
    const testRows: { key: string; csv: string }[] = [];
    for (const item of items) {
      const history = sales.filter((sale) => sale.item === item);
      const qtyMade = median(history.map((sale) => sale.qtyMade));
      const candidates = candidatePrices(prices.get(item) ?? []);
      for (const priceCents of candidates) {
        testRows.push({
          key: `${item}|${priceCents}`,
          csv: featureCsv({
            item,
            priceCents,
            weather: inputData.weather,
            qtyMade,
            month: Number(inputData.weekend.slice(5, 7)),
            festival: /festival|wedding|market/i.test(inputData.constraint) ? 1 : 0,
          }),
        });
      }
    }

    let quantities = new Map<string, number>();
    let source: "tabpfn" | "baseline" = "baseline";
    let predictionNote = "Using the weather baseline because TabPFN is not configured.";
    try {
      const forecast = await tabpfnQuantities(
        { x: [trainHeader, ...xRows].join("\n"), y: ["qty_sold", ...yRows].join("\n") },
        testRows,
      );
      if (forecast.source === "tabpfn") {
        quantities = forecast.quantities;
        source = "tabpfn";
        predictionNote = forecast.note;
      } else {
        predictionNote = forecast.note;
      }
    } catch (error) {
      predictionNote = `TabPFN call failed, so the weather baseline was used. ${
        error instanceof Error ? error.message : ""
      }`.trim();
    }

    const predictQty =
      source === "tabpfn"
        ? (item: string, priceCents: number, qtyMade: number) =>
            quantities.get(`${item}|${priceCents}`) ?? qtyMade * 0.5
        : baselinePredictQty(sales, inputData.weather);

    const proposals = buildProposals(sales, inputData.weather, predictQty).map((proposal) => ({
      ...proposal,
      recommendedQty: capFromConstraint(proposal.item, inputData.constraint, proposal.recommendedQty),
      candidates: undefined,
    }));

    return {
      ...inputData,
      source,
      predictionNote,
      proposals: proposals.map(({ candidates: _candidates, ...proposal }) => proposal),
    };
  },
});

const confirm = createStep({
  id: "confirm-quantities",
  inputSchema: forecastSchema,
  outputSchema: confirmedSchema,
  suspendSchema: z.object({
    message: z.string(),
    proposals: z.array(proposalSchema),
    similar: z.array(similarSchema),
    events: z.array(eventSchema),
    source: z.enum(["tabpfn", "baseline"]),
    predictionNote: z.string(),
  }),
  resumeSchema: z.object({
    items: z.array(
      z.object({
        item: z.string(),
        qty: z.number(),
        priceCents: z.number(),
      }),
    ),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      return await suspend({
        message: "Confirm what you can make. The prices came from the forecast, not from the writing model.",
        proposals: inputData.proposals,
        similar: inputData.similar,
        events: inputData.events,
        source: inputData.source,
        predictionNote: inputData.predictionNote,
      });
    }
    const confirmed = inputData.proposals
      .map((proposal) => {
        const edit = resumeData.items.find((item) => item.item === proposal.item);
        const qty = capFromConstraint(
          proposal.item,
          inputData.constraint,
          edit?.qty ?? proposal.recommendedQty,
        );
        return {
          item: proposal.item,
          qty: Math.max(0, Math.round(qty)),
          priceCents: Math.round(edit?.priceCents ?? proposal.priceCents),
        };
      })
      .filter((item) => item.qty > 0);
    return { ...inputData, confirmed };
  },
});

const write = createStep({
  id: "write-sheet",
  inputSchema: confirmedSchema,
  outputSchema: sheetSchema,
  execute: async ({ inputData }) => {
    const copy = await writeCopy({
      city: inputData.city,
      weekend: inputData.weekend,
      weather: inputData.weather,
      constraint: inputData.constraint,
      items: inputData.confirmed,
      similarNotes: inputData.similar.map((weekend) => `${weekend.weekend}: ${weekend.highlight}`),
      events: inputData.events.map((event) => event.title),
    });
    const priceTags = inputData.confirmed.map((item) => ({
      item: item.item,
      qty: item.qty,
      priceCents: item.priceCents,
      line: `${item.item} — ${money(item.priceCents)}`,
    }));
    const payload = {
      runId: inputData.runId,
      marketId: inputData.marketId,
      city: inputData.city,
      weekend: inputData.weekend,
      weather: inputData.weather,
      constraint: inputData.constraint,
      source: inputData.source,
      predictionNote: inputData.predictionNote,
      copySource: copy.source,
      model: copy.model,
      promptTokens: copy.promptTokens,
      completionTokens: copy.completionTokens,
      prepList: copy.prepList,
      caption: copy.caption,
      priceTags,
      similar: inputData.similar,
      events: inputData.events,
    };
    // runId is the idempotency key. A resumed or restarted write does not insert a second sheet.
    await saveSheetOnce(inputData.runId, inputData.marketId, payload);
    return payload;
  },
});

export const stallSheetWorkflow = createWorkflow({
  id: "stall-sheet",
  inputSchema: requestSchema,
  outputSchema: sheetSchema,
})
  .then(gather)
  .then(predict)
  .then(confirm)
  .then(write)
  .commit();

let mastraPromise: Promise<Mastra> | undefined;

export function getMastra(): Promise<Mastra> {
  if (!mastraPromise) {
    mastraPromise = (async () => {
      await mkdir("data", { recursive: true });
      const storage = new LibSQLStore({
        id: "stallsheet",
        url: "file:./data/mastra.db",
      });
      await storage.init();
      return new Mastra({
        workflows: { stallSheet: stallSheetWorkflow },
        storage,
      });
    })();
  }
  return mastraPromise;
}

export const CONFIRM_STEP_ID = "confirm-quantities";

function featureRow(sale: {
  item: string;
  priceCents: number;
  weather: string;
  qtyMade: number;
  weekend: string;
  notes: string;
}): string {
  return featureCsv({
    item: sale.item,
    priceCents: sale.priceCents,
    weather: sale.weather,
    qtyMade: sale.qtyMade,
    month: Number(sale.weekend.slice(5, 7)),
    festival: /festival|wedding/i.test(sale.notes) ? 1 : 0,
  });
}

function featureCsv(row: {
  item: string;
  priceCents: number;
  weather: string;
  qtyMade: number;
  month: number;
  festival: number;
}): string {
  return `${csvCell(row.item)},${row.priceCents},${row.weather},${row.qtyMade},${row.month},${row.festival}`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function candidatePrices(prices: number[]): number[] {
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
