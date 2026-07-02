// Entry point: orchestrates the play loop. Pure-code loop/stop/dedup; the model only suggests words.
import { CONFIG } from "./config.ts";
import { openGame, guess, readCalibration, readResponse, type GameHandle } from "./browser.ts";
import { generateCandidates, checkModel } from "./ollama.ts";
import { STARTER_POOL, shuffle, cleanCandidates } from "./strategy.ts";
import { embeddingAvailable, loadEmbedding, embeddingCandidates, clusterCohesion } from "./embedding.ts";
import { formatRank, type BoardEntry } from "./types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sortBoard = (board: BoardEntry[]) => board.sort((a, b) => b.sim - a.sim);

async function main() {
  console.log(`\n=== Semantle solver — model=${CONFIG.model} ` +
    `throttle=${CONFIG.throttleMs}ms headless=${CONFIG.headless} ===`);

  // checkModel (HTTP round-trip) and openGame (browser launch + navigation) are independent —
  // run them concurrently instead of serializing the slow browser launch behind the model check.
  const modelCheck = checkModel();
  const gameOpen = openGame();

  const useEmbedding = CONFIG.embedding && embeddingAvailable();
  if (useEmbedding) loadEmbedding();
  else console.log("  [embedding] not available (run `npm run build:vectors`) — LLM-only mode");

  // If checkModel fails, close the browser launched concurrently rather than leaking it.
  let handle: GameHandle;
  try {
    await modelCheck;
    handle = await gameOpen;
  } catch (err) {
    await gameOpen.then((h) => h.browser.close()).catch(() => {});
    throw err;
  }
  const { browser, page } = handle;
  const calibration = await readCalibration(page);
  if (calibration) console.log(`Daily scale: ${calibration}\n`);

  const tried = new Set<string>();
  const rejected = new Set<string>();
  const board: BoardEntry[] = [];
  const bestHistory: number[] = [];
  let round = 0;
  // First round uses a random subset of the broad sweep (varies run-to-run); later rounds come from
  // embedding + LLM.
  let pool = shuffle(STARTER_POOL).slice(0, CONFIG.seedSize);

  // Primary candidates from the embedding (relevance-feedback NN); LLM adds pivots / diversity when
  // plateaued or when the embedding is unavailable/thin. `tight` (see embedding.ts clusterCohesion)
  // distinguishes a coherent single-category plateau (keep digging, relax the diversity filter so more
  // same-category neighbours survive) from a diverse hub-word plateau (genuinely pivot frame).
  async function nextPool(plateau: boolean, tight: boolean): Promise<string[]> {
    const exclude = new Set<string>([...tried, ...rejected]);
    const maxSim = plateau && tight ? CONFIG.diversityRelaxed : CONFIG.diversity;
    let out: string[] = useEmbedding ? embeddingCandidates(board, exclude, CONFIG.batchSize, maxSim) : [];
    if (!useEmbedding || plateau || out.length < CONFIG.batchSize) {
      const llm = await generateCandidates({
        top: board.slice(0, 15),
        tried,
        plateau,
        tight,
        batchSize: CONFIG.batchSize,
      });
      for (const w of llm) if (!out.includes(w)) out.push(w);
    }
    return out;
  }

  try {
    while (true) {
      let toGuess = cleanCandidates(pool, tried, rejected);

      // If we have no fresh candidates, regenerate (forcing a plateau round), then fall back to probes.
      if (toGuess.length === 0) {
        const tight = clusterCohesion(board) >= CONFIG.cohesionTight;
        toGuess = cleanCandidates(await nextPool(true, tight), tried, rejected);
        if (toGuess.length === 0) {
          toGuess = cleanCandidates(shuffle(STARTER_POOL), tried, rejected);
          if (toGuess.length === 0) {
            console.log("No new candidates left — stopping.");
            break;
          }
        }
      }

      // Guess the batch (throttled). Each new word is one real server call.
      for (const w of toGuess) {
        const r = await guess(page, w);
        await sleep(CONFIG.throttleMs);

        if (!r.ok || r.sim == null) {
          rejected.add(w);
          console.log(`  ✗ ${w} — unknown word`);
          continue;
        }
        tried.add(w);
        board.push({ word: w, sim: r.sim, rank: r.rank });
        const hot = r.rank != null ? "  🔥" : "";
        console.log(`  • ${w.padEnd(12)} ${r.sim.toFixed(2).padStart(6)}  ${formatRank(r.rank)}${hot}`);

        if (r.rank === "FOUND" || r.sim >= 100) {
          sortBoard(board);
          const banner = await readResponse(page);
          console.log(`\n🎉 SOLVED: "${w}" in ${tried.size} accepted guesses.`);
          if (banner) console.log(banner.split("\n")[0]);
          await browser.close();
          return;
        }
        if (tried.size >= CONFIG.maxGuesses) {
          sortBoard(board);
          console.log(`\n⏹ Budget reached (${CONFIG.maxGuesses}). Best so far:`);
          printTop(board, 10);
          await browser.close();
          return;
        }
      }

      // Round summary + next candidates.
      sortBoard(board);
      const bestSim = board[0]?.sim ?? 0;
      bestHistory.push(bestSim);
      const plateau = isPlateau(bestHistory);
      const tight = clusterCohesion(board) >= CONFIG.cohesionTight;

      round++;
      const plateauTag = plateau ? (tight ? " | PLATEAU(tight) → enumerate" : " | PLATEAU(loose) → pivot") : "";
      console.log(`\n--- round ${round} | tried ${tried.size} | best ${bestSim.toFixed(2)}${plateauTag} ---`);
      printTop(board, 8);

      pool = await nextPool(plateau, tight);
    }
  } finally {
    if (browser.isConnected()) await browser.close();
  }
}

function isPlateau(history: number[]): boolean {
  const n = CONFIG.plateauRounds + 1;
  if (history.length < n) return false;
  const recent = history.slice(-n);
  return Math.max(...recent) - Math.min(...recent) < CONFIG.plateauEps;
}

function printTop(board: BoardEntry[], n: number) {
  for (const e of board.slice(0, n)) {
    console.log(`    ${e.word.padEnd(12)} ${e.sim.toFixed(2).padStart(6)}  ${formatRank(e.rank)}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
