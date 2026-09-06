/**
 * node test/picker.test.js
 *
 * Drives the real file-picker path in a headless browser: puts a file on the
 * <input type="file">, fires the change event the browser would fire, and
 * checks a scan actually starts.
 *
 * This exists because that path shipped broken. The change handler read
 * e.target.files AFTER setting e.target.value = "", and input.files is live —
 * so the list was empty by the time it was checked and picking a photo did
 * nothing at all. Every other test called runScan() directly and sailed past
 * it. Requires Chrome; skips cleanly if none is found.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { notesPng, SAMPLE_NOTES } from "./make-notes-png.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));

if (!CHROME) {
  console.log("picker test: skipped (no Chrome found)");
  process.exit(0);
}

const HARNESS = `
<script>
const origFetch = window.fetch.bind(window);
window.fetch = async (u, o) => u.toString().includes("/api/extract")
  ? { ok: true, status: 200, text: async () => JSON.stringify({
      deckName: "Stub", subject: "biology", model: "stub",
      cards: [["Q1","A1","term",["a","b","c","d"]], ["Q2","A2","term",["e","f","g","h"]]] }) }
  : origFetch(u, o);
(async () => {
  const blob = await origFetch("notes.png").then(r => r.blob());
  const dt = new DataTransfer();
  dt.items.add(new File([blob], "notes.png", { type: "image/png" }));
  const input = document.getElementById("scanInput");
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise(r => setTimeout(r, 1500));
  console.log("RESULT:" + document.querySelectorAll(".rcard").length);
})();
</script>
`;

const page = (await readFile(join(ROOT, "public", "index.html"), "utf8"))
  .replace("</body>", HARNESS + "</body>");
const png = notesPng(SAMPLE_NOTES);

const server = createServer((req, res) => {
  if (req.url.startsWith("/notes.png")) {
    res.setHeader("Content-Type", "image/png");
    return res.end(png);
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(page);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), "picker-"));
const child = spawn(CHROME, [
  "--headless", "--disable-gpu", "--no-sandbox",
  `--user-data-dir=${profile}`,
  "--virtual-time-budget=20000",
  "--enable-logging=stderr", "--v=0",
  `http://localhost:${port}/`,
]);

let out = "";
child.stderr.on("data", (d) => (out += d));
child.stdout.on("data", (d) => (out += d));
const code = await new Promise((r) => child.on("close", r));
server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch {}

const m = /RESULT:(\d+)/.exec(out);
const cards = m ? Number(m[1]) : -1;

if (cards > 0) {
  console.log(`  ok   picking a file starts a scan (${cards} cards reached the review screen)`);
  console.log("\n1 passed, 0 failed\n");
  process.exit(0);
}
console.log(`  FAIL picking a file did not start a scan (cards=${cards}, chrome exit ${code})`);
console.log(out.split("\n").filter((l) => /CONSOLE|ERROR/.test(l)).slice(0, 8).join("\n"));
console.log("\n0 passed, 1 failed\n");
process.exit(1);
