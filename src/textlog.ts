// Plain-text, human-readable per-game log (one line per row, written in real time) — separate from
// runs/ (the structured JSON in runlog.ts used for strategy refinement). Some terminals don't apply the
// Unicode bidi algorithm, so Hebrew can look reversed/garbled on screen; reversing it before printing
// would fix the visual but corrupt copy-paste (the clipboard would carry the reversed characters).
// Instead leave the console alone and mirror every line here — open this file in an editor with proper
// bidi rendering (VS Code, Notepad, ...) to read it correctly. Matches the blanket `*.log` gitignore
// rule, so it never leaks into the repo.
import { appendFileSync, mkdirSync } from "node:fs";

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

/** console.log the line, and also append it to the text log (buffered until openTextLog runs). */
export function logLine(line: string): void {
  console.log(line);
  if (logPath) appendFileSync(logPath, line + "\n", "utf8");
  else preBuffer.push(line);
}
