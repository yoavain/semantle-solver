# Semantle Hebrew (סמנטעל) — Autonomous Play Runbook

**Trigger:** when the user says *"play the daily game"* (or anything equivalent), execute the procedure
below end-to-end against **https://semantle.ishefi.com/** until the word is found. Assume **no further
instructions**. Everything you need is in this file.

> **Standing meta-instruction:** after every session, update this file with anything that makes the next
> run faster/smarter (new high-signal probes, model quirks, automation gotchas, sharper heuristics) and
> append the solved word to the log in §6. Continuous optimization of this runbook is part of the task.

---

## 1. Run procedure (do this in order)

1. **Load browser tools** in ONE `ToolSearch` call:
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp`
2. `tabs_context_mcp({createIfEmpty:true})` → get a `tabId`. (If the tab group is later lost mid-game,
   re-call this and re-navigate; you'll need to re-install the helpers from §3.)
3. `navigate` the tab to `https://semantle.ishefi.com/`.
4. **Read the daily calibration** (§2) with one `javascript_tool` call so you know today's score scale.
5. **Install the helpers** from §3 (one `javascript_tool` call). Re-install after any page reload.
6. **Play the loop** (§5): each turn call `guessMany([...10 Hebrew words])`, read the returned
   sim+rank and top-10 leaderboard, then choose the next batch by the strategy heuristics. Start from
   the broad-sweep probes in §6.
7. **Stop when** a guess returns rank `מצאת!` / similarity `100`. Read `#response` for the win line
   (`ניצחת! ... תוך N ניחושים`), report the word + guess count, then update §6.

Throughout, obey the constraints in §4 (throttle, real-UI clicks, visible mode).

## 2. Game mechanics

- Hebrew word-association game on a **word2vec** model. Guess a valid Hebrew word → get a **similarity
  score 0–100** (cosine to the secret) and a **rank**.
- **Rank — read direction carefully (easy to invert):** among the **1000 closest** words it shows
  `N/1000` where **higher N = CLOSER**. `999/1000` = closest non-answer; `1/1000` = the 1000th-closest
  (weakest word still in the top-1000); `(רחוק)` = "far", outside the top-1000; `מצאת!` = the secret
  (win). So `979/1000` is much hotter than `283/1000`. **Track max rank, not just max similarity.**
- **Daily calibration (read every run):** the page header states the similarity of the closest word
  (`999/1000`), the 10th-closest (`990/1000`), and the 1000th (`1/1000`). That is the day's score scale
  — use it to judge how hot a number is. (Example #1590: top = 74.12, 10th = 68.37, top-1000 cutoff =
  57.03 — so on that day "57" was barely top-1000.) Read it with:
  ```js
  document.body.innerText.match(/חידה מספר.*?57\.\d+|.*?ציון הקרבה.*/s) // or just read body text once
  ```
  Simplest: `JSON.stringify(document.body.innerText.slice(0,800))` and parse the three numbers.

## 3. Automation setup — install once per page load

The page wiring (from `static/semantle.js`): `$('#form').submit()` reads `$('#guess').val()`, calls
`getSim(word)` → `GET /api/distance?word=<word>` (header `X-SH-Version`) → renders a row into the
`#guesses` table with columns `[guessNumber, word, similarity, rankText]`. Always drive the **real UI**
(set `#guess`, click `#guess-btn`, the ניחוש button) so the user sees each guess land.

```js
window.guessWord = async function(word){
  const inp = document.getElementById('guess');
  const before = document.getElementById('guesses').innerText;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(inp, word); inp.dispatchEvent(new Event('input',{bubbles:true}));
  document.getElementById('error').textContent='';
  document.getElementById('guess-btn').click();            // clicks the real ניחוש button
  for(let k=0;k<40;k++){ await new Promise(r=>setTimeout(r,100));
    const err=document.getElementById('error').innerText.trim(); if(err) return {word,error:err};
    if(document.getElementById('guesses').innerText!==before) break; }
  const rows=[...document.querySelectorAll('#guesses tr')]
    .map(tr=>[...tr.querySelectorAll('td')].map(x=>x.innerText.trim())).filter(r=>r.length>=3);
  return {word, mine: rows.find(r=>r[1]===word), top: rows.slice(0,10).map(r=>[r[1],r[2],r[3]])};
};
window.guessMany = async function(words, delay){ delay = delay||1050; const out=[];
  for(let i=0;i<words.length;i++){ if(i>0) await new Promise(r=>setTimeout(r,delay));   // throttle
    try{ out.push(await window.guessWord(words[i])); }catch(e){ out.push({word:words[i],error:String(e)}); } }
  const rows=[...document.querySelectorAll('#guesses tr')]
    .map(tr=>[...tr.querySelectorAll('td')].map(x=>x.innerText.trim())).filter(r=>r.length>=3);
  return {results: out.map(o=>o.error?{w:o.word,err:o.error}
            :{w:o.word,sim:o.mine?o.mine[2]:null,rank:o.mine?o.mine[3]:null}),
          top: rows.slice(0,10).map(r=>[r[1],r[2],r[3]])};
};
'installed'
```

