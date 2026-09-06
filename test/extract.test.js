/**
 * node test/extract.test.js            -> offline tests, no key needed
 * GEMINI_API_KEY=... node test/extract.test.js --live
 *                                      -> also sends a real rendered page to Gemini
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import handler from "../api/extract.js";
import { notesPng, SAMPLE_NOTES } from "./make-notes-png.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Captured before the offline tests overwrite the env with a dummy key.
const REAL_KEY = process.env.GEMINI_API_KEY;
let pass = 0, fail = 0;

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}

/** Minimal stand-ins for Vercel's req/res. */
function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

const call = async (body, method = "POST") => {
  const res = mockRes();
  await handler({ method, headers: {}, socket: { remoteAddress: `1.2.3.${Math.random()}` }, body }, res);
  return res;
};

/** Fake a Gemini reply with the given parsed JSON payload. */
function stubGemini(payload, { status = 200, finishReason = "STOP" } = {}) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
    text: async () => JSON.stringify(payload),
  });
}

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const realFetch = globalThis.fetch;

async function offline() {
  console.log("\nInput validation");
  process.env.GEMINI_API_KEY = "test-key";

  check("rejects GET", (await call({}, "GET")).statusCode === 405);
  check("rejects empty image list", (await call({ images: [] })).statusCode === 400);
  check("rejects more than 5 pages",
    (await call({ images: Array(6).fill(PNG_1PX) })).statusCode === 400);

  const notDataUrl = await call({ images: ["https://example.com/x.png"] });
  check("rejects a plain URL", notDataUrl.statusCode === 400,
    `got ${notDataUrl.statusCode} ${JSON.stringify(notDataUrl.body)}`);

  const pdf = await call({ images: ["data:application/pdf;base64,AAAA"] });
  check("rejects a non-image mime", pdf.statusCode === 400 && /JPEG/.test(pdf.body.error));

  delete process.env.GEMINI_API_KEY;
  check("reports a missing server key", (await call({ images: [PNG_1PX] })).statusCode === 500);
  process.env.GEMINI_API_KEY = "test-key";

  console.log("\nCard normalisation");
  stubGemini({
    deckName: "Topic 4 — Enzymes",
    subject: "biology",
    cards: [
      { question: "What is an enzyme?", answer: "A biological catalyst.", group: "term",
        distractors: ["A type of sugar.", "A storage lipid.", "A nucleic acid.", "A mineral ion."] },
      // duplicate + echo of the real answer should both be dropped
      { question: "Optimum temp?", answer: "37 C", group: "number",
        distractors: ["37 C", "20 C", "20 C", "45 C", "100 C"] },
      { question: "", answer: "orphan", group: "x", distractors: [] },       // no question -> dropped
      { question: "No options?", answer: "Yes", group: "concept", distractors: [] },
    ],
  });

  const ok = await call({ images: [PNG_1PX] });
  check("returns 200", ok.statusCode === 200, JSON.stringify(ok.body));
  check("keeps the deck name", ok.body.deckName === "Topic 4 — Enzymes");
  check("drops the card with no question", ok.body.cards.length === 3,
    `got ${ok.body.cards.length}`);
  check("emits [q, a, group, distractors] tuples",
    Array.isArray(ok.body.cards[0]) && ok.body.cards[0].length === 4 &&
    ok.body.cards[0][0] === "What is an enzyme?" && ok.body.cards[0][3].length === 4);
  check("strips distractors equal to the answer and dedups",
    JSON.stringify(ok.body.cards[1][3]) === JSON.stringify(["20 C", "45 C", "100 C"]),
    JSON.stringify(ok.body.cards[1][3]));
  check("card with no usable distractors falls back to a 3-tuple",
    ok.body.cards[2].length === 3);

  console.log("\nError mapping");
  stubGemini({ cards: [] });
  check("empty card list -> 422", (await call({ images: [PNG_1PX] })).statusCode === 422);

  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "" });
  check("upstream 429 -> 429", (await call({ images: [PNG_1PX] })).statusCode === 429);

  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "denied" });
  const badKey = await call({ images: [PNG_1PX] });
  check("bad key -> 502 without leaking the key", badKey.statusCode === 502 && !/test-key/.test(JSON.stringify(badKey.body)));

  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ finishReason: "SAFETY" }] }), text: async () => "",
  });
  check("safety block -> 422", (await call({ images: [PNG_1PX] })).statusCode === 422);

  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] }),
    text: async () => "",
  });
  check("unparseable output -> 502", (await call({ images: [PNG_1PX] })).statusCode === 502);

  console.log("\nOverload handling");
  // 503 twice, then success: the scan should ride it out, not fail.
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls <= 2) return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    return {
      ok: true, status: 200,
      json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{
        text: JSON.stringify({ deckName: "D", subject: "biology", cards: [
          { question: "Q", answer: "A", group: "term", distractors: ["a", "b", "c", "d"] }] }),
      }] } }] }),
      text: async () => "",
    };
  };
  const retried = await call({ images: [PNG_1PX] });
  check("retries through a transient 503 and succeeds",
    retried.statusCode === 200 && calls === 3, `status ${retried.statusCode}, ${calls} calls`);

  // Permanently swamped: report the overload, not the last model's 404.
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" });
  const swamped = await call({ images: [PNG_1PX] });
  check("sustained overload -> 503, not a confusing model error",
    swamped.statusCode === 503 && /busy/i.test(swamped.body.error), JSON.stringify(swamped.body));

  // A model that hangs must not push us past Vercel's 60s function timeout.
  // Every attempt hangs here; the handler has to give up on its own.
  globalThis.fetch = (url, opt) =>
    new Promise((_, reject) => {
      opt.signal.addEventListener("abort", () => {
        const e = new Error("aborted"); e.name = "AbortError"; reject(e);
      });
    });
  const t0 = Date.now();
  const hung = await call({ images: [PNG_1PX] });
  const took = (Date.now() - t0) / 1000;
  check(`gives up before Vercel's 60s timeout (took ${took.toFixed(1)}s)`,
    took < 55 && hung.statusCode === 503, `status ${hung.statusCode}`);

  console.log("\nRate limit");
  // 404 rather than 500: a retryable status would make each call take seconds,
  // and the burst would outlast the limiter's own 60s window.
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  const res0 = mockRes();
  const burst = { method: "POST", headers: { "x-forwarded-for": "9.9.9.9" }, socket: {}, body: { images: [PNG_1PX] } };
  let limited = false;
  for (let i = 0; i < 9; i++) {
    const r = mockRes();
    await handler(burst, r);
    if (r.statusCode === 429) limited = true;
  }
  check("a burst from one IP eventually gets 429", limited);
  void res0;

  console.log("\nPNG fixture");
  const png = notesPng(SAMPLE_NOTES);
  check("renders a real PNG", png.slice(1, 4).toString("ascii") === "PNG" && png.length > 1000,
    `${png.length} bytes`);
  const out = join(HERE, "sample-notes.png");
  writeFileSync(out, png);
  console.log(`       wrote ${out} (${(png.length / 1024).toFixed(1)} KB)`);

  globalThis.fetch = realFetch;
}

