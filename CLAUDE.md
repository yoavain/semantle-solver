# Semantle Hebrew (סמנטעל) — Autonomous Play Runbook

**Trigger:** when the user says *"play the daily game"* (or anything equivalent), execute the procedure
below end-to-end against **https://semantle.ishefi.com/** until the word is found. Assume **no further
instructions**. Everything you need is in this file.

> **Standing meta-instruction:** after every session, update this file with anything that makes the next
> run faster/smarter (new high-signal probes, model quirks, automation gotchas, sharper heuristics),
> write a run log (§6), and append the solved word to the table in §6. Continuous optimization of this
> runbook is part of the task.

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
   (`ניצחת! ... תוך N ניחושים`), report the word + guess count, then:
   - Write a run log — see "Run log" under §6 for the shape and where it goes.
   - Update the §6 solved-log table with the new row (the curated, human-readable summary).

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

**Target:** a good run solves in well under 200 total guesses. Being stuck below the top-1000 cutoff
(every guess `(רחוק)`) past ~40-50 guesses is a bug signal, not normal variance — see item 10.

1. **Broad sweep first** (~15–20 diverse nouns, §6) to find which semantic region is warm.
2. **Score against the day's scale.** Anything ≥ the top-1000 cutoff enters `N/1000` and is real signal;
   `(רחוק)` words are cold but still directional — compare their raw similarity to triangulate.
3. **Watch for polysemy.** A hot word may be scoring on a *secondary* sense (עץ = tree **& wood**;
   כסף = money **& silver**). Probe each sense's neighbours and follow whichever climbs.
