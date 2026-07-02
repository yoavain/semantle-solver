// Central, env-tunable configuration. Override any value via environment variables.
//   MODEL=gemma4:12b HEADLESS=false THROTTLE_MS=2000 BATCH=12 npm start

const num = (v: string | undefined, d: number) => (v != null && v !== "" ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v != null && v !== "" ? v === "true" || v === "1" : d);

export const CONFIG = {
  /** Game URL. */
  url: process.env.URL ?? "https://semantle.ishefi.com/",

  /** Ollama server + model used as the candidate generator. */
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  model: process.env.MODEL ?? "gemma4:12b",
  temperature: num(process.env.TEMP, 0.9),

  /** Use the local Hebrew embedding (data/) as the primary candidate engine. Falls back to LLM-only
   *  if the cache is missing. Set EMBEDDING=false to force LLM-only. */
  embedding: bool(process.env.EMBEDDING, true),
  /** MMR diversity ceiling: reject an embedding candidate whose cosine to one already chosen this batch
   *  exceeds this (lower = more diverse, fewer near-duplicate inflections). */
  diversity: num(process.env.DIVERSITY, 0.65),

  /** Random jitter added to each embedding NN score before ranking (same units as cosine similarity,
   *  roughly 0-1). The NN search is otherwise pure greedy ranking — with noise=0 the same board state
   *  always produces the same candidates in the same order. 0 = deterministic; higher = more
   *  run-to-run variety, at the cost of sometimes passing over the single best-scoring neighbour. */
  explorationNoise: num(process.env.EXPLORE_NOISE, 0.03),

  /** How many starter probes to guess in round 1, drawn from a random shuffle of STARTER_POOL (see
   *  strategy.ts) rather than a fixed list, so repeated runs don't open identically. */
  seedSize: num(process.env.SEED_SIZE, 18),

  /** Rocchio relevance feedback (src/embedding.ts): below this similarity a guess is "cold" and
   *  pushes the query away from it. */
  rocchioHotMin: num(process.env.ROCCHIO_HOT_MIN, 50),
  /** Rocchio: strength of the cold push-away term. */
  rocchioBeta: num(process.env.ROCCHIO_BETA, 0.3),
  /** Rocchio: extra pull for words inside the top-1000, scaled by rank. */
  rocchioRankBonus: num(process.env.ROCCHIO_RANK_BONUS, 25),

  /** Run the browser visibly (non-headless) so you can watch. */
  headless: bool(process.env.HEADLESS, false),

  /** Politeness: each new guess is one real GET /api/distance. Keep >= ~1000ms. */
  throttleMs: num(process.env.THROTTLE_MS, 2000),

  /** How many new words to ask the model for per round. */
  batchSize: num(process.env.BATCH, 12),

  /** Stop and report the best word after this many *valid* guesses. */
  maxGuesses: num(process.env.MAX_GUESSES, 300),

  /** Plateau detection: rounds of no best-similarity improvement before we tell the model to PIVOT. */
  plateauRounds: num(process.env.PLATEAU_ROUNDS, 2),
  plateauEps: num(process.env.PLATEAU_EPS, 0.5),

  /** Avg pairwise cosine among the top 8 hot words (embedding.ts clusterCohesion) at/above this means
   *  the leaderboard is ONE coherent category, not a diverse hub — on a plateau, ENUMERATE deeper into
   *  it instead of PIVOTing frame. */
  cohesionTight: num(process.env.COHESION_TIGHT, 0.35),
  /** MMR diversity ceiling used instead of `diversity` when plateaued AND tight: relaxed so the
   *  embedding search can keep surfacing more same-category neighbours instead of being forced to
   *  spread out across unrelated regions. */
  diversityRelaxed: num(process.env.DIVERSITY_RELAXED, 0.85),
} as const;
