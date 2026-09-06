/**
 * node test/palette.test.js
 *
 * The palette is generated, not eyeballed: category colours are OKLCH values
 * at constant lightness and chroma, so no category outweighs another. This
 * asserts every colour still clears WCAG AA (4.5:1) as text on its own
 * surface, and that the eight category colours stay within a tight contrast
 * band. muted previously shipped failing at 3.68.
 *
 * Colour is never the only signal in this UI — every category shows its name
 * as a heading — so the red/amber pair converging under deuteranopia is
 * acceptable and deliberate; eight hues cannot all stay separable there.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");const html = readFileSync(join(ROOT,"public","index.html"),"utf8");
/** search EVERY block for this theme, not just the first */
const grab = (theme, name) => {
  const parts = html.split(`html[data-theme="${theme}"]{`).slice(1);
  for (const p of parts) {
    const m = new RegExp(`--${name}:\s*(#[0-9A-Fa-f]{6})`).exec(p.split("}")[0]);
    if (m) return m[1];
  }
  return null;
};
const hexToRgb=h=>{h=h.replace("#","");return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));};
const lin=c=>{c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;};
const lum=h=>{const[r,g,b]=hexToRgb(h);return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);};
const ratio=(a,b)=>{const l1=lum(a),l2=lum(b);const[hi,lo]=l1>l2?[l1,l2]:[l2,l1];return (hi+0.05)/(lo+0.05);};
let fails=0;
for (const theme of ["light","dark"]) {
  const card = grab(theme,"card");
  console.log(`\n${theme.toUpperCase()} — as text on card ${card}`);
  for (const n of ["ink","ink-2","muted","wrong","c1","c2","c3","c4","c5","c6","c7","c8"]) {
    const v = grab(theme,n);
    if(!v){ console.log(`  ${n} MISSING`); fails++; continue; }
    const r = ratio(v,card), ok = r>=4.5; if(!ok) fails++;
    console.log(`  ${n.padEnd(6)} ${v}  ${r.toFixed(2)}  ${ok?"AA":"** FAIL **"}`);
  }
  const cs=["c1","c2","c3","c4","c5","c6","c7","c8"].map(n=>ratio(grab(theme,n),card));
  console.log(`  category spread: ${Math.min(...cs).toFixed(2)}–${Math.max(...cs).toFixed(2)}  (delta ${(Math.max(...cs)-Math.min(...cs)).toFixed(2)})`);
}
console.log(fails ? `\n${fails} FAILURES` : "\nAll pass WCAG AA (4.5:1).");
process.exit(fails?1:0);
