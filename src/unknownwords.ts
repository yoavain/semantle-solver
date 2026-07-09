// Cross-run cache of words the game doesn't recognize ("אני לא מכיר את המילה X"). Our embedding
// vocabulary (100k fastText entries) is far larger than the game's word list, so unknown-word guesses
// are common and pure waste — a throttled request that teaches us nothing. Persisted locally (gitignored,
// under data/ alongside the embedding cache) so every future run skips words already proven unknown
// instead of re-learning them one throttled guess at a time. Global across puzzles, not per-puzzle: a
// word's presence in the game's dictionary doesn't change day to day, only the secret does.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const FILE = path.join("data", "unknown-words.txt");

/** Load the persisted set of known-unknown words (empty set if the file doesn't exist yet). */
export function loadUnknownWords(): Set<string> {
  if (!existsSync(FILE)) return new Set();
  return new Set(
    readFileSync(FILE, "utf8")
      .split("\n")
      .map((w) => w.trim())
      .filter(Boolean),
  );
}

/** Append one newly-discovered unknown word to the persisted cache. */
export function recordUnknownWord(word: string): void {
  mkdirSync(path.dirname(FILE), { recursive: true });
  appendFileSync(FILE, word + "\n", "utf8");
}
