// Does the sharpened plateau pivot make the LLM produce מנעול from the controls/switch stall cluster?
import { generateCandidates } from "../src/ollama.ts";
import { cleanCandidates } from "../src/strategy.ts";
import type { BoardEntry } from "../src/types.ts";

const controls: BoardEntry[] = [
  { word: "לחצנים", sim: 70.89, rank: 996 },
  { word: "התקן", sim: 67.31, rank: 979 },
  { word: "מתג", sim: 67.2, rank: 977 },
  { word: "לחצן", sim: 64.22, rank: 923 },
  { word: "מפסק", sim: 62.45, rank: 849 },
  { word: "מכשיר", sim: 62.82, rank: 868 },
];
const tried = new Set(controls.map((b) => b.word));

const raw = await generateCandidates({ top: controls, tried, plateau: true, batchSize: 15 });
const clean = cleanCandidates(raw, tried, new Set());
console.log("\ncandidates:", clean.join("  "));
console.log("\n>> מנעול present?", clean.includes("מנעול"));
for (const w of ["מנעול", "בריח", "דלת", "מפתח", "נעילה"]) {
  if (clean.includes(w)) console.log(`   also got lock-related: ${w}`);
}
