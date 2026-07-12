// Local Hebrew word-embedding nearest-neighbour engine with Rocchio relevance feedback.
// Loads the compact cache produced by scripts/build-vectors.ts. Vectors are unit-normalized,
// so cosine similarity == dot product.
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.ts";
import type { BoardEntry } from "./types.ts";

export const DIM = 300;
const DIR = path.resolve("data");

let WORDS: string[] = [];
let VECS = new Float32Array(0);
const INDEX = new Map<string, number>();
let loaded = false;

export function embeddingAvailable(): boolean {
  return fs.existsSync(path.join(DIR, "he-words.json")) && fs.existsSync(path.join(DIR, "he-vecs.f32"));
}

export function loadEmbedding(): void {
  if (loaded) return;
  WORDS = JSON.parse(fs.readFileSync(path.join(DIR, "he-words.json"), "utf8"));
  const buf = fs.readFileSync(path.join(DIR, "he-vecs.f32"));
  // Copy into an aligned ArrayBuffer slice so Float32Array view is valid.
  VECS = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  WORDS.forEach((w, i) => INDEX.set(w, i));
  loaded = true;
  console.log(`  [embedding] loaded ${WORDS.length} Hebrew vectors`);
}

export function hasWord(w: string): boolean {
  return INDEX.has(w);
}

export function vecOf(w: string): Float32Array | null {
  const i = INDEX.get(w);
  return i === undefined ? null : VECS.subarray(i * DIM, i * DIM + DIM);
}

/** Dot product of two DIM-length vectors, each optionally offset into a larger buffer. */
export function dot(a: Float32Array, b: Float32Array, aBase = 0, bBase = 0): number {
  let s = 0;
  for (let j = 0; j < DIM; j++) s += a[aBase + j] * b[bBase + j];
  return s;
}

/** L2-normalize a vector in place (no-op on an all-zero vector). Returns it for chaining. */
export function normalize(vec: Float32Array, dim = DIM): Float32Array {
  let norm = 0;
  for (let j = 0; j < dim; j++) norm += vec[j] * vec[j];
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < dim; j++) vec[j] /= norm;
  return vec;
}

/** Cosine nearest neighbours of a (unit) query vector, excluding `exclude`. `noise` (default 0, i.e.
 *  deterministic) adds uniform jitter to each score before ranking — see CONFIG.explorationNoise. */
