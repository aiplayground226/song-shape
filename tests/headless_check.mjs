#!/usr/bin/env node
/**
 * Optional headless check (not required to run the app or the core tests).
 * Opens index.html over file:// — no local server — using puppeteer-core
 * and a system Chrome. This file is not an app dependency.
 *
 *   node tests/headless_check.mjs
 *
 * If puppeteer-core is not installed, or Chrome is not found, this script
 * exits 0 with a HEADLESS_SKIP message instead of failing.
 *
 * To run it:
 *   npm install puppeteer-core
 *   # Chrome default: /usr/bin/google-chrome-stable
 *   # or set CHROME_PATH to a Chromium / Chrome binary
 *   node tests/headless_check.mjs
 */
import path from "path";
import fs from "fs";
import os from "os";
import { pathToFileURL } from "url";

function skip(reason) {
  console.log("HEADLESS_SKIP: " + reason);
  console.log("This optional file:// browser check is not required to run the app or node tests/test_strokes.js.");
  console.log("To run it: install puppeteer-core (`npm install puppeteer-core`) and have Chrome or Chromium available");
  console.log("(default path /usr/bin/google-chrome-stable, or set the CHROME_PATH environment variable).");
  process.exit(0);
}

let puppeteer;
try {
  puppeteer = (await import("puppeteer-core")).default;
} catch (err) {
  skip("puppeteer-core is not installed.");
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const INDEX = pathToFileURL(path.join(ROOT, "index.html")).href;
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
// Screenshots go to a temp folder, never into the repository.
const outDir = process.env.SONGSHAPE_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "songshape-headless-"));

if (!fs.existsSync(CHROME)) {
  skip("Chrome/Chromium was not found at " + CHROME + ".");
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 1440, height: 960, deviceScaleFactor: 1 }
});

