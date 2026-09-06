/**
 * POST /api/extract
 *
 * Takes photos of handwritten or printed notes and returns flashcards.
 * The Gemini key lives here in an env var and never reaches the browser.
 *
 * Body: { images: [dataUrl, ...], subject?: "biology"|"math"|"auto", hint?: string }
 * 200:  { deckName, subject, cards: [[q, a, group, [d1,d2,d3,d4]], ...] }
 * 4xx/5xx: { error: "message safe to show the user" }
 */

const MAX_IMAGES = 5;
// Vercel rejects request bodies over 4.5 MB before this function runs, and
// base64 inflates bytes by ~4/3. Keep the decoded total under ~3 MB so the
// encoded body stays clear of that ceiling and users get our error, not the
// platform's.
const MAX_BYTES_PER_IMAGE = 2.5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const OK_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

// Ordered by measured reliability on this workload, not by version number.
// 3.8 and 3.7 returned 503 on every attempt (3.8 took 72s to do it) while 3.6
// answered in ~10s. Reading notes doesn't need frontier reasoning, so a model
// that responds beats one that is nominally stronger.
//
// Walking the list also buys quota: the free tier allows only ~20 requests per
// day PER MODEL, so each entry carries its own separate daily allowance.
//
// gemini-2.5-flash is deliberately absent — it now 404s for new API keys
// ("no longer available to new users"), so it could only waste a hop.
// Set GEMINI_MODEL to force a specific model to the front.
const MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
].filter(Boolean);

const RETRY_STATUS = new Set([500, 502, 503, 504]);
// One swamped model took 72s to answer 503. Cut it off well before that so the
// chain has time to reach a model that works.
const ATTEMPT_TIMEOUT_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CARD_SCHEMA = {
  type: "OBJECT",
  properties: {
    deckName: {
      type: "STRING",
      description: "Short title for the deck taken from the notes, e.g. 'Topic 3 — Enzymes'. Max 60 chars.",
    },
    subject: {
      type: "STRING",
      enum: ["biology", "math"],
      description: "Which subject these notes belong to.",
    },
    cards: {
      type: "ARRAY",
      description: "One card per distinct testable fact in the notes.",
      items: {
        type: "OBJECT",
        properties: {
          question: { type: "STRING", description: "A clear, self-contained question." },
          answer: { type: "STRING", description: "The correct answer, concise, one or two sentences." },
          group: {
            type: "STRING",
            description:
              "A short lowercase tag for the kind of answer: term, concept, list, number, process, formula, sugar, unit. Cards sharing a tag are used as each other's quiz distractors.",
          },
          distractors: {
            type: "ARRAY",
            description:
              "Exactly 4 wrong answers that are plausible to someone who half-learned the material. Same length and register as the real answer. Never nonsense, never a synonym of the real answer.",
            items: { type: "STRING" },
          },
        },
        required: ["question", "answer", "group", "distractors"],
      },
    },
  },
  required: ["deckName", "subject", "cards"],
};

const PROMPT = `You are building study flashcards from a student's own notes.

Read every page image carefully, including handwriting, diagram labels, margin notes and tables.

Rules:
- Make one card per distinct testable fact. Do not merge two facts into one card.
- Cover the whole page. Do not stop early. Typical page of notes yields 10-30 cards.
- Questions must stand alone. "What is it?" is useless; "What is a monomer?" is a card.
- Answers must be what the notes actually say, not what you know from elsewhere. If the notes are wrong, follow the notes.
- If handwriting is genuinely unreadable, skip that fact rather than guessing at it.
- Every card needs exactly 4 distractors. They must be plausible-but-wrong, matched in length and style to the real answer, and mutually distinct. A distractor that is obviously silly makes the quiz worthless.
- Do not invent facts that are not on the pages.

If the pages contain no study material at all, return an empty cards array.`;

function bad(res, code, error) {
  res.status(code).json({ error });
  return null;
}

