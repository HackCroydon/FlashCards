/**
 * GET /api/health
 *
 * Open this in a browser to find out why scanning isn't working. It answers,
 * in order, the things that actually go wrong:
 *   - is the function running at all?
 *   - is GEMINI_API_KEY set on the server?
 *   - is the key valid?
 *   - which models can it reach, and is there quota left today?
 *
 * Never returns the key itself — only whether one is present and its shape.
 *
 * GET /api/health?probe=1 additionally spends ONE request against the first
 * reachable model to prove end-to-end generation works. That costs quota
 * (free tier is ~20/day/model), so it is opt-in.
 */

const MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
].filter(Boolean);

const TIMEOUT_MS = 12_000;

async function timed(fn) {
  const t = Date.now();
  try {
    const value = await fn();
    return { ...value, ms: Date.now() - t };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "timed out" : String(e?.message || e), ms: Date.now() - t };
  }
}

function withTimeout(ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const key = process.env.GEMINI_API_KEY;
  const out = {
    function: "running",
    time: new Date().toISOString(),
    node: process.version,
    key: key
      ? { present: true, length: key.length, starts: key.slice(0, 5) + "…", ends: "…" + key.slice(-4) }
      : { present: false },
    hint: null,
    models: [],
  };

  if (!key) {
    /* A misspelled variable name looks correct at a glance and fails silently,
       so list any key-ish names that ARE present. Names only — never values. */
    const near = Object.keys(process.env)
      .filter((k) => /gemini|gemeni|google|api.?key|flashcard/i.test(k))
      .sort();
    out.similarNamesFound = near.length ? near : "none";
    out.hint = near.length
      ? `GEMINI_API_KEY is not set, but these similar names exist: ${near.join(", ")}. ` +
        "If one of those is your key, the name is misspelled — it must be exactly GEMINI_API_KEY. " +
        "Rename it, then redeploy."
      : "GEMINI_API_KEY is not set, and no similarly named variable exists either, so it " +
        "was not saved to this project. In the Vercel project serving THIS url: " +
        "Settings -> Environment Variables -> add GEMINI_API_KEY with Production ticked -> Save, " +
        "then Deployments -> ... -> Redeploy. Locally: GEMINI_API_KEY=your-key npm run dev";
    return res.status(200).json(out);
  }

  // Can we list models? Proves the key is valid without spending generate quota.
  const list = await timed(async () => {
    const t = withTimeout(TIMEOUT_MS);
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
        headers: { "x-goog-api-key": key },
        signal: t.signal,
      });
      const body = await r.text();
      if (!r.ok) return { ok: false, status: r.status, error: body.slice(0, 300) };
      const names = (JSON.parse(body).models || []).map((m) => m.name.replace("models/", ""));
      return { ok: true, status: r.status, count: names.length, names };
    } finally {
      t.done();
    }
  });

  out.keyValid = list.ok;
  out.listModels = { ok: list.ok, status: list.status ?? null, ms: list.ms, error: list.error ?? null };

  if (!list.ok) {
    out.hint =
      list.status === 400 || list.status === 403
        ? "The key was rejected. It may be invalid, revoked, or restricted to other APIs. Create a fresh one at https://aistudio.google.com/apikey"
        : "Could not reach Gemini to validate the key. See listModels.error.";
    return res.status(200).json(out);
  }

  const available = new Set(list.names || []);
  out.models = MODELS.map((m) => ({ model: m, listed: available.has(m) }));

  if (!out.models.some((m) => m.listed)) {
    out.hint =
      "None of the configured models are available to this key. Set GEMINI_MODEL to one of: " +
      (list.names || []).filter((n) => n.includes("flash")).slice(0, 8).join(", ");
    return res.status(200).json(out);
  }

  if (req.query?.probe === "1" || /[?&]probe=1/.test(req.url || "")) {
    for (const entry of out.models) {
      if (!entry.listed) continue;
      const probe = await timed(async () => {
        const t = withTimeout(TIMEOUT_MS);
        try {
          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${entry.model}:generateContent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": key },
              signal: t.signal,
              body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with: ok" }] }] }),
            }
          );
          const body = await r.text();
          return { ok: r.ok, status: r.status, error: r.ok ? null : body.slice(0, 220) };
        } finally {
          t.done();
        }
      });
      entry.probe = { ok: probe.ok, status: probe.status ?? null, ms: probe.ms, error: probe.error ?? null };
      if (probe.ok) break;                 // one success is enough
      if (probe.status !== 429 && probe.status !== 503) break;
    }

    const quotaHit = out.models.some((m) => m.probe?.status === 429);
    const busy = out.models.some((m) => m.probe?.status === 503);
    const anyOk = out.models.some((m) => m.probe?.ok);

    out.hint = anyOk
      ? "Everything checks out — generation works. If scanning still fails, the problem is in the browser: check the page is served over http(s), not opened as a file."
      : quotaHit
      ? "Daily free quota is used up (free tier is about 20 requests per day per model). It resets tomorrow, or enable billing on the Google Cloud project."
      : busy
      ? "Gemini is returning 503 (high demand). This is upstream and usually temporary — retry shortly."
      : "Generation failed. See models[].probe.error.";
  } else {
    out.hint = "Key is valid and models are reachable. Add ?probe=1 to spend one request testing generation for real.";
  }

  return res.status(200).json(out);
}
