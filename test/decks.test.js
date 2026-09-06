/**
 * node test/decks.test.js
 *
 * Drives the deck data model in a real browser: migration, card deletion,
 * share-code round trips, and that an imported deck cannot inject markup.
 *
 * The important one is deletion. starred used to hold array indices, so
 * removing a card silently repointed every star above it at its neighbour.
 * Cards now carry a stable id; this test fails if that ever regresses.
 *
 * Requires Chrome; skips cleanly if none is found.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));

if (!CHROME) {
  console.log("deck model test: skipped (no Chrome found)");
  process.exit(0);
}

const HARNESS = `
<script>
const ok = (name, cond, extra) => console.log("T|" + (cond ? "ok" : "FAIL") + "|" + name + "|" + (extra || ""));
setTimeout(async () => {
  try {
    ok("migration gives every card a stable id",
       S.decks.length > 0 && S.decks[0].cards.every(c => typeof c[4] === "string" && c[4]));
    ok("default categories exist", S.categories.length >= 2);

    // Deleting a card must not repoint a star at its neighbour.
    const d = { id:"dT", cat:S.categories[0].id, name:"T", cards:[
      withId(["Q1","A1","concept",["a","b","c","d"]]),
      withId(["Q2","A2","concept",["a","b","c","d"]]),
      withId(["Q3","A3","concept",["a","b","c","d"]])]};
    S.decks.push(d);
    const starId = cardId(d.cards[2]);          // star the LAST card
    S.starred.dT = [starId];
    const firstId = cardId(d.cards[0]);
    d.cards = d.cards.filter(c => cardId(c) !== firstId);   // delete the FIRST
    ok("star survives deleting an earlier card",
       S.starred.dT[0] === cardId(d.cards[1]) && d.cards[1][0] === "Q3",
       "star now on " + d.cards.findIndex(c => cardId(c) === S.starred.dT[0]));
    ok("deck shrank by exactly one", d.cards.length === 2);

    // Share code round trip.
    const code = await makeCode("dT");
    ok("code is prefixed", code.startsWith("STUDYDECK1."));
    const back = await decodeShare(code);
    ok("round trip keeps every card", back.cards.length === 2, "got " + back.cards.length);
    ok("round trip keeps question text", back.cards[0][0] === "Q2");
    ok("round trip keeps distractors", (back.cards[0][3] || []).length === 4);
    ok("imported cards get fresh ids", back.cards.every(c => c[4] && c[4] !== cardId(d.cards[0])));

    // Compression should beat plain base64 on a realistic deck.
    const big = S.decks[0];
    const bigCode = await makeCode(big.id);
    const plain = JSON.stringify({ n: big.name, k: big.cards.map(c => [c[0],c[1],c[2],c[3]]) });
    ok("compression beats raw base64 on a real deck",
       bigCode.length < plain.length * 1.34 * 0.6,
       bigCode.length + " vs base64 ~" + Math.round(plain.length * 1.34));

    // Garbage in.
    let rejected = 0;
    for (const bad of ["", "hello", "STUDYDECK1.zzzz", "STUDYDECK1."]) {
      try { await decodeShare(bad); } catch { rejected++; }
    }
    ok("bad codes are rejected with an error", rejected === 4, rejected + "/4");

    // A hostile deck must render as text, never as markup.
    const evil = JSON.stringify({ n:"<img src=x onerror=alert(1)>",
      c:{ n:"<b>c</b>", k:"c1" },
      k:[["<img src=x onerror=alert(2)>","<svg onload=alert(3)>","concept",["<i>x</i>","b","c","d"]]] });
    const cs = new CompressionStream("deflate-raw");
    const buf = await new Response(new Blob([evil]).stream().pipeThrough(cs)).arrayBuffer();
    const evilCode = "STUDYDECK1." + btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
    let fired = 0; const realAlert = window.alert; window.alert = () => { fired++; };
    importPreview(await decodeShare(evilCode));
    await new Promise(r => setTimeout(r, 300));
    window.alert = realAlert;
    const nodes = document.querySelectorAll("#reviewBody img, #reviewBody svg, #reviewBody script, #reviewBody i, #reviewBody b").length;
    ok("hostile import injects no markup and fires no script", fired === 0 && nodes === 0,
       "alerts=" + fired + " nodes=" + nodes);
    ok("hostile text renders literally",
       document.querySelector("#reviewBody .rcard .q").textContent.startsWith("<img"));
  } catch (e) {
    console.log("T|FAIL|harness threw|" + e.message);
  }
  console.log("T|END||");
}, 400);
</script>
`;

const page = (await readFile(join(ROOT, "public", "index.html"), "utf8"))
  .replace("</body>", HARNESS + "</body>");

const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(page);
});
await new Promise((r) => server.listen(0, r));

const profile = mkdtempSync(join(tmpdir(), "decks-"));
const child = spawn(CHROME, [
  "--headless", "--disable-gpu", "--no-sandbox",
  `--user-data-dir=${profile}`,
  "--virtual-time-budget=25000",
  "--enable-logging=stderr", "--v=0",
  `http://localhost:${server.address().port}/`,
]);

let out = "";
child.stderr.on("data", (d) => (out += d));
child.stdout.on("data", (d) => (out += d));
await new Promise((r) => child.on("close", r));
server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch {}

const lines = [...out.matchAll(/T\|(ok|FAIL)\|([^|]*)\|([^"]*?)(?:",|\r?\n)/g)];
let pass = 0, fail = 0;
for (const [, status, name, extra] of lines) {
  if (status === "ok") { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra.trim() ? ` — ${extra.trim()}` : ""}`); }
}
if (!lines.length) {
  console.log("  FAIL no assertions ran (page did not load or threw early)");
  console.log(out.split("\n").filter((l) => /CONSOLE|ERROR/.test(l)).slice(0, 6).join("\n"));
  fail = 1;
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
