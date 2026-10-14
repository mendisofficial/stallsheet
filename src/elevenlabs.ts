import { config } from "./config.js";

export async function transcribeAudio(file: File): Promise<string> {
  const key = config().elevenLabsKey;
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY is not set. Transcription stays off until you add a key.");
  }

  const body = new FormData();
  body.set("model_id", config().elevenLabsModel);
  body.set("file", file, file.name || "constraint.webm");

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`ElevenLabs transcription failed (${response.status}): ${detail.slice(0, 180)}`);
  }
  const json = (await response.json()) as { text?: string };
  return (json.text ?? "").trim();
}
