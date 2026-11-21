#!/usr/bin/env node
/**
 * Optional v0.2.6 network probe (same setup as headless_check.mjs: puppeteer-core + Chrome/Chromium).
 * Loads index.html over file:// (plain and ?demo=1), hovers the AI Playground credit link,
 * and fails if ANY request leaves file:/blob:/data:, or if storage is written at load.
 *   CHROME_PATH=/path/to/chrome node tests/network_probe.mjs
 */
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
let puppeteer;
try { puppeteer = (await import("puppeteer-core")).default; } catch (e) { console.log("PROBE_SKIP: puppeteer-core is not installed."); process.exit(0); }
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
if (!fs.existsSync(CHROME)) { console.log("PROBE_SKIP: Chrome/Chromium not found at " + CHROME); process.exit(0); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const b = await puppeteer.launch({executablePath: CHROME, headless:"new", args:["--no-sandbox"]});
const p = await b.newPage(); const reqs=[]; const all=[]; const errs=[];
p.on("request", r=>{ all.push(r.url()); if(!/^(file|blob|data):/.test(r.url())) reqs.push(r.url()); });
p.on("pageerror", e=>errs.push(String(e))); p.on("console", m=>{ if(m.type()==="error") errs.push(m.text()); });
for (const q of ["", "?demo=1"]) {
  await p.goto(pathToFileURL(path.join(ROOT,"index.html")).href+q,{waitUntil:"networkidle0"});
  await new Promise(r=>setTimeout(r,2500));
}
await p.hover("a.brand-link"); await new Promise(r=>setTimeout(r,1500)); // hover must not prefetch
const link = await p.$eval("a.brand-link", a=>({href:a.href, text:a.textContent, rel:a.rel, visible: a.offsetWidth>0 && a.offsetHeight>0, credit:a.parentElement.textContent}));
const ls = await p.evaluate(()=>({local:Object.keys(localStorage), session:Object.keys(sessionStorage)}));
const nonFile = all.filter(u=>!u.startsWith("file:"));
const result = {externalRequests:reqs, nonFileRequests:nonFile, totalRequests:all.length, errors:errs, storage:ls, link};
console.log(JSON.stringify(result,null,1)); await b.close();
const ok = reqs.length===0 && errs.length===0 && !ls.local.length && !ls.session.length && link.visible && link.href==="https://www.aiplayground.spot/music-master";
console.log(ok ? "PROBE_ZERO_OUTBOUND_OK" : "PROBE_FAILED"); process.exit(ok?0:1);