4. **Exploit morphology — this model is very number-sensitive.** Plural/collective forms can score
   *far* higher than singular in list/inventory contexts (#1590: ברגים 67 vs בורג 25; אומים 60 vs אום 17).
   **Always test both plural and singular of a hot word — and its construct-state (סמיכות, e.g. -ת
   ending) form too** (#1602: construct-state הכנת hit 73.99 fifty-five guesses before the automated
   solver got around to trying the plain base word הכנה). The automated solver now does this
   automatically for anything entering the top-1000 (`morphVariants()` in `src/strategy.ts`, see §5.12);
   manual sessions still need to do it by hand.
5. **Skip hypernyms — but only for physical-object domains.** Category-hub / umbrella words are usually
   COLD when their members are concrete objects (#1590: drill/screws 67 hot, but כלי/ציוד/אביזרים/מכשירים
   and workshop/garage 30–46). The model keys on collocation, not meaning — so even a *synonym* of a hot
   word can be cold (התקן 67 vs מתקן 44). Chase **specific concrete** nouns in that case. **This inverts
   for institutional/economic domains**: if the hot words are business/industry/finance-flavored terms,
   the secret is often itself an abstract category word (sector, field, branch, class) — see #1598 below.
   Don't blanket-avoid abstraction; judge by what kind of hot words you actually have.
6. **Hill-climb:** expand around the top 2–3 words with their close associates; guess words *semantically
   between* two high scorers; abandon directions that stay `(רחוק)`.
7. **On a plateau, pivot frame.** When the top barely moves across a batch (you'll often pack the 60–67
   band with near-misses while the answer sits at 74+), stop adding tiny variants. Jump to an *adjacent
   frame*: the object's **parts**, its **plural**, the **tools/place/action** associated with it, or the
   **device/mechanism** it forms. (#1590: the whole hot cluster was the answer's *installation context* —
   drill + screws install a **lock**, which is a locking *device* with cylinder/spring/latch/handle/key.)
8. **Converge:** once a tight sub-category emerges, enumerate it exhaustively (members, synonyms,
   adjacent specifics, plural+singular) until rank → `מצאת!`.
9. **Broad sweep must cover abstract/institutional domains too, not just physical objects.** #1598
   (מגזר, "sector") took ~70 guesses just to warm up: none of the original starter words touched
   economy/society/government, so there was no early signal, and the LLM (steered by the old, blanket
   version of rule 5) spent 50+ guesses drilling deeper into an unrelated concrete cluster (food/kitchen/
   harvest, all sub-40) instead of trying business/industry/finance words. The pool now seeds
   כלכלה/חברה/עסק/ממשלה/פוליטיקה/מדע/בריאות/חינוך/משפט/תרבות/מעמד/תחום for exactly this case. Also note:
   the solver's embedding engine (Rocchio relevance feedback, `src/embedding.ts`) only starts
   contributing candidates once a guess crosses `rocchioHotMin` (sim ≥ 50) or lands in the top-1000 —
   until then it's LLM-only. If nothing crosses that bar for many rounds, the LLM's own word choices are
   the *entire* search, so a bad early frame (see above) can stall the game for a very long time with no
   independent correction. **Fix applied:** the automated solver no longer takes a plain random subset of
   the pool for its opening batch — `diverseSeed()` in `src/embedding.ts` greedily farthest-point-samples
   over the pool's embedding vectors, so the 18 opening words are spread across semantic space by
   construction and can't cluster into one domain and skip another by chance.
10. **Cold-start blind spot in the embedding engine — found and fixed after #1599.** #1599 got stuck at
    best sim 42.44 (בעל) from guess ~20 through guess ~130 with zero improvement. Root cause:
    `rocchioQuery()` (`src/embedding.ts`) returns `null` whenever NO guess has ever crossed
    `rocchioHotMin` (sim ≥ 50) OR entered the top-1000 — and when it's `null`, `embeddingCandidates()`
    returns `[]`, so `nextPool()` (`src/solver.ts`) fell through *silently* to LLM-only for the whole
    cold phase. This run never crossed that bar even once in 129 guesses, so it was 100% LLM associative
    guessing from round 2 onward — the LLM's "PLATEAU → pivot" reasoning kept re-walking one
    neighbourhood (pet → owner → enclosure → travel → luggage) without landing anything better, which is
    what the user meant by "even random-seeming words, nothing makes it closer": an LLM's plateau pivots
    are not actually diverse in *embedding* space even when they look lexically varied. **Fix:**
    `nextPool()` now checks `rocchioQuery(board) === null` ("cold") as a signal separate from `plateau`;
    while cold, candidates come from `diverseExpand()` (new, in `src/embedding.ts`) — a farthest-point
    sample over a random slice of the embedding vocabulary's common-content-word band (skips the ~300
    top function words like של/את/על, and skips past index ~30k where the fastText frequency-sorted
    tail turns into rare inflected forms the game likely doesn't recognize) — instead of relying on the
    LLM. The instant any guess goes hot, behavior reverts to the existing Rocchio nearest-neighbour
    pull-close logic. Net rule: **low scores only → sample FAR/broad across embedding space; once
    something scores well → sample CLOSE to it** (the "hot" side already worked; the cold side was the
    gap).
11. **Terminal RTL display vs. copy-paste.** Some Windows consoles don't apply the Unicode bidi
    algorithm, so Hebrew words in a round-by-round printout can look reversed/garbled on screen.
    Do **not** reverse the string before printing to "fix" this — that corrupts copy-paste (the
    clipboard then carries the reversed characters). Instead the automated solver mirrors every printed
    line, unmodified, to a plain-text file (`src/textlog.ts` → `logs/<puzzle>-<date>.log`, gitignored,
    separate from the structured `runs/*.json`); open that file in an editor with real bidi rendering
    (VS Code, Notepad) to read a stuck game's guesses correctly instead of squinting at the raw console.
12. **Two more cold-phase gaps found after #1602 — both now fixed in code.** #1602 (secret הכנה,
    "preparation") took 210 guesses; ~100 of them (guess 24→124) were stuck at best sim 41-46 — real
    directional signal (נקיון, משימה, חובה — all task/duty-flavored) sitting just under both
    `rocchioHotMin` (50) and that day's actual top-1000 cutoff (47.3), so `rocchioQuery()` stayed `null`
    the whole time and the engine ran broad-random `diverseExpand` + LLM with no way to lean toward the
    near-miss cluster (same family of bug as #1599, item 10, just with the threshold barely out of
    reach instead of never reached). Separately, once hot, the game found the secret's own construct
    form **הכנת** (sim 73.99 — tied for the single closest word in that day's top-1000) at guess 155 and
    its plural **הכנות** (sim 69.64) at guess 194, but didn't try the bare base word **הכנה** until guess
    210 — 55 and 16 guesses later respectively. Root causes: (a) `rocchioQuery` summed the *entire* board
    history with no recency weighting, so ~150 early unrelated cold guesses kept diluting the pull
    toward the real signal even long after it appeared; (b) the "test singular/plural of a hot word"
    rule (item 4) was LLM-guidance only, didn't mention construct-state (סמיכות, e.g. -ת endings), and
    wasn't deterministic. **Fixes applied:** `rocchioQuery()` (`src/embedding.ts`) now applies a
    per-entry recency half-life decay (`CONFIG.rocchioRecencyHalfLife`, default 80 guesses) so old cold
    guesses fade instead of permanently dragging the query vector; and `morphVariants()` (new, in
    `src/strategy.ts`) deterministically generates absolute/construct/plural noun-ending swaps
    (-ה/-ת/-ות/-ים) for any guess that enters the top-1000, queued with priority into the very next
    round (`solver.ts` `morphQueue`) instead of hoping the LLM thinks to try them.

## 6. Reference data

### Broad-sweep starter probes (use as the first 1–2 batches)
Source of truth is `STARTER_POOL` in `src/strategy.ts` — copied here so manual sessions don't need to
open that file. **If this list and the code diverge, the code wins; update this copy to match.**
```
אדם, ילד, כלב, עץ, מים, אש, ים, אהבה, פחד, זמן, כסף, מלחמה, מכונית, בית, אוכל, ספר, מוזיקה, מחשב,
יד, ראש, מלך, חוק, דרך, אבן, שמש, ירח, כוכב, הר, נהר, פרח, ציפור, דג, סוס, חתול, שולחן, כיסא, דלת,
חלון, טלפון, בגד, נעל, שעון, מפתח, כלי, רגש, מחשבה, חלום, צבע, קול, ריח, טעם, מספר, אות, שם,
כלכלה, חברה, עסק, ממשלה, פוליטיקה, מדע, בריאות, חינוך, משפט, תרבות, מעמד, תחום
```
The automated solver picks its opening 18 via farthest-point sampling over the pool's embedding vectors
(`diverseSeed()` in `src/embedding.ts`, see §5.9) so the batch is spread across semantic space by
construction, not left to chance — falls back to a random subset if the embedding cache is unavailable.
Manual sessions don't have that machinery: guess a random subset (picking ~15–20 at random works well —
don't always fire the same fixed order, and try to eyeball spread across domains: nature/objects/people
AND abstract/institutional). Follow the 2–3 warmest into their specific neighbourhoods per §5.

