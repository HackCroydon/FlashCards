# Study Deck

Flashcards and quizzes for biology and math — and you can build a new deck by
photographing a page of your notes. Gemini reads the page and writes the cards.

- **Flashcards** — flip, swipe, star the ones you keep missing
- **Quiz mode** — multiple choice with distractors that are actually plausible
- **Scan your notes** — photograph up to 5 pages, get a reviewable deck back
- **Progress** — per-deck completion, best quiz score, day streak

Everything you make is stored in your own browser. Nothing is uploaded except
the note images you choose to scan, and those aren't kept after the reply.

## How the scan works

```
browser                          /api/extract (server)          Gemini
  photo
  └─ downscale to 1600px JPEG
     └─ POST { images: [...] } ──►
                                  GEMINI_API_KEY (env var)
                                  └─ generateContent ──────────► gemini-3.6-flash
                                                                 responseSchema
                                  ◄──── { deckName, cards[] } ───┘
     ◄── [q, a, group, [4 wrong]]
  review screen (edit / untick)
  └─ save to localStorage
```

The API key lives only in a server env var. It is never sent to the browser, so
anyone can use the scan feature without having a key of their own.

### Model choice

The function walks a chain of models and uses the first that answers:
`gemini-3.6-flash` → `gemini-3.5-flash` → `gemini-3.8-flash`. That order is by
measured reliability, not version number — when this was built the newest
models (3.8, 3.7, and the `gemini-flash-latest` alias) returned 503 on every
attempt while 3.6 answered in about 10 seconds. Reading notes doesn't need
frontier reasoning, so a model that responds beats one that's nominally
stronger. Set `GEMINI_MODEL` to force a specific model to the front.

Each attempt is capped at 20s and transient 503s are retried with backoff,
under a 45s overall deadline so the function always answers before Vercel's
60s timeout cuts it off.

Cards come back as `[question, answer, group, [4 distractors]]`, the same shape
the built-in decks use, so scanned decks work in quiz mode straight away.

### Never put the key in the page

`public/index.html` is sent to every visitor, and this repo is public. A key
placed there would be readable by anyone viewing source and is scraped from
public repos within minutes. The key belongs in a server env var only:
`.env.local` locally, Vercel environment variables in production.

### Why there's a review screen

OCR on handwriting misreads things. Saving straight to a deck would mean
silently memorising wrong facts, which is the worst thing a study app can do.
So every scan lands on a review screen first — untick anything wrong, tap
**Edit** to fix a question or answer, then save.

## Quota: read this before sharing the link

The Gemini **free tier allows about 20 requests per day, per model**. The
function walks three models, each with its own allowance, so a free-tier deploy
supports roughly **60 scans a day site-wide** — shared across everyone who
opens the page, not per visitor.

That is fine for personal use. It is not enough for "anyone on the internet can
scan their notes". To lift it, enable billing on the Google Cloud project behind
the key: a scan is a small image plus a page of JSON, so paid usage runs
fractions of a cent each.

When the daily allowance runs out the app says so plainly and tells you it
resets tomorrow, rather than pretending to be busy.

## Running it locally

Put your key in a `.env.local` file in the project root — it is gitignored, so
it never reaches the repo:

```
GEMINI_API_KEY=your-key-here
```

Then just:

```bash
npm run dev                             # then open http://localhost:3000
```

You do **not** need a Vercel account to run this. You can also pass the key
inline instead of using a file:

```bash
GEMINI_API_KEY=your-key npm run dev     # then open http://localhost:3000
```

PowerShell:

```powershell
$env:GEMINI_API_KEY="your-key"; npm run dev
```

`dev-server.js` serves `public/` and runs `api/extract.js` with nothing but
Node — no dependencies, no CLI, no login. Get a key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey).

**Opening `public/index.html` directly as a file will not work for scanning.**
There is no server in that case, so there is no `/api/extract` and no key. The
app detects this and says so instead of blaming your connection.

If you prefer the real Vercel runtime locally, `npm i -g vercel && vercel dev`
also works.

## Deploying

