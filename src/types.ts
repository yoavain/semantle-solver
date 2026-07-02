/** Rank as shown by the game:
 *  - number 1..1000  → in the top-1000 (HIGHER = CLOSER; 999 = closest non-answer)
 *  - "FOUND"         → the secret word (win)
 *  - null            → "(רחוק)", outside the top-1000
 */
export type Rank = number | "FOUND" | null;

/** Render a Rank the way the game does: "FOUND", "far" (outside top-1000), or "N/1000". */
export function formatRank(r: Rank): string {
  return r === "FOUND" ? "FOUND" : r == null ? "far" : `${r}/1000`;
}

export interface GuessResult {
  word: string;
  /** true if the game accepted the word (knew it); false if it returned "I don't know this word". */
  ok: boolean;
  /** cosine similarity 0..100, or null if the word was rejected. */
  sim: number | null;
  rank: Rank;
}

export interface BoardEntry {
  word: string;
  sim: number;
  rank: Rank;
}

export interface CandidateContext {
  /** Top of the leaderboard, already sorted by similarity desc. */
  top: BoardEntry[];
  /** Every word already guessed (accepted) — never propose these again. */
  tried: Set<string>;
  /** Whether the best score has plateaued (→ ask the model for a plateau-specific batch). */
  plateau: boolean;
  /** Only meaningful when `plateau` is true: is the hot cluster ONE coherent category (enumerate
   *  deeper) or a diverse grab-bag (pivot frame)? See embedding.ts `clusterCohesion`. */
  tight: boolean;
  /** How many words to return. */
  batchSize: number;
}
