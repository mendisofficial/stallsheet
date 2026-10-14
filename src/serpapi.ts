import { config } from "./config.js";

export type CityEvent = { title: string; date: string; venue: string };

export async function searchCityEvents(city: string, weekend: string): Promise<CityEvent[]> {
  const key = config().serpApiKey;
  if (!key || !city.trim()) return [];

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_events");
  url.searchParams.set("q", `${city} festival market`);
  url.searchParams.set("api_key", key);

  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`SerpApi failed (${response.status}).`);
  }
  const body = (await response.json()) as {
    events_results?: { title?: string; date?: { start_date?: string }; venue?: { name?: string } }[];
  };
  return (body.events_results ?? []).slice(0, 3).map((event) => ({
    title: event.title ?? "Local event",
    date: event.date?.start_date ?? weekend,
    venue: event.venue?.name ?? city,
  }));
}
