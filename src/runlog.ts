// Structured per-game log, written to runs/ (gitignored — raw data stays local). This is the raw
// material for future refinement of STARTER_POOL / heuristics; CLAUDE.md §6 stays the curated,
// human-readable distillation of it.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Rank } from "./types.ts";

export interface GuessLogEntry {
  word: string;
  ok: boolean;
  sim: number | null;
  rank: Rank;
}

export interface RunRecord {
  /** Puzzle number (חידה מספר NNN), or null if it couldn't be read. */
  puzzle: number | null;
  /** ISO date (YYYY-MM-DD) the run happened. */
  date: string;
  /** The secret word, or null if the run ended without solving (budget/abandoned). */
  secret: string | null;
  mode: "manual" | "automated";
  solved: boolean;
  /** Count of accepted (ok) guesses. */
  totalGuesses: number;
  /** Every guess this run, in order, including rejected/unknown words. */
  guesses: GuessLogEntry[];
  /** The daily calibration header line (top / 10th / 1000th similarity), if captured. */
  calibration?: string | null;
  /** Automated mode: relevant CONFIG snapshot. Manual mode: omitted. */
  config?: Record<string, unknown>;
  /** Free-text summary of the winning path / lesson learned. */
  notes?: string;
}

const RUNS_DIR = "runs";

/** Write one run record to runs/<puzzle-or-timestamp>-<date>.json. Returns the path written. */
export function writeRunLog(record: RunRecord): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  const id = record.puzzle != null ? String(record.puzzle) : `run-${Date.now()}`;
  const path = `${RUNS_DIR}/${id}-${record.date}.json`;
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  return path;
}