/** Pull mime + base64 out of a data URL, validating as we go. */
function parseDataUrl(entry, i) {
  if (typeof entry !== "string") throw new Error(`Image ${i + 1} was not a string.`);
  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(entry.trim());
  if (!m) throw new Error(`Image ${i + 1} is not a valid base64 data URL.`);
  const [, mime, data] = m;
  if (!OK_MIME.includes(mime.toLowerCase())) {
    throw new Error(`Image ${i + 1} is a ${mime} — use JPEG, PNG or WebP.`);
  }
  const bytes = Math.floor((data.length * 3) / 4);
  if (bytes > MAX_BYTES_PER_IMAGE) {
    throw new Error(`Image ${i + 1} is too large (${(bytes / 1048576).toFixed(1)} MB). Max 4 MB each.`);
  }
  return { mime: mime.toLowerCase(), data, bytes };
}

/**
 * Best-effort burst limiter. Serverless instances are ephemeral and there are
 * many of them, so this slows down one impatient tab, not a determined abuser.
 * The real ceiling is the Gemini quota.
 */
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6;

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  }
  return recent.length > MAX_PER_WINDOW;
}

async function callGemini(model, key, parts, budgetMs = ATTEMPT_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budgetMs);
  try {
    return await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: CARD_SCHEMA,
          temperature: 0.3,
          maxOutputTokens: 32768,
        },
      }),
    }
    );
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  // Same-origin in the Vercel deploy, but the GitHub Pages mirror needs these.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return bad(res, 405, "Use POST.");

  const key = process.env.GEMINI_API_KEY;
  if (!key) return bad(res, 500, "The server has no Gemini API key configured yet.");

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (rateLimited(ip)) {
    return bad(res, 429, "That's a lot of scans at once — give it a minute and try again.");
  }

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  if (!body) return bad(res, 400, "Could not read the request.");

  const { images, subject, hint } = body;
  if (!Array.isArray(images) || images.length === 0) {
    return bad(res, 400, "No images were sent.");
  }
  if (images.length > MAX_IMAGES) {
    return bad(res, 400, `Up to ${MAX_IMAGES} pages at a time, please.`);
  }

  let parsed;
  try {
    parsed = images.map(parseDataUrl);
  } catch (e) {
    return bad(res, 400, e.message);
  }
  const total = parsed.reduce((n, p) => n + p.bytes, 0);
  if (total > MAX_TOTAL_BYTES) {
    return bad(res, 413, "Those pages are too large altogether. Try fewer pages at once.");
  }


  const steer = [];
  if (subject === "biology" || subject === "math") {
    steer.push(`These notes are for ${subject}. Use "${subject}" as the subject.`);
  }
  if (typeof hint === "string" && hint.trim()) {
    steer.push(`The student says these notes are about: ${hint.trim().slice(0, 200)}`);
  }

  const parts = [
    { text: PROMPT + (steer.length ? `\n\n${steer.join("\n")}` : "") },
    ...parsed.map((p) => ({ inline_data: { mime_type: p.mime, data: p.data } })),
  ];

  let lastErr = "Could not reach Gemini.";
  let overloaded = false;
  let outOfQuota = false;

  // vercel.json gives this function 60s. Retrying three models three times can
  // outlast that, and a platform timeout gives the user a blank error instead
  // of ours — so stop trying with enough headroom to answer properly.
  const deadline = Date.now() + 45_000;

  for (const model of MODELS) {
    if (Date.now() > deadline) { overloaded = true; break; }
    let r = null;
    // Gemini returns 503 when a model is briefly swamped. That is not a reason
    // to fail someone's scan, so ride it out before moving down the chain.
    for (let attempt = 0; attempt < 3; attempt++) {
      // Never start an attempt that could run past the deadline: cap it at
      // whatever budget is left. Below ~4s there is no point starting at all.
      const left = deadline - Date.now();
      if (left < 4000) { overloaded = true; break; }
      try {
        r = await callGemini(model, key, parts, Math.min(ATTEMPT_TIMEOUT_MS, left));
      } catch (e) {
        r = null;
        if (e?.name === "AbortError") {
          // Timed out rather than refused — the model is wedged, not missing.
          overloaded = true;
          lastErr = `${model} timed out.`;
        } else {
          lastErr = "Could not reach Gemini. Check your connection and try again.";
        }
      }
      if (r && RETRY_STATUS.has(r.status)) {
        overloaded = true;
        lastErr = `Gemini returned ${r.status}.`;
        if (attempt < 2 && Date.now() + 1200 * (attempt + 1) < deadline) {
          await sleep(1200 * (attempt + 1));
          continue;
        }
      }
      break;
    }
    if (!r) continue;

    if (r.status === 404) {
      lastErr = `Model ${model} is unavailable.`;
      continue; // try the next model name
    }
    if (RETRY_STATUS.has(r.status)) continue; // still swamped; try another model
    if (r.status === 429) {
      // The free tier is only ~20 requests per day per model, so this is the
      // limit most deployments hit first. Say which kind of limit it is —
      // "try later" is useless advice if the answer is actually "tomorrow".
      const detail = await r.text().catch(() => "");
      const perDay = /PerDay|RequestsPerDay/i.test(detail);
      console.error("Gemini quota exceeded:", detail.slice(0, 400));
      if (perDay) {
        // Another model in the chain has its own separate daily allowance.
        outOfQuota = true;
        lastErr = `${model} is out of daily quota.`;
        continue;
      }
      const wait = /retry in ([\d.]+)s/i.exec(detail);
      return bad(res, 429, wait
        ? `Gemini is rate limiting us. Try again in about ${Math.ceil(+wait[1])} seconds.`
        : "Gemini is rate limiting us right now. Give it a minute and try again.");
    }
    if (r.status === 400 || r.status === 403) {
      const detail = await r.text().catch(() => "");
      console.error("Gemini rejected the request:", r.status, detail.slice(0, 500));
      return bad(res, 502, "Gemini rejected the request. The API key may be invalid or restricted.");
    }
    if (!r.ok) {
      lastErr = `Gemini returned ${r.status}.`;
      continue;
    }

    const json = await r.json().catch(() => null);
    if (!json) return bad(res, 502, "Gemini sent back something unreadable.");

    const cand = json.candidates?.[0];
    const finish = cand?.finishReason;
    if (finish === "SAFETY" || json.promptFeedback?.blockReason) {
      return bad(res, 422, "Gemini declined to read those images.");
    }

    const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
    if (!text) {
      if (finish === "MAX_TOKENS") {
        return bad(res, 502, "Those notes were too dense to finish. Try scanning fewer pages at once.");
      }
      return bad(res, 502, "Gemini returned an empty result. Try again.");
    }

    const out = safeJson(text);
    if (!out || !Array.isArray(out.cards)) {
      console.error("Unparseable model output:", text.slice(0, 500));
      return bad(res, 502, "Gemini's answer wasn't in the expected format. Try again.");
    }

    const cards = out.cards.map(normaliseCard).filter(Boolean);
    if (cards.length === 0) {
      return bad(res, 422, "No study material was found on those pages. Try a clearer photo.");
    }

    return res.status(200).json({
      deckName: String(out.deckName || "Scanned notes").slice(0, 60),
      subject: out.subject === "math" ? "math" : "biology",
      cards,
      truncated: finish === "MAX_TOKENS",
      model,
    });
  }

  // Every model out of its daily allowance is a different problem from a busy
  // one, and "try again later" would be wrong advice: the answer is tomorrow.
  if (outOfQuota) {
    return bad(res, 429,
      "Today's free Gemini quota is used up (the free tier allows only about 20 scans a day per model). It resets tomorrow.");
  }

  // If anything in the chain was swamped, say so. The last model's 404 is the
  // least relevant error we saw and the least actionable thing to show.
  if (overloaded) {
    return bad(res, 503, "Gemini is busy right now. Give it a minute and scan again.");
  }
  return bad(res, 502, lastErr);
}

/** Model output -> the [q, a, group, distractors] tuple the app already studies. */
function normaliseCard(c) {
  if (!c || typeof c !== "object") return null;
  const q = String(c.question || "").trim();
  const a = String(c.answer || "").trim();
  if (!q || !a) return null;

  const group = String(c.group || "concept").trim().toLowerCase().slice(0, 24) || "concept";

  const seen = new Set([a.toLowerCase()]);
  const distractors = (Array.isArray(c.distractors) ? c.distractors : [])
    .map((d) => String(d || "").trim())
    .filter((d) => {
      const k = d.toLowerCase();
      if (!d || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 4);

  // Fewer than 4 usable distractors: hand back what we have and let the app's
  // own pickDistractors() top it up from sibling cards.
  return distractors.length ? [q, a, group, distractors] : [q, a, group];
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
