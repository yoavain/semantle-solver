// One-time prep: stream the Hebrew fastText vectors, keep the top-N Hebrew words, and write a compact
// local cache (data/he-words.json + data/he-vecs.f32, unit-normalized float32). Stops the download early.
//   npm run build:vectors
import https from "node:https";
import zlib from "node:zlib";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { DIM, normalize } from "../src/embedding.ts";

const URL = "https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.he.300.vec.gz";
const N = Number(process.env.VEC_N ?? 50000); // Hebrew words to keep
const MAX_LINES = Number(process.env.VEC_MAX_LINES ?? 150000); // safety cap on lines read
const HEBREW = /^[א-ת]{2,}$/;
const OUT_DIR = path.resolve("data");

console.log(`Streaming ${URL}\n  keeping up to ${N} Hebrew words (max ${MAX_LINES} lines)...`);

await new Promise<void>((resolve, reject) => {
  https.get(URL, (res) => {
    if (res.statusCode !== 200) {
      reject(new Error(`HTTP ${res.statusCode}`));
      return;
    }
    const gunzip = zlib.createGunzip();
    const rl = readline.createInterface({ input: res.pipe(gunzip) });
    const words: string[] = [];
    const vecs = new Float32Array(N * DIM);
    let lineNo = 0;
    let kept = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      rl.close();
      res.destroy(); // abort the rest of the 1.2GB download
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, "he-words.json"), JSON.stringify(words));
      fs.writeFileSync(path.join(OUT_DIR, "he-vecs.f32"), Buffer.from(vecs.buffer, 0, kept * DIM * 4));
      console.log(`Saved ${kept} words (read ${lineNo} lines) -> data/he-words.json, data/he-vecs.f32`);
      resolve();
    };

    rl.on("line", (line) => {
      if (done) return;
      lineNo++;
      if (lineNo === 1) return; // "count dim" header
      const sp = line.indexOf(" ");
      if (sp < 0) return;
      const word = line.slice(0, sp);
      if (!HEBREW.test(word)) {
        if (lineNo > MAX_LINES) finish();
        return;
      }
      const parts = line.split(" ");
      const view = vecs.subarray(kept * DIM, kept * DIM + DIM);
      for (let i = 0; i < DIM; i++) view[i] = parseFloat(parts[i + 1]);
      normalize(view);
      words.push(word);
      kept++;
      if (kept >= N || lineNo > MAX_LINES) finish();
    });

    rl.on("close", finish);
    gunzip.on("error", (e) => {
      if (!done) reject(e); // a truncated-stream error AFTER we abort is expected; ignore it
    });
    res.on("error", (e) => {
      if (!done) reject(e);
    });
  }).on("error", reject);
});
