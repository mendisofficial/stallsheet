import "dotenv/config";

export type Weather = "sunny" | "cloudy" | "rain";

const weatherSet = new Set<Weather>(["sunny", "cloudy", "rain"]);

export function config() {
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://stallsheet:stallsheet@localhost:54329/stallsheet",
    gemmaBaseUrl: (process.env.GEMMA_BASE_URL ?? "http://127.0.0.1:11434/v1").replace(
      /\/$/,
      "",
    ),
    gemmaModel: process.env.GEMMA_MODEL ?? "gemma3:4b",
    gemmaApiKey: process.env.GEMMA_API_KEY ?? "",
    tabpfnToken: process.env.TABPFN_TOKEN ?? "",
    tabpfnBaseUrl: "https://api.priorlabs.ai",
    serpApiKey: process.env.SERPAPI_KEY ?? "",
    elevenLabsKey: process.env.ELEVENLABS_API_KEY ?? "",
    elevenLabsModel: process.env.ELEVENLABS_STT_MODEL ?? "scribe_v1",
    sentryDsn: process.env.SENTRY_DSN ?? "",
  };
}

export function isWeather(value: string): value is Weather {
  return weatherSet.has(value as Weather);
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
