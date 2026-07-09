// Console display fix + plain-text per-game log (one line per row, written in real time) — the log is
// separate from runs/ (the structured JSON in runlog.ts used for strategy refinement).
import { appendFileSync, mkdirSync } from "node:fs";

const HEBREW_CHAR = /[֐-׿]/;

/**
 * Reorder text for terminals with no working bidi support (verified against cmd.exe/Windows Terminal:
 * a plain logical-order Hebrew string like "מלחמה" gets drawn left-to-right character-by-character, and
 * a human reading it right-to-left — as they naturally would — sees "המחלמ", i.e. scrambled). Splits the
 * string into maximal runs of Hebrew vs. non-Hebrew characters, reverses the RUN SEQUENCE (so the line
 * flows right-to-left overall, matching a Hebrew paragraph) and reverses the characters WITHIN each
 * Hebrew run (so each word itself reads correctly), while leaving non-Hebrew runs (digits, punctuation,
 * Latin, spaces — e.g. "(999/1000)") untouched in both content and internal order, so a human's
 * right-to-left scan hits them as an intact left-to-right island, same as normal bidi reading. Printing
 * the result on a dumb left-to-right renderer then reconstructs correct reading order for a human.
 * For a single isolated Hebrew word (no other tokens) this reduces to a plain character reversal.
 */
export function toVisualRTL(s: string): string {
  const tokens: string[] = [];
  let cur = "";
  let curIsHeb: boolean | null = null;
  for (const ch of s) {
    const isHeb = HEBREW_CHAR.test(ch);
    if (curIsHeb === null || isHeb === curIsHeb) cur += ch;
    else {
      tokens.push(cur);
      cur = ch;
    }
    curIsHeb = isHeb;
  }
  if (cur) tokens.push(cur);
  tokens.reverse();
  return tokens.map((t) => (HEBREW_CHAR.test(t) ? [...t].reverse().join("") : t)).join("");
}

const LOGS_DIR = "logs";
let logPath: string | null = null;
const preBuffer: string[] = [];

/** Open (or resume) today's text log once the puzzle number is known; flushes any buffered lines. */
export function openTextLog(puzzle: number | null, date: string): void {
  mkdirSync(LOGS_DIR, { recursive: true });
  const id = puzzle != null ? String(puzzle) : `run-${Date.now()}`;
  logPath = `${LOGS_DIR}/${id}-${date}.log`;
  if (preBuffer.length) {
    appendFileSync(logPath, preBuffer.join("\n") + "\n", "utf8");
    preBuffer.length = 0;
  }
}

/**
 * console.log `consoleText` (pass a `toVisualRTL`-transformed string for lines containing Hebrew) and
 * append `fileText` (plain logical order, defaults to `consoleText`) to the text log, so the log stays
 * copy-paste-safe even when the console version is display-reordered. Buffered until openTextLog runs.
 */
export function logLine(consoleText: string, fileText: string = consoleText): void {
  console.log(consoleText);
  if (logPath) appendFileSync(logPath, fileText + "\n", "utf8");
  else preBuffer.push(fileText);
}