async function live() {
  console.log("\nLive Gemini call");
  if (!REAL_KEY || REAL_KEY === "test-key") {
    console.log("  skip (set GEMINI_API_KEY to run)");
    return;
  }
  process.env.GEMINI_API_KEY = REAL_KEY; // offline() clobbered it
  globalThis.fetch = realFetch;

  const dataUrl = "data:image/png;base64," + notesPng(SAMPLE_NOTES).toString("base64");
  const t = Date.now();
  const res = await call({ images: [dataUrl], subject: "biology" });
  const secs = ((Date.now() - t) / 1000).toFixed(1);

  if (res.statusCode !== 200) {
    check(`live call succeeded (${secs}s)`, false, JSON.stringify(res.body));
    return;
  }
  check(`live call succeeded in ${secs}s using ${res.body.model}`, true);
  check("produced cards", res.body.cards.length >= 5, `got ${res.body.cards.length}`);
  check("every card is a valid tuple",
    res.body.cards.every((c) => Array.isArray(c) && typeof c[0] === "string" && c[0] && typeof c[1] === "string" && c[1]));
  check("most cards carry 4 distractors",
    res.body.cards.filter((c) => c[3]?.length === 4).length >= res.body.cards.length * 0.8);
  check("no distractor repeats its own answer",
    res.body.cards.every((c) => !c[3] || !c[3].some((d) => d.toLowerCase() === c[1].toLowerCase())));

  console.log(`\n  Deck: "${res.body.deckName}" (${res.body.subject}), ${res.body.cards.length} cards`);
  res.body.cards.slice(0, 4).forEach((c, i) => {
    console.log(`   ${i + 1}. Q: ${c[0]}\n      A: ${c[1]}   [${c[2]}]`);
    if (c[3]) console.log(`      wrong: ${c[3].join(" | ")}`);
  });
}

await offline();
if (process.argv.includes("--live")) await live();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
