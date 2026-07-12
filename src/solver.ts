// Entry point: orchestrates the play loop. Pure-code loop/stop/dedup; the model only suggests words.
import { CONFIG } from "./config.ts";
import { openGame, guess, readCalibration, readPuzzleNumber, readResponse, type GameHandle } from "./browser.ts";
import { generateCandidates, checkModel } from "./ollama.ts";
import { STARTER_POOL, shuffle, cleanCandidates, morphVariants } from "./strategy.ts";
import {
  embeddingAvailable, loadEmbedding, embeddingCandidates, clusterCohesion, diverseSeed, diverseExpand, rocchioQuery,
} from "./embedding.ts";
import { formatRank, type BoardEntry } from "./types.ts";
import { writeRunLog, type GuessLogEntry } from "./runlog.ts";
import { openTextLog, logLine, toVisualRTL } from "./textlog.ts";
import { loadUnknownWords, recordUnknownWord } from "./unknownwords.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sortBoard = (board: BoardEntry[]) => board.sort((a, b) => b.sim - a.sim);

async function main() {
  logLine(`\n=== Semantle solver — model=${CONFIG.model} ` +
    `throttle=${CONFIG.throttleMs}ms headless=${CONFIG.headless} ===`);

  // checkModel (HTTP round-trip) and openGame (browser launch + navigation) are independent —
  // run them concurrently instead of serializing the slow browser launch behind the model check.
  const modelCheck = checkModel();
  const gameOpen = openGame();

  const useEmbedding = CONFIG.embedding && embeddingAvailable();
  if (useEmbedding) loadEmbedding();
  else logLine("  [embedding] not available (run `npm run build:vectors`) — LLM-only mode");

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
  const puzzle = await readPuzzleNumber(page);
  const date = new Date().toISOString().slice(0, 10);
  openTextLog(puzzle, date);
  if (calibration) {
    logLine(`Daily scale:\n${toVisualRTL(calibration)}\n`, `Daily scale:\n${calibration}\n`);
  }

  const tried = new Set<string>();
  const rejected = loadUnknownWords();
  if (rejected.size) logLine(`  [unknown-words] preloaded ${rejected.size} known-unknown words`);
  const board: BoardEntry[] = [];
  const guessLog: GuessLogEntry[] = [];
  const bestHistory: number[] = [];
  // Deterministic morphological follow-ups (see strategy.ts morphVariants), queued whenever a guess
  // enters the top-1000 and guessed with priority next round — see CLAUDE.md #1602 (construct/plural
  // forms of the secret scored 73.99 and 69.64 but the base word wasn't tried until 55 guesses later).
  const morphQueue: string[] = [];
  let round = 0;
  // First round spans semantic space deliberately (farthest-point sampling over the pool's embedding
  // vectors) instead of a plain random subset, so it can't cluster into one domain and miss another by
  // chance (see CLAUDE.md #1598). Falls back to a random subset when the embedding isn't available.
  // Later rounds come from embedding + LLM.
  let pool = useEmbedding
    ? diverseSeed(STARTER_POOL, CONFIG.seedSize, CONFIG.explorationNoise)
    : shuffle(STARTER_POOL).slice(0, CONFIG.seedSize);

  // Primary candidates from the embedding (relevance-feedback NN); LLM adds pivots / diversity when
  // plateaued or when the embedding is unavailable/thin. `tight` (see embedding.ts clusterCohesion)
  // distinguishes a coherent single-category plateau (keep digging, relax the diversity filter so more
  // same-category neighbours survive) from a diverse hub-word plateau (genuinely pivot frame).
  async function nextPool(plateau: boolean, tight: boolean): Promise<string[]> {
    const exclude = new Set<string>([...tried, ...rejected]);
    // No guess has crossed rocchioHotMin or entered the top-1000 yet -> rocchioQuery has no positive
    // signal to pull toward. Used to fall through silently to LLM-only for the whole cold phase (see
    // CLAUDE.md #1599); instead keep sampling FAR/broad across the embedding space like round 1, mirroring
    // the "low scores -> look far; good scores -> look close" rule.
    const cold = useEmbedding && rocchioQuery(board) === null;
    const maxSim = plateau && tight ? CONFIG.diversityRelaxed : CONFIG.diversity;
    let out: string[] = [];
    if (cold) out = diverseExpand(exclude, CONFIG.batchSize, CONFIG.explorationNoise);
    else if (useEmbedding) out = embeddingCandidates(board, exclude, CONFIG.batchSize, maxSim);
    if (!useEmbedding || cold || plateau || out.length < CONFIG.batchSize) {
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
      let toGuess = cleanCandidates([...morphQueue, ...pool], tried, rejected);
      morphQueue.length = 0;

      // If we have no fresh candidates, regenerate (forcing a plateau round), then fall back to probes.
      if (toGuess.length === 0) {
        const tight = clusterCohesion(board) >= CONFIG.cohesionTight;
        toGuess = cleanCandidates(await nextPool(true, tight), tried, rejected);
        if (toGuess.length === 0) {
          toGuess = cleanCandidates(shuffle(STARTER_POOL), tried, rejected);
          if (toGuess.length === 0) {
            logLine("No new candidates left — stopping.");
            break;
          }
        }
      }

      // Guess the batch (throttled). Each new word is one real server call.
      for (const w of toGuess) {
        const r = await guess(page, w);
        await sleep(CONFIG.throttleMs);
        guessLog.push({ word: w, ok: r.ok, sim: r.sim, rank: r.rank });

        if (!r.ok || r.sim == null) {
          rejected.add(w);
          recordUnknownWord(w);
          logLine(`  ✗ ${toVisualRTL(w)} — unknown word`, `  ✗ ${w} — unknown word`);
          continue;
        }
        tried.add(w);
        board.push({ word: w, sim: r.sim, rank: r.rank, seq: tried.size });
        if (typeof r.rank === "number") morphQueue.push(...morphVariants(w));
        const hot = r.rank != null ? "  🔥" : "";
        // Empirically, the FOUND row's word renders correctly on-screen WITHOUT toVisualRTL (unlike
        // every other row) — observed consistently across separate terminals/runs. Exempt it rather than
        // theorize why; every other rank still needs the transform.
        const rowWord = r.rank === "FOUND" ? w : toVisualRTL(w);
        logLine(
          `  • ${rowWord.padEnd(12)} ${r.sim.toFixed(2).padStart(6)}  ${formatRank(r.rank)}${hot}`,
          `  • ${w.padEnd(12)} ${r.sim.toFixed(2).padStart(6)}  ${formatRank(r.rank)}${hot}`,
        );

        if (r.rank === "FOUND" || r.sim >= 100) {
          sortBoard(board);
          const banner = await readResponse(page);
          // Same empirical exemption as the FOUND row above — this line's word also renders correctly
          // un-transformed.
          logLine(`\n🎉 SOLVED: "${w}" in ${tried.size} accepted guesses.`);
          if (banner) {
            const line = banner.split("\n")[0];
            logLine(toVisualRTL(line), line);
          }
          const path = writeRunLog({
            puzzle, date, secret: w, mode: "automated", solved: true,
            totalGuesses: tried.size, guesses: guessLog, calibration,
            config: { model: CONFIG.model, embedding: CONFIG.embedding, seedSize: CONFIG.seedSize, batchSize: CONFIG.batchSize },
          });
          logLine(`Run log: ${path}`);
          await browser.close();
          return;
        }
        if (tried.size >= CONFIG.maxGuesses) {
          sortBoard(board);
          logLine(`\n⏹ Budget reached (${CONFIG.maxGuesses}). Best so far:`);
          printTop(board, 10);
          const path = writeRunLog({
            puzzle, date, secret: null, mode: "automated", solved: false,
            totalGuesses: tried.size, guesses: guessLog, calibration,
            config: { model: CONFIG.model, embedding: CONFIG.embedding, seedSize: CONFIG.seedSize, batchSize: CONFIG.batchSize },
            notes: `Budget reached (${CONFIG.maxGuesses}). Best: ${board[0]?.word} (${board[0]?.sim.toFixed(2)}).`,
          });
          logLine(`Run log: ${path}`);
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
      logLine(`\n--- round ${round} | tried ${tried.size} | best ${bestSim.toFixed(2)}${plateauTag} ---`);
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
    logLine(
      `    ${toVisualRTL(e.word).padEnd(12)} ${e.sim.toFixed(2).padStart(6)}  ${formatRank(e.rank)}`,
      `    ${e.word.padEnd(12)} ${e.sim.toFixed(2).padStart(6)}  ${formatRank(e.rank)}`,
    );
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