Push to GitHub, then import the repo at [vercel.com/new](https://vercel.com/new)
and add `GEMINI_API_KEY` under **Settings → Environment Variables**. No build
step — `public/` is served static and `api/extract.js` becomes a function.

If you also serve the site from GitHub Pages, set `VERCEL_API` near the top of
the scan section in `public/index.html` to your Vercel URL, since Pages has no
`/api` of its own.

## Tests

```bash
npm test                            # 24 offline tests, no key needed
GEMINI_API_KEY=... npm run test:live # + one real Gemini call (uses daily quota)
```

`npm test` runs both suites. The API suite covers input validation, the model-output → card-tuple
conversion, error mapping and the rate limiter, with `fetch` stubbed. The live
test renders a page of notes to a real PNG (`test/make-notes-png.js`, a 5×7
bitmap font and a hand-rolled PNG encoder — no image dependencies) and sends it
through the real endpoint.

`test/picker.test.js` drives the real file-picker path in headless Chrome —
putting a file on the input and firing the change event a browser would fire.
It exists because that path shipped broken while every other test called
runScan() directly and sailed past it.

## Layout

```
public/index.html   the whole app — markup, styles, logic, built-in decks
dev-server.js       dependency-free local server (npm run dev)
api/extract.js      serverless function; holds the key, calls Gemini
test/               offline suite + PNG fixture generator
vercel.json         function config
```

## Limits

5 pages per scan, 2.5 MB per image, 3 MB total after the browser downscales
them. That ceiling exists because Vercel rejects request bodies over 4.5 MB
before the function runs and base64 inflates bytes by a third — the browser
steps resolution down (1600 → 1300 → 1100px) until the batch fits rather than
failing the upload.

A best-effort per-IP burst limit lives in the function, but serverless
instances are ephemeral so the real ceiling is your Gemini quota.

## When scanning doesn't work

**Open `/api/health` in a browser.** It answers, in order, the things that
actually go wrong: is the function running, is `GEMINI_API_KEY` set, is the key
valid, and which models are reachable. It never returns the key itself.

Add `?probe=1` to spend one real request proving generation works end to end
(this costs daily quota, so it's opt-in).

```
/api/health          -> is the key set and valid?
/api/health?probe=1  -> does generation actually work right now?
```

Typical answers:

| `hint` says | What to do |
|---|---|
| `GEMINI_API_KEY is not set` | Add the env var, then **redeploy** — Vercel only applies env vars to new builds |
| `The key was rejected` | Key is invalid, revoked, or restricted. Make a fresh one |
| `Daily free quota is used up` | Free tier is ~20 requests/day/model. Wait, or enable billing |
| `Gemini is returning 503` | Upstream demand. Retry shortly |
| `Everything checks out` | Server is fine — the problem is in the browser. Check the page is served over http(s), not opened as a file |

In the app itself, any scan failure now has a **Show technical details** button
listing the page URL, the endpoint it called, file sizes, the downscaled upload
size, the HTTP status, timing and the server's own error message — with **Copy
details** next to it. The same trace goes to the browser console under `[scan]`.

## Decks, categories and sharing

**Categories** are yours to define. Biology and Maths are seeded so existing
decks keep working, but you can add, rename, recolour and delete any of them.
Deleting a category never destroys decks — they fall through to an
"Uncategorised" section where they can be re-filed.

**Every deck is editable**, including the built-in one. The `⋯` next to a deck
opens its settings: rename, move to another category, manage cards, export, or
delete it.

**Deleting cards** works from the study screen or a deck's card list.

**Scanning into an existing deck** — the review screen asks where the cards
should go. It defaults to creating a new deck; pick an existing one and the
cards are appended instead. Cards whose question already exists in that deck
are skipped, because re-scanning an overlapping page is the easy way to end up
with the same card twice.

**Sharing** produces a share code. The payload is deflated and base64url'd
because raw JSON for a 23-card deck is about 6,500 characters as base64, which
is unusable as something you paste into a chat; compressed it is around 2,000.
Codes start with `STUDYDECK1.` and carry the deck's category, so a deck arrives
with "Chemistry" intact rather than landing uncategorised. Very long codes are
flagged in the export dialog, because the common failure is a chat app
silently truncating one.

Imported decks are untrusted input: every field is type-checked, coerced to a
string and length-capped at the boundary, card counts are capped, and all text
is escaped at render. `test/decks.test.js` imports a deliberately hostile deck
and asserts no markup is injected and no script runs.

### Card identity

Cards carry a stable id in slot 4 of their tuple (`[q, a, group, distractors,
id]`), and `starred` references those ids. This matters: `starred` used to hold
array indices, so deleting a card silently repointed every star above it at its
neighbour. State from before this change is migrated on first load, remapping
starred indices to ids against the order the old code assembled them in.
