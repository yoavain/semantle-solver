// Seeds, prompts, and candidate hygiene. The system prompt encodes the same heuristics as CLAUDE.md §5.
import { formatRank, type BoardEntry, type CandidateContext } from "./types.ts";

/** Broad-sweep probes spanning many semantic domains (from CLAUDE.md §6). Each run draws a random
 *  shuffle/subset of this pool (see shuffle()) for its opening guesses, instead of always guessing
 *  the same fixed list in the same order, so repeated runs don't retrace an identical opening. */
export const STARTER_POOL: string[] = [
  "אדם", "ילד", "כלב", "עץ", "מים", "אש", "ים", "אהבה", "פחד", "זמן",
  "כסף", "מלחמה", "מכונית", "בית", "אוכל", "ספר", "מוזיקה", "מחשב",
  "יד", "ראש", "מלך", "חוק", "דרך", "אבן",
  "שמש", "ירח", "כוכב", "הר", "נהר", "פרח", "ציפור", "דג", "סוס", "חתול",
  "שולחן", "כיסא", "דלת", "חלון", "טלפון", "בגד", "נעל", "שעון", "מפתח", "כלי",
  "רגש", "מחשבה", "חלום", "צבע", "קול", "ריח", "טעם", "מספר", "אות", "שם",
];

/** Fisher-Yates shuffle; returns a new array, leaves `arr` untouched. */
export function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const HEBREW_ONLY = /^[א-ת]{2,}$/; // base Hebrew letters incl. finals, single token, len >= 2
const NIKUD = /[֑-ׇ]/g;

/** Clean + dedup a raw candidate list: strip nikud, keep single Hebrew tokens, drop tried/rejected. */
export function cleanCandidates(
  words: string[],
  tried: Set<string>,
  rejected: Set<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let w of words) {
    if (typeof w !== "string") continue;
    w = w.normalize("NFC").replace(NIKUD, "").replace(/["'.,!?]/g, "").trim();
    if (!HEBREW_ONLY.test(w)) continue;
    if (tried.has(w) || rejected.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export const SYSTEM_PROMPT = `You generate candidate words for Hebrew "Semantle" (סמנטעל).
The game scores each guess by word2vec cosine similarity (0-100) to a hidden Hebrew word, plus a rank
"N/1000" where HIGHER N = CLOSER (999 = closest non-answer; "far" = outside the top 1000).

Given the hottest previous guesses, propose NEW single Hebrew words likely to score HIGHER. Rules:
1. Output ONLY valid, common, single Hebrew words — no spaces, no nikud, no transliterations, no English.
2. Never repeat a word that was already tried.
3. Exploit the hottest words: their close associates and synonyms, and try BOTH plural AND singular
   forms (this model is very number-sensitive — plurals can score far higher than singulars).
4. Also guess words conceptually "between" the two hottest words.
5. Prefer SPECIFIC concrete nouns. Avoid broad category/umbrella words (e.g. "tools", "equipment") and
   place/abstraction words — they tend to score low even when their members are hot.
6. When told to PIVOT, the hot cluster may be the CONTEXT around the answer, not its category: switch
   frame to the object's parts, where it is used, the action done with it, or the device its parts form.`;

export function buildUserPrompt(ctx: CandidateContext): string {
  const board = ctx.top
    .map((e: BoardEntry) => `${e.word}: ${e.sim.toFixed(2)} (${formatRank(e.rank)})`)
    .join("\n");

  // Cap the "do not repeat" list to keep the prompt lean while still covering recent/relevant words.
  const triedList = [...ctx.tried].slice(-140).join(", ");

  const pivot = ctx.plateau
    ? `\nThe top score has PLATEAUED — the hot words are CONTEXT around the secret, NOT the answer itself.
Do NOT add more minor variants, plurals, or near-synonyms of the hot words. PIVOT by function: name
concrete physical OBJECTS / DEVICES that the hot words are a PART OF, or that they
LOCK · SECURE · CLOSE · OPEN · FASTEN · CONTROL · OPERATE · are INSTALLED ON.
Think "what single object do these belong to or act on?" and give specific end-object nouns from a
DIFFERENT angle than the current cluster.`
    : "";

  return `Hottest guesses so far (word: similarity (rank)):
${board || "(none yet)"}
${pivot}

Return ${ctx.batchSize} NEW Hebrew words as JSON: {"words": ["...", "..."]}.
Do NOT reuse any of these already-tried words: ${triedList || "(none)"}.`;
}
