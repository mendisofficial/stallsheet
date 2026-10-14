import { config, money } from "./config.js";

export type ConfirmedItem = {
  item: string;
  qty: number;
  priceCents: number;
};

export type SheetCopy = {
  source: "gemma" | "template";
  prepList: string[];
  caption: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
};

export async function writeCopy(input: {
  city: string;
  weekend: string;
  weather: string;
  constraint: string;
  items: ConfirmedItem[];
  similarNotes: string[];
  events: string[];
}): Promise<SheetCopy> {
  const officialPrep = input.items.map((item) => `Make ${item.qty} ${item.item}.`);
  const tags = input.items.map((item) => `${item.item}: ${money(item.priceCents)}`);
  try {
    const written = await callGemma(input, tags);
    return {
      source: "gemma",
      prepList: written.prepList.length === input.items.length ? written.prepList : officialPrep,
      caption: stripPrices(written.caption),
      model: config().gemmaModel,
      promptTokens: written.promptTokens,
      completionTokens: written.completionTokens,
    };
  } catch (error) {
    const reason = gemmaReason(error);
    return {
      source: "template",
      prepList: officialPrep,
      caption: templateCaption(input, reason),
      model: config().gemmaModel,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
}

function gemmaReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Gemma unavailable";
  if (raw === "fetch failed" || raw.includes("ECONNREFUSED")) {
    return "Gemma endpoint was not reachable, so this caption is the template";
  }
  return raw;
}

function templateCaption(
  input: { city: string; weekend: string; weather: string; events: string[] },
  reason: string,
): string {
  const event = input.events[0] ? ` ${input.events[0]} is on nearby.` : "";
  return `${input.city} stall, ${input.weekend}. ${input.weather} forecast.${event} Price tags are printed from the forecast, not from this sentence. (${reason})`;
}

async function callGemma(
  input: {
    city: string;
    weekend: string;
    weather: string;
    constraint: string;
    items: ConfirmedItem[];
    similarNotes: string[];
    events: string[];
  },
  tags: string[],
): Promise<{ prepList: string[]; caption: string; promptTokens: number; completionTokens: number }> {
  const { gemmaBaseUrl, gemmaModel, gemmaApiKey } = config();
  const facts = {
    city: input.city,
    weekend: input.weekend,
    weather: input.weather,
    constraint: input.constraint || "none",
    make: input.items.map((item) => ({ item: item.item, qty: item.qty })),
    officialPriceTags: tags,
    similarWeekends: input.similarNotes,
    nearbyEvents: input.events,
  };
  const response = await fetch(`${gemmaBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(gemmaApiKey ? { Authorization: `Bearer ${gemmaApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: gemmaModel,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content:
            "You write a weekend market stall sheet. Do not invent prices or quantities. Do not include currency amounts. Reply with one JSON object and no other text. prepList is one short instruction per item, using the given qty. caption is two sentences a seller could post. Example: {\"prepList\":[\"Make 18 cinnamon buns.\"],\"caption\":\"Sunny stall this Saturday. The butter limit sets the bun count.\"}",
        },
        { role: "user", content: JSON.stringify(facts) },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Gemma request failed (${response.status}).`);
  }
  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = body.choices?.[0]?.message?.content ?? "";
  const parsed = parseJson(content);
  return {
    prepList: Array.isArray(parsed.prepList) ? parsed.prepList.map(String) : [],
    caption: typeof parsed.caption === "string" ? parsed.caption : "",
    promptTokens: body.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(facts).length / 4),
    completionTokens: body.usage?.completion_tokens ?? Math.ceil(content.length / 4),
  };
}

function parseJson(content: string): { prepList?: unknown; caption?: unknown } {
  const start = content.indexOf("{");
  if (start === -1) throw new Error("Gemma did not return JSON.");
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < content.length; i += 1) {
    const char = content[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(content.slice(start, i + 1)) as { prepList?: unknown; caption?: unknown };
    }
  }
  throw new Error("Gemma did not return a complete JSON object.");
}

export function stripPrices(caption: string): string {
  return caption.replace(/\$\s?\d+(?:\.\d{1,2})?/g, "").replace(/\s{2,}/g, " ").trim();
}
