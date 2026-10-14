import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { config, isWeather } from "./config.js";
import { parseSalesCsv } from "./csv.js";
import { countSales, getPool, listSales, migrate, replaceSales } from "./db.js";
import { DEMO_MARKET_ID, demoSales } from "./seed-data.js";
import { transcribeAudio } from "./elevenlabs.js";
import { captureSheet, initSentry, withSpan, type RunTrace } from "./trace.js";
import { CONFIRM_STEP_ID, getMastra } from "./workflow.js";

type RunResult = {
  status: string;
  result?: {
    source: string;
    predictionNote: string;
    copySource: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
  };
  suspendPayload?: unknown;
  error?: { message: string };
};

type HeldRun = {
  runId: string;
  start(args: { inputData: Record<string, string> }): Promise<RunResult>;
  resume(args: {
    step: string;
    resumeData: { items: { item: string; qty: number; priceCents: number }[] };
  }): Promise<RunResult>;
};

const runs = new Map<string, { run: HeldRun; startedAt: number }>();

const app = new Hono();

app.get("/api/health", async (c) => {
  let db = false;
  try {
    await getPool().query("SELECT 1");
    db = true;
  } catch {
    db = false;
  }
  const settings = config();
  return c.json({
    ok: db,
    db,
    gemmaConfigured: Boolean(settings.gemmaBaseUrl),
    gemmaModel: settings.gemmaModel,
    tabpfnConfigured: Boolean(settings.tabpfnToken),
    serpapiConfigured: Boolean(settings.serpApiKey),
    elevenlabsConfigured: Boolean(settings.elevenLabsKey),
    sentryConfigured: Boolean(settings.sentryDsn),
  });
});

app.post("/api/demo", async (c) => {
  const count = await replaceSales(DEMO_MARKET_ID, demoSales());
  return c.json({ marketId: DEMO_MARKET_ID, rows: count });
});

app.get("/api/sales", async (c) => {
  const marketId = c.req.query("marketId") || DEMO_MARKET_ID;
  const sales = await listSales(marketId);
  return c.json({ marketId, rows: sales.length, sales });
});

app.post("/api/sales", async (c) => {
  const body = await c.req.json<{ marketId?: string; csv?: string }>();
  const marketId = (body.marketId || DEMO_MARKET_ID).trim();
  if (!body.csv) return c.json({ error: "Paste a CSV or upload one." }, 400);
  try {
    const rows = parseSalesCsv(body.csv);
    const count = await replaceSales(marketId, rows);
    return c.json({ marketId, rows: count });
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.post("/api/transcribe", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: "Attach an audio file in the file field." }, 400);
  try {
    const text = await transcribeAudio(file);
    return c.json({ text });
  } catch (error) {
    return c.json({ error: message(error) }, 400);
  }
});

app.post("/api/runs", async (c) => {
  const body = await c.req.json<{
    marketId?: string;
    city?: string;
    weekend?: string;
    weather?: string;
    constraint?: string;
  }>();
  const marketId = (body.marketId || DEMO_MARKET_ID).trim();
  const city = (body.city || "").trim();
  const weekend = (body.weekend || "").trim();
  const weather = (body.weather || "").trim();
  if (!city || !/^\d{4}-\d{2}-\d{2}$/.test(weekend) || !isWeather(weather)) {
    return c.json({ error: "City, a YYYY-MM-DD weekend, and weather are required." }, 400);
  }
  if ((await countSales(marketId)) === 0) {
    return c.json({ error: "Load the bakery demo or upload sales before building a sheet." }, 400);
  }

  const mastra = await getMastra();
  const workflow = mastra.getWorkflow("stallSheet");
  const run = (await workflow.createRun()) as HeldRun;
  const startedAt = Date.now();
  runs.set(run.runId, { run, startedAt });

  const result = await withSpan(
    "stallsheet.forecast",
    { "gen_ai.system": "gemma", "gen_ai.operation.name": "invoke_agent", marketId },
    () =>
      run.start({
        inputData: {
          runId: run.runId,
          marketId,
          city,
          weekend,
          weather,
          constraint: body.constraint?.trim() ?? "",
        },
      }),
  );

  if (result.status === "suspended") {
    return c.json({
      status: "suspended",
      runId: run.runId,
      suspend: unwrapSuspend(result.suspendPayload),
    });
  }
  if (result.status === "success" && result.result) {
    const trace = buildTrace(run.runId, result.result, Date.now() - startedAt);
    captureSheet(trace);
    return c.json({ status: "success", runId: run.runId, sheet: result.result, trace });
  }
  return c.json({ error: result.error?.message ?? "The workflow did not finish." }, 500);
});

app.post("/api/runs/:runId/confirm", async (c) => {
  const held = runs.get(c.req.param("runId"));
  if (!held) return c.json({ error: "That run is no longer in memory. Start the sheet again." }, 404);
  const body = await c.req.json<{ items?: { item: string; qty: number; priceCents: number }[] }>();
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: "Confirm at least one item." }, 400);
  }
  const items = body.items;
  const result = await withSpan(
    "stallsheet.write",
    { "gen_ai.operation.name": "chat", "gen_ai.request.model": config().gemmaModel },
    () =>
      held.run.resume({
        step: CONFIRM_STEP_ID,
        resumeData: { items },
      }),
  );
  if (result.status === "success" && result.result) {
    const trace = buildTrace(c.req.param("runId"), result.result, Date.now() - held.startedAt);
    captureSheet(trace);
    return c.json({ status: "success", runId: c.req.param("runId"), sheet: result.result, trace });
  }
  if (result.status === "failed") return c.json({ error: result.error?.message ?? "The write step failed." }, 500);
  return c.json({ error: `Workflow ended as ${result.status}.` }, 500);
});

app.use("/*", serveStatic({ root: "./public" }));

async function main() {
  initSentry();
  await migrate();
  if ((await countSales(DEMO_MARKET_ID)) === 0) {
    await replaceSales(DEMO_MARKET_ID, demoSales());
  }
  const port = config().port;
  serve({ fetch: app.fetch, port }, () => {
    console.log(`StallSheet listening on http://localhost:${port}`);
  });
}

function unwrapSuspend(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "proposals" in payload) return payload;
  if (payload && typeof payload === "object") {
    for (const value of Object.values(payload)) {
      if (value && typeof value === "object" && "proposals" in value) return value;
    }
  }
  return payload;
}

function buildTrace(
  runId: string,
  sheet: {
    source: string;
    predictionNote: string;
    copySource: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
  },
  ms: number,
): RunTrace {
  return {
    runId,
    steps: [{ name: "stall-sheet", ms, detail: sheet.predictionNote }],
    predictionSource: sheet.source,
    predictionNote: sheet.predictionNote,
    copySource: sheet.copySource,
    model: sheet.model,
    promptTokens: sheet.promptTokens,
    completionTokens: sheet.completionTokens,
    sentry: Boolean(config().sentryDsn),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