export function nearest(
  q: Float32Array,
  exclude: Set<string>,
  k: number,
  noise = 0,
): { word: string; score: number }[] {
  const out: { word: string; score: number }[] = [];
  for (let i = 0; i < WORDS.length; i++) {
    const w = WORDS[i];
    if (exclude.has(w)) continue;
    let score = dot(q, VECS, 0, i * DIM);
    if (noise > 0) score += (Math.random() * 2 - 1) * noise;
    out.push({ word: w, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

/** Build a relevance-feedback query: pull toward hot guesses, push away from cold ones.
 *  Tuning knobs live in CONFIG (rocchioHotMin/rocchioBeta/rocchioRankBonus/rocchioRecencyHalfLife)
 *  alongside `diversity`. Every entry's weight is discounted by how many guesses old it is (half-life
 *  decay) so a long run of early, unrelated cold guesses can't keep permanently dragging the query away
 *  from a real signal that only shows up much later — see CLAUDE.md #1602. */
export function rocchioQuery(board: BoardEntry[]): Float32Array | null {
  const { rocchioHotMin: hotMin, rocchioBeta: beta, rocchioRankBonus: rankBonus, rocchioRecencyHalfLife: halfLife } = CONFIG;
  const q = new Float32Array(DIM);
  let positives = 0;
  const total = board.length;

  for (const e of board) {
    const v = vecOf(e.word);
    if (!v) continue;
    const age = total - (e.seq ?? total);
    const decay = halfLife > 0 ? Math.pow(0.5, age / halfLife) : 1;
    const inTop = e.rank !== null && e.rank !== "FOUND";
    if (e.sim >= hotMin || inTop) {
      let w = Math.max(e.sim - hotMin, 1);
      if (inTop) w += ((e.rank as number) / 1000) * rankBonus;
      w *= decay;
      for (let j = 0; j < DIM; j++) q[j] += w * v[j];
      positives++;
    } else {
      const w = ((beta * (hotMin - e.sim)) / hotMin) * decay;
      for (let j = 0; j < DIM; j++) q[j] -= w * v[j];
    }
  }
  if (positives === 0) return null;
  return normalize(q);
}

/** Average pairwise cosine similarity among the top-N hot board entries that have vectors — a proxy
 *  for whether the leaderboard is ONE coherent category (high) vs a diverse grab-bag of loosely-related
 *  hub words (low). On a plateau this decides ENUMERATE-deeper vs PIVOT-frame (see CLAUDE.md §5.7-8):
 *  a tight cluster (many near-synonyms/co-hyponyms, e.g. a page of vegetables) means the answer is
 *  probably an untried member of that same category; a loose cluster means the hot words are context
 *  around the answer, not its category. */
export function clusterCohesion(board: BoardEntry[], topN = 8): number {
  const vecs = board
    .slice(0, topN)
    .map((e) => vecOf(e.word))
    .filter((v): v is Float32Array => v !== null);
  if (vecs.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      sum += dot(vecs[i], vecs[j]);
      count++;
    }
  }
  return count ? sum / count : 0;
}

/** Greedy farthest-point sampling: pick `k` words from `pool` that spread across semantic space,
 *  instead of a plain random sample that can cluster by chance and miss whole domains entirely (a pool
 *  with N roughly-equal-size domains sampled at random has a real chance of skipping one — see the
 *  #1598 lesson in CLAUDE.md §5.9). Starts from a random word (so repeated runs open differently), then
 *  repeatedly adds whichever remaining word has the LOWEST max-cosine-similarity to everything already
 *  chosen (i.e. the one least like anything picked so far). `noise` jitters that score (see
 *  CONFIG.explorationNoise) so the farthest-point search itself isn't perfectly deterministic after the
 *  random start. Words without a vector can't be scored for diversity; they're appended at random only
 *  to fill out `k` if the vectorized words run short.
 */
export function diverseSeed(pool: readonly string[], k: number, noise = 0): string[] {
  const withVec = pool.filter(hasWord);
  const withoutVec = pool.filter((w) => !hasWord(w));
  if (withVec.length === 0) return shuffleSample(pool, k);

  const start = withVec[Math.floor(Math.random() * withVec.length)];
  const chosen = [start];
  const chosenVecs = [vecOf(start)!];
  const remaining = new Set(withVec.filter((w) => w !== start));

  while (chosen.length < k && remaining.size > 0) {
    let best: string | null = null;
    let bestScore = Infinity;
    for (const w of remaining) {
      const v = vecOf(w)!;
      let maxSim = -Infinity;
      for (const cv of chosenVecs) maxSim = Math.max(maxSim, dot(v, cv));
      if (noise > 0) maxSim += (Math.random() * 2 - 1) * noise;
      if (maxSim < bestScore) {
        bestScore = maxSim;
        best = w;
      }
    }
    chosen.push(best as string);
    chosenVecs.push(vecOf(best as string)!);
    remaining.delete(best as string);
  }

  if (chosen.length < k) {
    for (const w of shuffleSample([...remaining, ...withoutVec], k - chosen.length)) chosen.push(w);
  }
  return chosen;
}

/** Cold-start exploration: when no guess has ever crossed rocchioHotMin or entered the top-1000,
 *  rocchioQuery has zero positive signal to pull toward (see solver.ts nextPool) and candidate
 *  generation used to fall through silently to LLM-only for the rest of the game — which tends to
 *  wander a single associative chain (pet -> owner -> enclosure -> travel -> luggage, ...) rather than
 *  covering new ground (see CLAUDE.md #1599). Keep doing broad, spread-out sampling like the opening
 *  round instead: farthest-point-sample `k` words out of a random slice of the full vocabulary
 *  (excluding tried/rejected), so each cold round lands in genuinely different semantic territory.
 *  Samples a random slice first (rather than farthest-point-sampling the whole 100k-word vocabulary)
 *  to keep this cheap every round. */
export function diverseExpand(
  exclude: Set<string>,
  k: number,
  noise = 0,
  sampleSize = 3000,
  maxIndex = 30000,
): string[] {
  if (!loaded || WORDS.length === 0) return [];
  // WORDS is fastText's cc.he.300.vec, sorted by descending corpus frequency (see build-vectors.ts):
  // the first ~300 entries are function words (של, את, על, לא, הוא, ...) with no content-word value, and
  // the tail past ~30-50k is dominated by rare inflected forms the game's word list likely doesn't
  // recognize (verified by sampling — index 60k+ is mostly obscure conjugated compounds). Restrict
  // random sampling to the common-content-word band in between so cold-round guesses actually land.
  const skip = Math.min(300, WORDS.length);
  const upper = Math.min(maxIndex, WORDS.length);
  const seenIdx = new Set<number>();
  const pool: string[] = [];
  const target = Math.min(sampleSize, Math.max(upper - skip, 0));
  let guard = 0;
  while (pool.length < target && guard < target * 20) {
    guard++;
    const i = skip + Math.floor(Math.random() * (upper - skip));
    if (seenIdx.has(i)) continue;
    seenIdx.add(i);
    const w = WORDS[i];
    if (!exclude.has(w)) pool.push(w);
  }
  return diverseSeed(pool, k, noise);
}

/** Fisher-Yates sample of up to `k` items — local to avoid a strategy.ts <-> embedding.ts import cycle. */
function shuffleSample<T>(arr: readonly T[], k: number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, k);
}

// Clitic prefixes (and/the/in/to/as/that). NOT מ — too many real nouns start with it (מנעול, מקדחה).
const PREFIXES = new Set(["ו", "ה", "ב", "ל", "כ", "ש"]);

/** Collapse an inflected form like המנעול/וברגים to its base word when the base is itself known. */
export function baseForm(w: string): string {
  if (w.length >= 3 && PREFIXES.has(w[0]) && hasWord(w.slice(1))) return w.slice(1);
  return w;
}

/**
 * Candidate words from relevance feedback, de-noised two ways:
 *  - base-form folding of clitic prefixes (המנעול → מנעול)
 *  - MMR diversity: reject a candidate too cosine-similar to one already chosen this batch. Near-duplicate
 *    inflections (מותקן/מתקין/יותקן) cluster tightly in vector space, so this collapses them and forces
 *    wider exploration — without ever permanently excluding a word (it can still appear in later batches).
 * `maxSim` is the cosine ceiling between two chosen candidates (lower = more diverse).
 */
export function embeddingCandidates(
  board: BoardEntry[],
  exclude: Set<string>,
  k: number,
  maxSim = CONFIG.diversity,
): string[] {
  const q = rocchioQuery(board);
  if (!q) return [];
  const raw = nearest(q, exclude, k * 8, CONFIG.explorationNoise); // over-fetch; diversity filtering is aggressive
  const seen = new Set<string>();
  const out: string[] = [];
  const chosenVecs: Float32Array[] = [];

  for (const { word } of raw) {
    const b = baseForm(word);
    if (exclude.has(b) || seen.has(b)) continue;
    const vb = vecOf(b);
    if (vb) {
      const tooClose = chosenVecs.some((cv) => dot(vb, cv) > maxSim);
      if (tooClose) continue;
      chosenVecs.push(vb);
    }
    seen.add(b);
    out.push(b);
    if (out.length >= k) break;
  }
  return out;
}
