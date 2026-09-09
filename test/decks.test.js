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


    /* The course deck ships with the app, so its data has to be sound: a
       distractor equal to its own answer makes a quiz question unanswerable,
       and a duplicate question wastes a card. */
    {
      const d = S.decks.find(x => x.id === "topic1-macromolecules");
      ok("the course deck is present", !!d && d.cards.length > 60,
         d ? d.cards.length + " cards" : "missing");
      ok("it is pinned as a course deck", !!d && d.pinned === true);
      ok("every card offers four distractors",
         d.cards.every(c => Array.isArray(c[3]) && c[3].length === 4));
      ok("no distractor repeats its own answer",
         d.cards.every(c => !c[3].some(x => x.trim().toLowerCase() === c[1].trim().toLowerCase())));
      ok("no distractor is repeated within a card",
         d.cards.every(c => new Set(c[3].map(x => x.trim().toLowerCase())).size === 4));
      ok("no question appears twice",
         new Set(d.cards.map(c => c[0].trim().toLowerCase())).size === d.cards.length);
      ok("every card has a group tag for quiz distractors",
         d.cards.every(c => typeof c[2] === "string" && c[2].length > 0));

      /* Explanations. The point of the card is understanding, so an
         explanation that merely restates the answer is worse than none. */
      ok("every course card explains itself", d.cards.every(c => !!c[5]),
         d.cards.filter(c => !c[5]).length + " without one");
      const flat = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
      ok("no explanation just restates its answer",
         d.cards.every(c => flat(c[5]) !== flat(c[1])));
      ok("no explanation is too short to say anything",
         d.cards.every(c => String(c[5]).length >= 40));
      ok("adding an explanation did not disturb the ids or distractors",
         d.cards.every(c => !!c[4] && Array.isArray(c[3]) && c[3].length === 4));
      ok("the seed is recorded so it is never re-added",
         Array.isArray(S.seeded) && S.seeded.length > 0, JSON.stringify(S.seeded));
    }


    /* Upgrading a starter someone already has. Keyed seeding is once-only so
       that deleting a starter sticks, which means anything added to it later
       never reaches people seeded earlier. The upgrade closes that gap without
       undoing anyone. */
    {
      const before = S.seeded.slice();
      const target = { id:"topic1-macromolecules" };
      const d0 = S.decks.find(x => x.id === target.id);
      const sample = STARTER_DECKS[0];

      // strip explanations and the upgrade key, as an older install would be
      d0.cards.forEach(c => { c[5] = null; });
      d0.cards[0][0] = "A question I reworded myself";
      d0.cards[1][5] = "My own note.";
      S.seeded = S.seeded.filter(k => !k.endsWith(":why"));

      upgradeStarters();

      ok("an older install gets its explanations backfilled",
         d0.cards.filter(c => c[5]).length > 60, d0.cards.filter(c => c[5]).length + " filled");
      ok("a card the user reworded is left alone", d0.cards[0][5] === null);
      ok("an explanation the user wrote is not overwritten", d0.cards[1][5] === "My own note.");
      ok("the upgrade records its own key",
         S.seeded.some(k => k === sample.seed + ":why"));

      // and it must not run a second time
      d0.cards[2][5] = null;
      upgradeStarters();
      ok("the upgrade runs once, not on every load", d0.cards[2][5] === null);

      S.seeded = before;
    }

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


    /* The card flip. This broke silently once: the entrance animation used
       animation-fill-mode:both on a transform keyframe, and an animation
       outranks a normal declaration, so .flipped never applied for as long as
       .in was on the element - which is the whole time you are looking at a
       card. Transitions are switched off here so the end state can be read
       immediately rather than mid-animation. */
    {
      const kill = document.createElement("style");
      kill.textContent = "*,*::before,*::after{transition:none !important}";
      document.head.appendChild(kill);

      openDeck(S.decks[0].id);
      await new Promise(r => setTimeout(r, 120));
      const card = document.getElementById("card");

      ok("an unflipped card has no transform",
         getComputedStyle(card).transform === "none",
         getComputedStyle(card).transform);

      card.click();
      const t = getComputedStyle(card).transform;
      const m = t.startsWith("matrix3d") ? t.slice(9, -1).split(",").map(Number) : null;
      ok("clicking the card actually turns it over",
         !!m && Math.round(m[0]) === -1 && Math.round(m[10]) === -1, t);

      card.click();
      ok("clicking again turns it back", getComputedStyle(card).transform === "none");

      // the entrance must never own transform, or it will beat the flip again
      const before = getComputedStyle(card).animationName;
      ok("the entrance animation is still present", before.includes("deal"), before);
      card.classList.add("flipped");
      const both = getComputedStyle(card).transform;
      ok("the entrance cannot override the flip",
         both.startsWith("matrix3d") && Math.round(both.slice(9,-1).split(",").map(Number)[0]) === -1,
         both);
      card.classList.remove("flipped");

      // advance() adds these; the CSS must define them or the swipe is dead
      for (const cls of ["exit-left", "exit-right"]) {
        card.classList.add(cls);
        const name = getComputedStyle(card).animationName;
        ok(cls + " maps to a real animation", name !== "none" && name !== "deal", name);
        card.classList.remove(cls);
      }

      kill.remove();
      renderHome();
    }


    /* The explanation must survive a share code, or a shared deck teaches
       nothing, and it must survive withId, which used to truncate to 5 slots. */
    {
      const wd = { id:"dW", cat:S.categories[0].id, name:"W", cards:[
        withId(["Q1","A1","term",["a","b","c","d"],null,"Because of the reason."])]};
      S.decks.push(wd);
      ok("withId keeps the explanation", wd.cards[0][5] === "Because of the reason.");
      ok("withId still assigns an id", !!wd.cards[0][4]);
      const wc = await makeCode("dW");
      const wb = await decodeShare(wc);
      ok("a share code carries the explanation", wb.cards[0][5] === "Because of the reason.",
         String(wb.cards[0][5]).slice(0, 30));
      S.decks = S.decks.filter(x => x.id !== "dW");
    }

    // Batching: a note set larger than one request must go up in chunks,
    // dedupe repeated headings across pages, and keep what succeeded when a
    // later batch fails rather than throwing the whole scan away.
    {
      const realFetch = window.fetch;
      let calls = 0, failAt = 0;
      window.fetch = async (u, o) => {
        if (!String(u).includes("/api/extract")) return realFetch(u, o);
        calls++;
        if (failAt && calls === failAt)
          return { ok:false, status:429, text: async () => JSON.stringify({ error:"quota" }) };
        return { ok:true, status:200, text: async () => JSON.stringify({
          deckName:"S", subject:"biology", model:"stub",
          cards:[["repeated heading","A","term",["a","b","c","d"]],
                 ["u"+calls,"A","term",["a","b","c","d"]]] }) };
      };
      const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const blob = await (await realFetch(png)).blob();
      const pages = n => Array.from({length:n}, (_,i) => new File([blob], "p"+i+".png", {type:"image/png"}));

      calls = 0; await runScan(pages(10));
      ok("10 pages are sent as 3 batches", calls === 3, "calls=" + calls);
      ok("repeated headings are deduped across batches",
         draft.cards.filter(c => c[0] === "repeated heading").length === 1);
      ok("every unique card is kept", draft.cards.length === 4, "got " + draft.cards.length);

      calls = 0; await runScan(pages(30));
      ok("over the page cap, nothing is uploaded", calls === 0, "calls=" + calls);

      calls = 0; failAt = 2; await runScan(pages(10));
      ok("a failed batch keeps the earlier ones", draft && draft.cards.length === 2,
         "kept " + (draft ? draft.cards.length : 0));
      ok("a partial scan says so", !!draft.partial);

      // Retry: a transient failure should be tried again, a permanent one
      // must not be (retrying burns the daily Gemini quota for nothing).
      calls = 0; failAt = 0;
      let plan = [];
      window.fetch = async (u, o) => {
        if (!String(u).includes("/api/extract")) return realFetch(u, o);
        const p = plan[calls++] || "ok";
        if (p === "soft") return { ok:false, status:503,
          text: async () => JSON.stringify({ error:"busy", retryable:true }) };
        if (p === "hard") return { ok:false, status:429,
          text: async () => JSON.stringify({ error:"quota gone", retryable:false }) };
        return { ok:true, status:200, text: async () => JSON.stringify({
          deckName:"S", subject:"biology", cards:[["q"+calls,"A","term",["a","b","c","d"]]] }) };
      };
      calls = 0; plan = ["soft"];
      await runScan(pages(4));
      ok("a transient failure is retried and then succeeds",
         calls === 2 && draft && draft.cards.length === 1, "calls=" + calls);

      calls = 0; plan = ["hard"];
      await runScan(pages(4));
      ok("a permanent failure is not retried", calls === 1, "calls=" + calls);

      calls = 0; plan = ["soft","soft","soft","soft"];
      await runScan(pages(4));
      ok("retries stop at the cap", calls === 3, "calls=" + calls);
      window.fetch = realFetch;
    }
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
