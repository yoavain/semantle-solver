// Sanity check: does the local embedding's geometry match the game enough for Rocchio to work?
import { loadEmbedding, hasWord, vecOf, nearest, rocchioQuery, embeddingCandidates } from "../src/embedding.ts";
import type { BoardEntry } from "../src/types.ts";

loadEmbedding();

console.log("\n# vocab coverage");
for (const w of ["מנעול", "דלת", "מקדחה", "בריח", "מפתח", "ברגים"]) {
  console.log(`  ${w}: ${hasWord(w) ? "in vocab" : "MISSING"}`);
}

console.log("\n# nearest neighbours of מנעול (the answer)");
const vlock = vecOf("מנעול");
if (vlock) console.log("  " + nearest(vlock, new Set(["מנעול"]), 15).map((x) => `${x.word}(${x.score.toFixed(2)})`).join("  "));

// Reconstruct the hot cluster the LLM-only solver plateaued on (excluding the answer).
const board: BoardEntry[] = [
  { word: "מקדחה", sim: 67.0, rank: 976 },
  { word: "ברגים", sim: 66.56, rank: 971 },
  { word: "ארגז", sim: 66.27, rank: 970 },
  { word: "ידית", sim: 63.5, rank: 900 },
  { word: "קפיץ", sim: 61.52, rank: 788 },
  { word: "מהדק", sim: 61.51, rank: 786 },
  { word: "חור", sim: 58.45, rank: 357 },
  { word: "מתכת", sim: 56.84, rank: null },
  { word: "אדם", sim: 17.7, rank: null },
  { word: "אהבה", sim: 25.92, rank: null },
];

const tried = new Set(board.map((b) => b.word));
console.log("\n# embeddingCandidates from the tools cluster (MMR diversity 0.65)");
const cands = embeddingCandidates(board, tried, 30, 0.65);
console.log("  " + cands.join("  "));
const pos = cands.indexOf("מנעול");
console.log(`  >> מנעול at position ${pos >= 0 ? pos + 1 : ">30"}`);

// The cluster the live run actually STALLED on (electrical controls / switches), best = לחצנים 996.
const controls: BoardEntry[] = [
  { word: "לחצנים", sim: 70.89, rank: 996 },
  { word: "התקן", sim: 67.31, rank: 979 },
  { word: "מתג", sim: 67.2, rank: 977 },
  { word: "לחצן", sim: 64.22, rank: 923 },
  { word: "מפסק", sim: 62.45, rank: 849 },
  { word: "טיימר", sim: 64.37, rank: 929 },
  { word: "חיווט", sim: 64.9, rank: 938 },
];
const triedC = new Set(controls.map((b) => b.word));
console.log("\n# embeddingCandidates from the STALL cluster (controls/switches, best=לחצנים 996)");
const candsC = embeddingCandidates(controls, triedC, 30, 0.65);
console.log("  " + candsC.join("  "));
const posC = candsC.indexOf("מנעול");
console.log(`  >> מנעול at position ${posC >= 0 ? posC + 1 : ">30"} (is the answer even reachable by NN here?)`);
