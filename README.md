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

### Why there's a review screen

OCR on handwriting misreads things. Saving straight to a deck would mean
silently memorising wrong facts, which is the worst thing a study app can do.
So every scan lands on a review screen first — untick anything wrong, tap
**Edit** to fix a question or answer, then save.

## Running it locally

```bash
npm i -g vercel        # once
vercel dev             # serves public/ and api/ together on localhost:3000
```

`vercel dev` will ask for `GEMINI_API_KEY` — get one free at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey). Or put it in
a `.env.local` file (already gitignored):

```
GEMINI_API_KEY=your-key-here
```

Without a key the site still runs; only the scan button will error.

## Deploying

Push to GitHub, then import the repo at [vercel.com/new](https://vercel.com/new)
and add `GEMINI_API_KEY` under **Settings → Environment Variables**. No build
step — `public/` is served static and `api/extract.js` becomes a function.

If you also serve the site from GitHub Pages, set `VERCEL_API` near the top of
the scan section in `public/index.html` to your Vercel URL, since Pages has no
`/api` of its own.

## Tests

```bash
node test/extract.test.js           # 21 offline tests, no key needed
GEMINI_API_KEY=... node test/extract.test.js --live   # + one real Gemini call
```

The offline suite covers input validation, the model-output → card-tuple
conversion, error mapping and the rate limiter, with `fetch` stubbed. The live
test renders a page of notes to a real PNG (`test/make-notes-png.js`, a 5×7
bitmap font and a hand-rolled PNG encoder — no image dependencies) and sends it
through the real endpoint.

## Layout

```
public/index.html   the whole app — markup, styles, logic, built-in decks
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
