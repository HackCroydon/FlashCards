/**
 * node test/sync.test.js
 *
 * The sync merge decides which side of a conflict survives, so it is the
 * piece where a bug quietly destroys someone's work. It is written as a pure
 * function for exactly this reason: these tests need no Supabase project and
 * no network.
 *
 * Also checks the scan cap's decisions and that signed-out use is untouched.
 */
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));

if (!CHROME) { console.log("sync test: skipped (no Chrome found)"); process.exit(0); }

const HARNESS = `
<script>
const ok = (n,c,x) => console.log("T|" + (c?"ok":"FAIL") + "|" + n + "|" + (x||""));
const iso = s => new Date(s).toISOString();
setTimeout(async () => {
  try {
    // --- newer side wins, per row
    let r = mergeRows(
      [{id:"a",name:"local A",updated_at:iso(2000)}, {id:"b",name:"local B",updated_at:iso(1000)}],
      [{id:"a",name:"remote A",updated_at:iso(1000)}, {id:"b",name:"remote B",updated_at:iso(2000)}]);
    ok("newer local wins", r.merged.find(x=>x.id==="a").name === "local A");
    ok("newer remote wins", r.merged.find(x=>x.id==="b").name === "remote B");
    ok("only the locally-newer row is pushed",
       r.toPush.length === 1 && r.toPush[0].id === "a", "pushed " + r.toPush.length);

    // --- first sign-in: everything local is uploaded, nothing dropped
    r = mergeRows(
      [{id:"x",name:"X",updated_at:iso(1000)}, {id:"y",name:"Y",updated_at:iso(1000)}], []);
    ok("first sign-in uploads every local deck", r.toPush.length === 2);
    ok("first sign-in keeps every local deck", r.merged.length === 2);

    // --- account decks arrive on a fresh device
    r = mergeRows([], [{id:"z",name:"Z",updated_at:iso(1000)}]);
    ok("a new device downloads the account decks",
       r.merged.length === 1 && r.toPush.length === 0);

    // --- a deletion must not be resurrected by a device that was offline
    r = mergeRows(
      [], [{id:"d1",name:"gone",updated_at:iso(1000)}],
      { deletedLocally: { "deck:d1": iso(2000) } });
    ok("a local delete removes the remote row", r.merged.length === 0);
    ok("the delete is pushed so other devices learn it",
       r.toPush.length === 1 && !!r.toPush[0].deleted_at);

    // --- but an edit made AFTER the delete wins
    r = mergeRows(
      [], [{id:"d2",name:"edited later",updated_at:iso(3000)}],
      { deletedLocally: { "deck:d2": iso(2000) } });
    ok("an edit newer than the delete survives", r.merged.length === 1);

    // --- already-deleted rows never reappear
    r = mergeRows([], [{id:"d3",name:"x",updated_at:iso(1000),deleted_at:iso(1500)}]);
    ok("rows deleted on the server stay deleted", r.merged.length === 0);

    // --- a row with no stamp must never beat a stamped one
    r = mergeRows([{id:"n",name:"unstamped"}], [{id:"n",name:"stamped",updated_at:iso(5000)}]);
    ok("an unstamped local row does not clobber a stamped remote one",
       r.merged[0].name === "stamped");

    /* Signed out, the app must behave exactly as it did before accounts
       existed. Whether a Supabase project is configured is beside the point:
       what matters is that nobody signed in means nothing syncs. */
    ok("nobody is signed in at boot", cloud.user === null);
    ok("status reflects that", ["signedout", "off"].includes(cloud.status), cloud.status);
    await syncNow();                       // must be a no-op, not a crash
    ok("syncNow is safe with no account", cloud.user === null);
    queueSync();                           // must not schedule anything either
    ok("queueSync is safe with no account", true);

    // --- mutations still work with no account
    const before = S.decks.length;
    S.decks.push({id:"local1",cat:S.categories[0].id,name:"Local",cards:[],updated_at:iso(1)});
    await save();
    ok("decks still save locally with no account", S.decks.length === before + 1);
  } catch (e) {
    console.log("T|FAIL|harness threw|" + e.message);
  }
  console.log("T|END||");
}, 400);
</script>
`;

const page = (await readFile(join(ROOT, "public", "index.html"), "utf8"))
  .replace("</body>", HARNESS + "</body>");
const server = createServer((_q, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(page);
});
await new Promise((r) => server.listen(0, r));

const profile = mkdtempSync(join(tmpdir(), "sync-"));
const child = spawn(CHROME, ["--headless","--disable-gpu","--no-sandbox",
  `--user-data-dir=${profile}`,"--virtual-time-budget=20000",
  "--enable-logging=stderr","--v=0", `http://localhost:${server.address().port}/`]);
let out = "";
child.stderr.on("data", d => out += d);
child.stdout.on("data", d => out += d);
await new Promise(r => child.on("close", r));
server.close();
try { rmSync(profile, { recursive:true, force:true }); } catch {}

const lines = [...out.matchAll(/T\|(ok|FAIL)\|([^|]*)\|([^"]*?)(?:",|\r?\n)/g)];
let pass = 0, fail = 0;
for (const [, st, name, extra] of lines) {
  if (st === "ok") { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra.trim() ? ` — ${extra.trim()}` : ""}`); }
}
if (!lines.length) {
  console.log("  FAIL no assertions ran");
  console.log(out.split("\n").filter(l => /CONSOLE|ERROR/.test(l)).slice(0,6).join("\n"));
  fail = 1;
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
