import * as Sentry from "@sentry/node";
import { config } from "./config.js";

let started = false;

export function initSentry(): boolean {
  const dsn = config().sentryDsn;
  if (!dsn || started) return Boolean(dsn);
  Sentry.init({
    dsn,
    tracesSampleRate: 1,
  });
  started = true;
  return true;
}

export type TraceStep = { name: string; ms: number; detail: string };

export type RunTrace = {
  runId: string;
  steps: TraceStep[];
  predictionSource: string;
  predictionNote: string;
  copySource: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  sentry: boolean;
};

export async function withSpan<T>(name: string, attributes: Record<string, string | number>, fn: () => Promise<T>): Promise<T> {
  if (!initSentry()) return fn();
  return Sentry.startSpan({ name, op: "gen_ai.invoke_agent", attributes }, fn);
}

export function captureSheet(trace: RunTrace): void {
  if (!initSentry()) return;
  Sentry.withScope((scope) => {
    scope.setContext("stallsheet", { ...trace });
    Sentry.captureMessage(`stallsheet run ${trace.runId}`, "info");
  });
}