Each turn: `JSON.stringify(await window.guessMany(['מילה1','מילה2', ...]))`

## 4. Constraints

- **Throttle.** Default ≤ 1 guess / 2 s → `guessMany(words, 2100)`. If the user relaxes it (e.g. "1/s"),
  use `guessMany(words, 1050)`. Never fire raw guesses with no spacing. **Why this exists:** every new
  guess is a real `GET /api/distance` call to someone else's server (see §2/§3), so a solve is ~100–150
  live requests. Spacing them keeps us a polite client — it avoids hammering the backend and tripping
  any rate-limit / abuse protection. This is a real constraint, not cosmetic; keep it even when nobody
  is watching, and don't "optimize" it away for speed.
- **Real UI + visible mode.** Drive `#guess-btn`; runs in the user's real Chrome — don't hide the UI or
  bypass via direct API calls.
- **Use `javascript_tool` for everything.** `computer` screenshots / `read_page` usually fail here with
  `document_idle` timeouts (ads + long-poll keep the page "busy"). The user watches the live tab instead.
- **Output-filter gotcha.** Returning raw fetched JS or URLs containing `?…=…&…` can trip a
  "Cookie/query string data" block on the tool result. Strip `?`,`=`,`&` before printing page source;
  normally you never need to print it.
- **Unknown words** return `אני לא מכיר את המילה X` (surfaced as `{word,error}`); they cost nothing —
  skip and continue. Prefer native Hebrew spellings over transliterations.

## 5. Strategy — word2vec hill-climbing

1. **Broad sweep first** (~15–20 diverse nouns, §6) to find which semantic region is warm.
2. **Score against the day's scale.** Anything ≥ the top-1000 cutoff enters `N/1000` and is real signal;
   `(רחוק)` words are cold but still directional — compare their raw similarity to triangulate.
3. **Watch for polysemy.** A hot word may be scoring on a *secondary* sense (עץ = tree **& wood**;
   כסף = money **& silver**). Probe each sense's neighbours and follow whichever climbs.
4. **Exploit morphology — this model is very number-sensitive.** Plural/collective forms can score
   *far* higher than singular in list/inventory contexts (#1590: ברגים 67 vs בורג 25; אומים 60 vs אום 17).
   **Always test both plural and singular of a hot word.**
5. **Skip hypernyms.** Category-hub / umbrella words are usually COLD even when their members are hot
   (#1590: drill/screws 67 hot, but כלי/ציוד/אביזרים/מכשירים and workshop/garage 30–46). The model keys
   on collocation, not meaning — so even a *synonym* of a hot word can be cold (התקן 67 vs מתקן 44).
   Chase **specific concrete** nouns.
6. **Hill-climb:** expand around the top 2–3 words with their close associates; guess words *semantically
   between* two high scorers; abandon directions that stay `(רחוק)`.
7. **On a plateau, pivot frame.** When the top barely moves across a batch (you'll often pack the 60–67
   band with near-misses while the answer sits at 74+), stop adding tiny variants. Jump to an *adjacent
   frame*: the object's **parts**, its **plural**, the **tools/place/action** associated with it, or the
   **device/mechanism** it forms. (#1590: the whole hot cluster was the answer's *installation context* —
   drill + screws install a **lock**, which is a locking *device* with cylinder/spring/latch/handle/key.)
8. **Converge:** once a tight sub-category emerges, enumerate it exhaustively (members, synonyms,
   adjacent specifics, plural+singular) until rank → `מצאת!`.

## 6. Reference data

### Broad-sweep starter probes (use as the first 1–2 batches)
`אדם, ילד, כלב, עץ, מים, אש, ים, אהבה, פחד, זמן, כסף, מלחמה, מכונית, בית, אוכל, ספר, מוזיקה, מחשב, יד, ראש, מלך, חוק, דרך, אבן`
Follow the 2–3 warmest into their specific neighbourhoods per §5.

### Solved log
| Puzzle | Date       | Secret word        | Guesses | Path / lesson |
|--------|------------|--------------------|---------|----------------|
| #1590  | 2026-06-30 | **מנעול** (lock)   | 145     | sweep → עץ(wood)43/כלב(dog)38 → handheld implements (מקל 58) → power tools + fasteners (מקדחה 67/976, ברגים 67/971) → device/mechanism (התקן 67/979, מתג 67/977) → **מנעול** 100. Lesson: the tool cluster was the answer's *installation context*, not its category — on a ~67 plateau, pivot to "what object is installed with these / what device do these parts form." Weak early pointers: בריח 58, מפתח 46, התקן 67. |
