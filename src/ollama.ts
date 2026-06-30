// Candidate generation via a local Ollama model, with JSON-schema-constrained output.
import { CONFIG } from "./config.ts";
import type { CandidateContext } from "./types.ts";
import { SYSTEM_PROMPT, buildUserPrompt } from "./strategy.ts";

const WORDS_SCHEMA = {
  type: "object",
  required: ["words"],
  properties: { words: { type: "array", items: { type: "string" } } },
} as const;

interface ChatResponse {
  message?: { content?: string; thinking?: string };
  error?: string;
}

/** Ask the model for a batch of new Hebrew words. Returns raw words (caller cleans/dedups). */
export async function generateCandidates(ctx: CandidateContext): Promise<string[]> {
  const body = {
    model: CONFIG.model,
    stream: false,
    think: true, // always reason before answering — better candidates & pivots (single flow)
    options: { temperature: CONFIG.temperature, num_predict: 1024 },
    format: WORDS_SCHEMA,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(ctx) },
    ],
  };

  let data: ChatResponse;
  try {
    const r = await fetch(`${CONFIG.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.warn(`  [ollama] HTTP ${r.status} ${r.statusText}`);
      return [];
    }
    data = (await r.json()) as ChatResponse;
  } catch (e) {
    console.warn(`  [ollama] request failed: ${(e as Error).message}`);
    return [];
  }

  if (data.error) {
    console.warn(`  [ollama] ${data.error}`);
    return [];
  }

  // gemma4 is a reasoning model: with structured output it often spends the whole token budget
  // "thinking" and returns EMPTY content (done_reason "length"). The thinking trace still lists the
  // candidate Hebrew words, so harvest from it when content is empty/unparseable.
  const msg = data.message ?? {};
  let words = parseWords(msg.content ?? "");
  if (words.length === 0 && msg.thinking) {
    words = harvestHebrew(msg.thinking).slice(0, 30);
  }
  return words;
}

/** Pull all distinct Hebrew tokens (length >= 2) from free text, in order of appearance. */
export function harvestHebrew(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/[א-ת]{2,}/g)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

/** Parse the model's JSON; fall back to scraping Hebrew tokens if it isn't clean JSON. */
export function parseWords(content: string): string[] {
  if (!content) return [];
  try {
    const obj = JSON.parse(content);
    if (Array.isArray(obj?.words)) return obj.words.filter((w: unknown) => typeof w === "string");
    if (Array.isArray(obj)) return obj.filter((w: unknown) => typeof w === "string");
  } catch {
    /* fall through to regex */
  }
  // Fallback: pull quoted strings, else any Hebrew runs.
  const quoted = [...content.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (quoted.length) return quoted;
  return harvestHebrew(content);
}

/** One-line preflight so a wrong model name / down server fails loudly at startup. */
export async function checkModel(): Promise<void> {
  try {
    const r = await fetch(`${CONFIG.ollamaUrl}/api/tags`);
    const data = (await r.json()) as { models?: { name: string }[] };
    const names = (data.models ?? []).map((m) => m.name);
    if (!names.includes(CONFIG.model)) {
      console.warn(
        `  [ollama] model "${CONFIG.model}" not found. Installed: ${names.join(", ") || "(none)"}`,
      );
    }
  } catch {
    throw new Error(
      `Cannot reach Ollama at ${CONFIG.ollamaUrl}. Is it running? (ollama serve)`,
    );
  }
}
