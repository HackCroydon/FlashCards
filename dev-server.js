/**
 * Local dev server — `npm run dev`.
 *
 * Serves public/ and runs api/extract.js, so the scan feature works on your
 * machine with nothing installed but Node. No Vercel account, no CLI, no
 * dependencies. Opening public/index.html directly as a file cannot work,
 * because the scanner needs a server to hold the API key.
 *
 *   GEMINI_API_KEY=your-key npm run dev
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const PORT = Number(process.env.PORT) || 3000;

const { default: handler } = await import(pathToFileURL(join(HERE, "api", "extract.js")).href);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "\n  ⚠ GEMINI_API_KEY is not set — the site will load but scanning will fail.\n" +
    "    Get a key at https://aistudio.google.com/apikey then run:\n" +
    "      GEMINI_API_KEY=your-key npm run dev\n" +
    "    PowerShell:  $env:GEMINI_API_KEY=\"your-key\"; npm run dev\n"
  );
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/extract") {
    let raw = "";
    try {
      for await (const chunk of req) raw += chunk;
    } catch { /* client hung up */ }
    req.body = raw ? JSON.parse(raw) : {};

    // Minimal stand-in for the response object Vercel hands the function.
    const shim = {
      setHeader: (k, v) => res.setHeader(k, v),
      status(code) { res.statusCode = code; return shim; },
      json(body) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
        return shim;
      },
      end() { res.end(); return shim; },
    };

    const started = Date.now();
    try {
      await handler(req, shim);
    } catch (e) {
      console.error("  handler threw:", e);
      if (!res.writableEnded) { res.statusCode = 500; res.end('{"error":"Server error."}'); }
    }
    console.log(`  POST /api/extract -> ${res.statusCode} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }

  // Static files, confined to public/
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; return res.end("Forbidden"); }

  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.setHeader("Content-Type", TYPES[ext] || "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`\n  Study Deck running at http://localhost:${PORT}`);
  console.log(`  Scanning ${process.env.GEMINI_API_KEY ? "enabled" : "DISABLED (no key)"}\n`);
});
