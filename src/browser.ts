// All DOM/site access is isolated here so selector changes only touch this file.
import { chromium, type Browser, type Page } from "playwright";
import { CONFIG } from "./config.ts";
import type { GuessResult } from "./types.ts";

export interface GameHandle {
  browser: Browser;
  page: Page;
}

/** Launch a (visible) browser and load the game. */
export async function openGame(): Promise<GameHandle> {
  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext({ locale: "he-IL" });
  const page = await context.newPage();
  // domcontentloaded (not networkidle): the page's ads + long-poll never go idle.
  await page.goto(CONFIG.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#guess", { timeout: 30_000 });
  // Critical: wait until jQuery has bound the #form submit handler. Clicking the button before that
  // causes a NATIVE form submit -> navigation -> "context destroyed". Poll as a string expression.
  await page.waitForFunction(
    `(function(){ var f=document.getElementById('form');
       return !!(window.jQuery && f && window.jQuery._data(f,'events') && window.jQuery._data(f,'events').submit); })()`,
    { timeout: 30_000 },
  );
  return { browser, page };
}

/** Read the header text that states today's score scale (closest / 10th / 1000th similarities). */
export async function readCalibration(page: Page): Promise<string> {
  const text = await page.evaluate(() => document.body.innerText || "");
  // Pull the sentence that mentions the proximity scores, if present.
  const line = text.split("\n").find((l) => l.includes("ציון הקרבה")) ?? "";
  return line.trim();
}

/**
 * Guess one word through the REAL UI (type into #guess, click the ניחוש button), then read the
 * resulting row from the #guesses table. Runs entirely in page context.
 */
export async function guess(page: Page, word: string): Promise<GuessResult> {
  // Passed to the page as a STRING (not a compiled function) so the tsx/esbuild `__name`
  // helper is never injected into browser context. The word is embedded via JSON.stringify.
  const src = `(async (w) => {
    const inp = document.getElementById('guess');
    const table = document.getElementById('guesses');
    const errEl = document.getElementById('error');
    const btn = document.getElementById('guess-btn');
    if (!inp || !table || !btn) return { ok:false, sim:null, rank:null };
    const before = table.innerText;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(inp, w);
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    if (errEl) errEl.textContent = '';
    btn.click(); // submit -> getSim -> GET /api/distance -> render row
    for (let k=0;k<50;k++){
      await new Promise(function(r){ setTimeout(r,100); });
      if (errEl && errEl.innerText.trim()) return { ok:false, sim:null, rank:null };
      if (table.innerText !== before) break;
    }
    const rows = Array.prototype.slice.call(table.querySelectorAll('tr')).map(function(tr){
      return Array.prototype.slice.call(tr.querySelectorAll('td')).map(function(td){ return td.innerText.trim(); });
    });
    const row = rows.find(function(c){ return c[1] === w; });
    if (!row || row.length < 3) return { ok:false, sim:null, rank:null };
    const rankText = row[3] || '';
    let rank = null;
    if (rankText.indexOf('מצאת') >= 0) rank = 'FOUND';
    else { const m = rankText.match(/(\\d+)\\s*\\/\\s*1000/); rank = m ? Number(m[1]) : null; }
    return { ok:true, sim: parseFloat(row[2]), rank: rank };
  })(${JSON.stringify(word)})`;

  const res = (await page.evaluate(src)) as Omit<GuessResult, "word">;
  return { word, ...res };
}

/** The win banner text ("ניצחת! ... תוך N ניחושים"), once solved. */
export async function readResponse(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById("response")?.innerText.trim() ?? "");
}