### Run log (raw data for refining the pool/heuristics)
Every game — manual or automated — writes one structured record to `runs/` (gitignored, local only;
the solved-log table below is the curated summary that *does* get committed). Schema source of truth:
the `RunRecord` type in `src/runlog.ts`. Automated runs (`solver.ts`) write it automatically. For a
manual session, write it yourself at step 7 via a normal file write (Node-side, not page JS) to
`runs/<puzzle>-<date>.json`:
```json
{
  "puzzle": 1590, "date": "2026-06-30", "secret": "מנעול", "mode": "manual", "solved": true,
  "totalGuesses": 145,
  "guesses": [ { "word": "אדם", "ok": true, "sim": 12.3, "rank": null }, "... one entry per guess this session, in order, including rejected/unknown words ..." ],
  "calibration": "the §2 header line", "notes": "one-line summary of the winning path"
}
```
Once several runs accumulate in `runs/`, mine it to refine `STARTER_POOL` (drop words that are
consistently cold across games) and the §5 heuristics with real frequency data instead of narrative
memory of one game.

### Solved log
| Puzzle | Date       | Secret word        | Guesses | Path / lesson |
|--------|------------|--------------------|---------|----------------|
| #1590  | 2026-06-30 | **מנעול** (lock)   | 145     | sweep → עץ(wood)43/כלב(dog)38 → handheld implements (מקל 58) → power tools + fasteners (מקדחה 67/976, ברגים 67/971) → device/mechanism (התקן 67/979, מתג 67/977) → **מנעול** 100. Lesson: the tool cluster was the answer's *installation context*, not its category — on a ~67 plateau, pivot to "what object is installed with these / what device do these parts form." Weak early pointers: בריח 58, מפתח 46, התקן 67. *(Full guess history not captured — predates the runs/ log; see `runs/1590-2026-06-30.json` for the backfilled summary.)* |
| #1597  | 2026-07-06 | **חיוך** (smile)   | 106     | Fast solve: starter word אהבה (love) landed at sim 59.79/rank 348 on guess #3 — the pool happened to already contain a close neighbor, so the whole game was a normal hillclimb with no cold phase. |
| #1598  | 2026-07-07 | **מגזר** (sector)  | 136     | sweep (all concrete/physical, no hits) → 50+ guesses drilling a food/kitchen/harvest tangent (טעם 32, מפתח 40, כרם 35, זית 29 — all cold, never really climbing) → חקלאות(agriculture) 53.65 finally broke 50 at guess #68 → business/finance cluster (הייטק 70.8/993, עסקים 61.6/829, פיננסים 64.4/927, עסקי 66.2/964) → **מגזר** 100. Lesson: warm-up took ~70 guesses because (a) the starter pool had zero economy/society/government coverage, and (b) the "chase concrete nouns, skip hypernyms" heuristic is *wrong* for institutional secrets — see §5.9. Also confirmed the embedding engine (`rocchioQuery`) contributes nothing until a guess crosses sim 50, so this whole cold phase was pure LLM associative chaining with no correction. Pool + prompt heuristic updated in response (§5.9, §6). |
| #1599  | 2026-07-08 | **קצר** (short)    | 43      | Automated run, first game after the §5.10 cold-start fix (`diverseExpand`). A manual/pre-fix attempt on this same puzzle had stalled 129+ guesses at best 42.44 (בעל), never crossing the top-1000 cutoff (43.25) — see §5.10 for the root cause. Post-fix: round 1 broad sweep found nothing (best 34.91, all `(רחוק)`); round 2's cold-mode candidates (mixed `diverseExpand` far-samples + LLM) included זמן (time), which landed at 68.92/998 — instantly hot. The very next round's warm nearest-neighbour candidates proposed **קצר** (short, as in the collocation "זמן קצר" = "a short time") for guess #43 → 100/FOUND. Only 1 guess needed between first-hot and solved once the embedding engine had a real signal to pull toward — confirms the cold→far / hot→close split works as intended. |
| #1602  | 2026-07-11 | **הכנה** (preparation) | 210 | sweep (all cold, 20-30s) → ~100 guesses stuck at sim 41-46 (נקיון 43.26, משימה 46.02, חובה 41.62 — task/duty-flavored, but under both `rocchioHotMin`(50) and the day's top-1000 cutoff(47.3), so `rocchioQuery` stayed cold/random the whole stretch) → LLM associative chaining (תפקיד→מטרה→עבודה→ייצור→ציוד→מערכת) finally hit **תהליך**(process) 53.1/858 at guess 124 → fast climb through stage/completion words (השלמת 63/991, שלבי 55.9/940, סיום 48.9/400) → **הכנת**(construct "preparation of") 73.99/999 at guess 155 (tied for the day's single closest word!) → **הכנות**(plural) 69.64/996 at guess 194 → base word **הכנה** not tried until guess 210 → 100/FOUND. Lesson: see §5.12 — two engine gaps (no recency decay in `rocchioQuery`, no deterministic construct/plural-swap follow-up) both now fixed in code (`rocchioRecencyHalfLife` config, `morphVariants()` + `morphQueue`). |
