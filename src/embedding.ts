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
function dot(a: Float32Array, b: Float32Array, aBase = 0, bBase = 0): number {
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
 *  Tuning knobs live in CONFIG (rocchioHotMin/rocchioBeta/rocchioRankBonus) alongside `diversity`. */
export function rocchioQuery(board: BoardEntry[]): Float32Array | null {
  const { rocchioHotMin: hotMin, rocchioBeta: beta, rocchioRankBonus: rankBonus } = CONFIG;
  const q = new Float32Array(DIM);
  let positives = 0;

  for (const e of board) {
    const v = vecOf(e.word);
    if (!v) continue;
    const inTop = e.rank !== null && e.rank !== "FOUND";
    if (e.sim >= hotMin || inTop) {
      let w = Math.max(e.sim - hotMin, 1);
      if (inTop) w += ((e.rank as number) / 1000) * rankBonus;
      for (let j = 0; j < DIM; j++) q[j] += w * v[j];
      positives++;
    } else {
      const w = (beta * (hotMin - e.sim)) / hotMin;
      for (let j = 0; j < DIM; j++) q[j] -= w * v[j];
    }
  }
  if (positives === 0) return null;
  return normalize(q);
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