const results = {};

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);

  // 1) Open over file:// with the built-in demo (no fetch, no server)
  await page.goto(INDEX + "?demo=1", { waitUntil: "load" });
  await page.waitForFunction(() => window.__songshape);
  await page.waitForFunction(() => {
    const s = window.__songshape && window.__songshape.getSession();
    return s && s.strokes && s.strokes.length === 2 && s.gaps && s.gaps.length === 1;
  });
  results.fileProtocol = new URL(page.url()).protocol;
  results.demo = await page.evaluate(() => {
    const s = window.__songshape.getSession();
    return {
      strokes: s.strokes.length,
      gaps: s.gaps.length,
      gapMs: s.gaps[0] && s.gaps[0].duration_ms,
      breath: s.gaps[0] && s.gaps[0].breath,
      audioName: window.__songshape.getAudioName(),
      duration: window.__songshape.getDuration(),
      waveform: window.__songshape.hasWaveform()
    };
  });

  // 2) Ask an AI prompt from the loaded demo
  results.aiPrompt = await page.evaluate(() => window.__songshape.getAiPrompt());
  if (!/not measured pitch/i.test(results.aiPrompt) || !/Help me write Suno lyrics/.test(results.aiPrompt)) {
    throw new Error("Ask an AI prompt missing required wording");
  }
  if (!/0\.50 s to 2\.50 s/.test(results.aiPrompt) || !/400 ms/.test(results.aiPrompt)) {
    throw new Error("Ask an AI prompt missing demo timing");
  }

  // 3) File picker: wav and mp3 are accepted (v0.2.7); other formats are rejected
  const wavInput = await page.$("#file-audio");
  await wavInput.uploadFile(path.join(ROOT, "demo/fictional_tone.wav"));
  // The bundled demo already uses this file name, so also wait for the file-picker
  // status line. Otherwise this can pass on the demo load and snapshot a mid-reload duration of 0.
  await page.waitForFunction(() => {
    const status = document.getElementById("status");
    const s = window.__songshape;
    return status && /Loaded fictional_tone\.wav/.test(status.textContent || "")
      && s && s.getAudioName() === "fictional_tone.wav" && s.getDuration() > 6.4 && s.hasWaveform();
  });
  results.wavLoad = await page.evaluate(() => ({
    name: window.__songshape.getAudioName(),
    duration: window.__songshape.getDuration(),
    waveform: window.__songshape.hasWaveform()
  }));

  // v0.2.7: MP3 is decoded locally by the browser (decodeAudioData), no libraries.
  const mp3Input = await page.$("#file-audio");
  await mp3Input.uploadFile(path.join(ROOT, "demo/fictional_tone.mp3"));
  await page.waitForFunction(() => {
    const s = window.__songshape;
    return s && s.getAudioName() === "fictional_tone.mp3" && s.getDuration() > 6.4 && s.hasWaveform();
  });
  results.mp3Load = await page.evaluate(() => ({
    name: window.__songshape.getAudioName(),
    duration: window.__songshape.getDuration(),
    waveform: window.__songshape.hasWaveform()
  }));
  // Unsupported type is rejected and leaves the current audio in place.
  const os = await import("os");
  const bogus = path.join(os.tmpdir(), "songshape-not-audio.ogg");
  fs.writeFileSync(bogus, "not audio");
  await mp3Input.uploadFile(bogus);
  await page.waitForFunction(() => {
    const status = document.getElementById("status");
    return status && /accepts \.wav and \.mp3/.test(status.textContent || "");
  });
  results.unsupportedRejected = await page.evaluate(() => ({
    status: document.getElementById("status") && document.getElementById("status").textContent,
    stillMp3: window.__songshape.getAudioName() === "fictional_tone.mp3"
  }));
  if (!results.unsupportedRejected.stillMp3) throw new Error("An unsupported file replaced the loaded audio");
  // Built-in demo MP3 button (embedded bytes, works over file:// without fetch).
  await page.click("#btn-load-demo-mp3");
  await page.waitForFunction(() => /Loaded the fictional demo tone as MP3/.test((document.getElementById("status") || {}).textContent || ""));
  results.demoMp3 = await page.evaluate(() => ({ duration: window.__songshape.getDuration(), waveform: window.__songshape.hasWaveform() }));
  if (!(results.demoMp3.duration > 6.4) || !results.demoMp3.waveform) throw new Error("Demo MP3 button did not decode");
  // Return to WAV for the drag-and-drop check below.
  await wavInput.uploadFile(path.join(ROOT, "demo/fictional_tone.wav"));
  await page.waitForFunction(() => window.__songshape.getAudioName() === "fictional_tone.wav" && window.__songshape.hasWaveform());

  const wavB64 = fs.readFileSync(path.join(ROOT, "demo/fictional_tone.wav")).toString("base64");
  await page.evaluate(async (b64) => {
    const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([binary], "fictional_tone.wav", { type: "audio/wav" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    document.getElementById("app").dispatchEvent(ev);
  }, wavB64);
  await page.waitForFunction(() => {
    const s = window.__songshape;
    return s && s.getAudioName() === "fictional_tone.wav" && s.getDuration() > 6.4 && s.hasWaveform();
  });
  results.wavDrop = await page.evaluate(() => ({
    name: window.__songshape.getAudioName(),
    duration: window.__songshape.getDuration(),
    waveform: window.__songshape.hasWaveform()
  }));

  // Reload demo traces for the screenshot (audio may have been replaced)
  await page.evaluate(async () => {
    await window.__songshape.loadDemo(true);
  });
  await page.waitForFunction(() => {
    const s = window.__songshape.getSession();
    return s && s.strokes && s.strokes.length === 2;
  });
  await page.evaluate(() => {
    window.__songshape.seekSafely(2.7);
    window.__songshape.draw();
  });
  await new Promise((r) => setTimeout(r, 400));
  // v0.2.8 guided panel (v0.2.9: incoming lyric tags must not reach the sheet), AI off: Run all -> pause after 1 -> pause after 2 -> sheet.
  page.on("dialog", (d) => d.accept());
  await page.evaluate(() => {
    window.__songshape.resetTrace();
    const ref = document.getElementById("lyrics-text");
    ref.value = "[Verse]\nThe fire rises\nThen we return";
    ref.dispatchEvent(new Event("input")); ref.dispatchEvent(new Event("change"));
    document.getElementById("new-lyrics").value = "[Verse]\n[Belting]\nThe river calls me\nHome through the storm (whispered)";
    document.getElementById("btn-g-run-all").click();
  });
  const gState = () => page.evaluate(() => [1, 2, 3, 4].map((n) => document.getElementById("g-status-" + n).dataset.state));
  const waitPause = async () => {
    await page.waitForFunction(() => !document.getElementById("btn-g-continue").hidden || /Stopped/.test(document.getElementById("g-message").textContent), { timeout: 60000 });
    return page.evaluate(() => document.getElementById("g-message").textContent);
  };
  results.guided = { pause1: await waitPause(), after1: await gState() };
  await page.evaluate(() => document.getElementById("btn-g-continue").click());
  await page.waitForFunction(() => document.getElementById("g-status-2").dataset.state !== "running" && document.getElementById("g-status-2").dataset.state !== "todo", { timeout: 60000 });
  results.guided.pause2 = await waitPause();
  results.guided.after2 = await gState();
  results.guided.stage2 = await page.evaluate(() => document.getElementById("g-status-2").textContent);
  await page.evaluate(() => document.getElementById("btn-g-continue").click());
  await page.waitForFunction(() => /All four stages finished|Stopped/.test(document.getElementById("g-message").textContent), { timeout: 60000 });
  results.guided.final = await gState();
  results.guided.sheet = await page.evaluate(() => document.getElementById("map-output").value);
  results.guided.message = await page.evaluate(() => document.getElementById("g-message").textContent);
  if (!/Paused after stage 1/.test(results.guided.pause1) || !/Paused after stage 2/.test(results.guided.pause2)) throw new Error("Guided Run all did not pause after stages 1 and 2: " + JSON.stringify(results.guided));
  if (/Belting|whispered/.test(results.guided.sheet)) throw new Error("Incoming lyric tags leaked into the sheet (v0.2.9 rule)");
  if (!/CPU measured/.test(results.guided.stage2)) throw new Error("Guided stage 2 did not use the CPU path: " + results.guided.stage2);
  if (!/All four stages finished/.test(results.guided.message) || !/\[Delivery:/.test(results.guided.sheet) || !/The river calls me/.test(results.guided.sheet)) throw new Error("Guided chain did not produce a tagged sheet: " + JSON.stringify(results.guided).slice(0, 600));

  const shot = path.join(outDir, "screenshot_trace.png");
  await page.screenshot({ path: shot, fullPage: true });
  results.screenshot = shot;

  const summary = {
    fileProtocol: results.fileProtocol,
    demo: results.demo,
    wavLoad: results.wavLoad,
    mp3Load: results.mp3Load,
    unsupportedRejected: results.unsupportedRejected,
    demoMp3: results.demoMp3,
    wavDrop: results.wavDrop,
    aiPromptChars: results.aiPrompt.length,
    aiHasSunoAsk: /Help me write Suno lyrics/.test(results.aiPrompt),
    guided: { pause1: results.guided.pause1, after1: results.guided.after1, stage2: results.guided.stage2, final: results.guided.final, sheetChars: results.guided.sheet.length },
    screenshot: results.screenshot
  };
  console.log(JSON.stringify(summary, null, 2));
  if (results.fileProtocol !== "file:") throw new Error("Did not run over file://");
  if (results.demo.strokes !== 2 || results.demo.gapMs !== 400) throw new Error("Demo traces failed on file://");
  if (results.wavLoad.duration < 6.4 || !results.wavDrop.waveform) {
    throw new Error("Audio load failed on file://");
  }
  if (!results.mp3Load || results.mp3Load.duration < 6.4 || !results.mp3Load.waveform) {
    throw new Error("MP3 did not load and decode on file://");
  }
  console.log("HEADLESS_FILE_OK");
} catch (err) {
  console.error("HEADLESS_FAIL", err);
  try {
    const pages = await browser.pages();
    if (pages[0]) {
      const dump = path.join(outDir, "screenshot_error.png");
      await pages[0].screenshot({ path: dump, fullPage: true });
      console.error("error screenshot", dump);
    }
  } catch (e) {}
  process.exit(1);
} finally {
  await browser.close();
}
