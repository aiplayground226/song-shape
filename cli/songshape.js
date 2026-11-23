#!/usr/bin/env node
/**
 * Song Shape — headless CLI for agents and local use.
 * No extra packages. Reads WAV natively (16-bit PCM or 32-bit float); MP3 only via
 * a user-supplied ffmpeg (--ffmpeg <path>), because Node has no built-in MP3 decoder.
 *
 *   node cli/songshape.js analyze <lead.wav|.mp3> <reference.txt> <replacement.txt> -o <folder> [--provider ollama]
 *   node cli/songshape.js batch <folder> -o <out> --lyrics-dir <folder> --new-lyrics <file|folder>
 *   node cli/songshape.js ai-batch <folder> -o <out> --lyrics-dir <folder> --new-lyrics <file|folder> --provider ollama
 *   node cli/songshape.js ai-sheet <project.json> <replacement.txt> --provider ollama
 *   node cli/songshape.js confirm <project.json> -o <new.json> --all
 *   node cli/songshape.js ai-draft <audio> --endpoint <url> --model <name> [-o out.json]
 *
 *   node cli/songshape.js draft <audio.wav> [-o out.json]
 *   node cli/songshape.js sheet <trace.json> [lyrics.txt] [-o out.txt]
 *   node cli/songshape.js map <reference.json> <new_lyrics.txt> [-o out.txt]
 *   node cli/songshape.js validate <file.json>
 *   node cli/songshape.js request <reference.json> <new_lyrics.txt> [-o out.txt]
 *
 * Run with no arguments for every option (AI providers, context file, GPU/tool hooks).
 * `songshape` is also available as a small wrapper script in this folder.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const SS = require("../js/vocal-handoff.js");
Object.assign(SS, require("../js/contour-clean.js")); // v0.2.11 adaptive gate + contour cleanup
require("../js/ai-learn.js"); // composes AI learning onto the same SS object
require("../js/ai-context.js"); // default SONG_SHAPE_AI_CONTEXT.md (embedded)
require("../js/ai-chain.js");   // v0.2.8 chain helpers (context, chunked drafts, sheet check)

function usage() {
  return [
    "Song Shape v" + SS.APP_VERSION + " CLI",
    "",
    "The full 4-stage chain runs on the CPU alone. A connected AI (local or API) and optional GPU tools",
    "only make individual stages better; they are never required.",
    "",
    "Lyrics: Song Shape never fetches lyrics. Give it text files you made: <reference.txt> = the original",
    "lyrics (if you have them), <replacement.txt> = your new lyrics. Plain lines, one sung line per line,",
    "a blank line between sections. [Bracket] tags and (performance cues) in either file are ignored;",
    "the sheet uses only Song Shape's own tags ([Verse]/[Chorus] from the structure, [Delivery: ...] from the contour).",
    "",
    "Full chain (1 place words -> 2 draft shape -> 3 fit new lyrics -> 4 tagged sheet):",
    "  node cli/songshape.js analyze <lead.wav|.mp3> <reference.txt> <replacement.txt> -o <folder> [chain options] [AI options]",
    "  node cli/songshape.js batch <audio-folder> -o <out-folder> --lyrics-dir <folder> --new-lyrics <file|folder> [chain options]",
    "  node cli/songshape.js ai-batch <audio-folder> -o <out-folder> --lyrics-dir <folder> --new-lyrics <file|folder> --provider ollama [AI options]",
    "",
    "Single steps:",
    "  node cli/songshape.js draft <audio.wav> [-o out.json]",
    "  node cli/songshape.js handoff <project.json> <replacement.txt> -o <folder> [--exclude-unconfirmed-ai]",
    "  node cli/songshape.js confirm <project.json> -o <new-project.json> (--all | --stroke <id>)",
    "  node cli/songshape.js ai-sheet <project.json> <replacement.txt> [-o sheet.txt] [AI options]",
    "  node cli/songshape.js sheet <trace.json> [lyrics.txt] [-o out.txt]",
    "  node cli/songshape.js map <reference.json> <new_lyrics.txt> [-o out.txt]",
    "  node cli/songshape.js request <reference.json> <new_lyrics.txt> [-o out.txt]",
    "  node cli/songshape.js validate <file.json>",
    "  node cli/songshape.js ai-draft <audio.wav|.mp3> --provider ollama [-o out.json] [AI options]",
    "  node cli/songshape.js ai-batch <audio-folder> -o <out-folder> [AI options]   (no --lyrics-dir: stage 2 only, as in v0.2.7)",
    "",
    "analyze  Full chain for one song. CPU only by default; with AI options the AI drafts stage 2 per line window",
    "         (pitch grid + word timings + syllable counts) and writes an extra AI sheet in stage 4.",
    "         Always writes the CPU tagged-lyrics.txt. AI strokes stay tagged needs_review until confirmed.",
    "batch    Full chain for every song in a folder, CPU only (add AI options to use AI). Lyrics are matched by",
    "         file name (song.wav <-> song.txt). Never overwrites; --resume skips finished songs; per-song log.",
    "ai-batch With --lyrics-dir: same full chain, AI required. Without it: the v0.2.7 stage-2-only trace batch.",
    "handoff  Visual report + word-specific tags from an annotated project.",
    "confirm  Mark AI-drafted strokes as reviewed (removes needs_review, adds ai_confirmed). Writes a new file.",
    "ai-sheet Stage 4 only: the same send-and-check path as the app's \"Send to connected AI\" button.",
    "draft    Measured pitch + RMS draft from a WAV file (no AI).",
    "sheet    Rule-based Suno lyric sheet from a trace and optional lyrics file.",
    "map      Map NEW lyrics onto a reference trace (rule-based sheet + style prompt).",
    "request  Ready-to-paste AI request for the same Map my lyrics workflow (nothing is sent).",
    "validate Strict JSON schema check. Rejects non-finite numbers and secret-like keys.",
    "ai-draft AI drafts a hand-style trace for one song from local audio features (+ optional examples).",
    "         Running an AI command is the explicit send action. Nothing is sent by any other command.",
    "",
    "Chain options (analyze, batch, ai-batch --lyrics-dir):",
    "  --ffmpeg <path>          Decode .mp3 through this ffmpeg executable (Node has no MP3 decoder)",
    "  --alignment <words.json> analyze: import word times from a local aligner instead of the CPU estimate",
    "  --alignment-dir <folder> batch: per-song alignment files matched by name (song.json)",
    "  --exclude-unconfirmed-ai Leave unconfirmed AI strokes out of stages 3-4 (default: include and flag them)",
    "  --no-ai-sheet            With AI: skip the extra AI sheet in stage 4 (the CPU sheet is always written)",
    "  --send-word-text         With AI: also send the reference word text in stage 2 (default: timings + syllables only)",
    "  --chunk-seconds <n>      With AI: stage-2 window length (default 12)",
    "  --lyrics-dir <folder>    batch: reference lyrics, one .txt per song, matched by file name",
    "  --new-lyrics <file|dir>  batch: one replacement lyrics file for all songs, or a folder matched by name",
    "  --recursive / --limit <n> / --resume   batch: subfolders, at most n songs, continue a batch",
    "",
    "Optional GPU / external tools (opt-in; nothing is detected or run unless you give a path; nothing is installed):",
    "  --separator <path>       Vocal separation before analysis, e.g. demucs (preset args used when the file is named demucs)",
    "  --separator-args \"...\"  Arguments; placeholders {audio} {out} {outdir} {name}",
    "  --separator-output <tpl> Where the vocals file appears (default {out})",
    "  --aligner <path>         Forced aligner run per song; must write word JSON (same format as --alignment)",
    "  --aligner-args \"...\"    Arguments; placeholders {audio} {lyrics} {out} {outdir} {name}",
    "  --aligner-output <tpl>   Where the word JSON appears (default {out})",
    "  --hook-timeout <seconds> Per tool run (default 1800). Tools run without a shell.",
    "",
    "AI options:",
    "  --provider <name>        ollama | lmstudio | llamacpp | openai-compatible | xai | openai (fills endpoint/model)",
    "  --endpoint <url>         OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1 (Ollama)",
    "  --model <name>           Model name on that server, e.g. qwen2.5:7b (API providers: type the exact model id)",
    "  --context <file.md>      Use this AI context file instead of the built-in SONG_SHAPE_AI_CONTEXT.md",
    "  --examples <a.json,b.json>  Finished Song Shape projects with hand traces to learn from (max 5 used)",
    "  --examples-dir <folder>  Use every .json project in a folder as examples (max 5 used)",
    "  --allow-remote           Required for any non-loopback endpoint, including xai/openai (data leaves this computer)",
    "  --api-key-env <VAR>      Read an API key from this environment variable (never from the command line).",
    "                           xai defaults to XAI_API_KEY, openai to OPENAI_API_KEY.",
    "  --json-mode / --no-json-mode  Ask the server for JSON output (on by default for the ollama, llamacpp, xai and openai presets)",
    "  --timeout <seconds>      Per-request timeout (default 300)",
    "",
    "Every AI request starts its system prompt with the AI context file (version recorded in QUALITY_CHECK.json).",
    "The browser app opens .wav and .mp3 directly. CPU word placement is a rough estimate; review it by ear."
  ].join("\n");
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function writeOut(file, text) {
  if (file) {
    fs.writeFileSync(file, text);
    console.log("Wrote " + file);
  } else {
    process.stdout.write(text);
    if (text.slice(-1) !== "\n") process.stdout.write("\n");
  }
}

function loadSession(file) {
  const text = fs.readFileSync(file, "utf8");
  return SS.parseSessionText(text, Buffer.byteLength(text));
}

function cmdDraft(file, outFile) {
  if (!SS.isWavExtension(file)) {
    throw new Error(SS.WAV_ONLY_MESSAGE);
  }
  const buf = fs.readFileSync(file);
  SS.validateWavAudio(file, buf);
  const wav = SS.readWavPcm(buf);
  const frames = SS.analyzePitchLoudness(wav.samples, wav.sampleRate, {silenceRms: SS.adaptiveSilenceRms(wav.samples, wav.sampleRate)});
  const draft = SS.buildDraft(frames, { cleanup: true });
  const session = SS.createSession();
  session.audio = {
    name: path.basename(file),
    included_in_export: false,
    duration_ms: Math.round((wav.samples.length / wav.sampleRate) * 1000)
  };
  session.draft = draft;
  session.notes =
    "Measured-pitch draft (YIN + RMS) generated by the Song Shape CLI. " +
    "This is not a hand trace of perceived delivery. Review and adjust before use.";
  const json = SS.sessionToJSON(session);
  if (SS.exportContainsSecrets(json)) {
    throw new Error("Internal error: export contained secret-like keys.");
  }
  writeOut(outFile, JSON.stringify(json, null, 2) + "\n");
  console.error(
    "Draft: " + draft.strokes.length + " stroke(s), " +
    draft.gaps.length + " gap(s), baseline ≈ " + Math.round(draft.baseline_hz) + " Hz."
  );
}

function maybeLoadLyrics(session, lyricsFile) {
  if (!lyricsFile) return;
  const text = fs.readFileSync(lyricsFile, "utf8");
  if (!session.lyrics || !session.lyrics.words || !session.lyrics.words.length) {
    SS.setLyrics(session, SS.cleanLyricInput(text).text);
  }
}

function cmdSheet(traceFile, lyricsFile, outFile) {
  const session = loadSession(traceFile);
  maybeLoadLyrics(session, lyricsFile);
  const sheet = SS.buildLyricSheet(session);
  if (sheet.warning && !sheet.text) throw new Error(sheet.warning);
  writeOut(outFile, sheet.text + (sheet.text.slice(-1) === "\n" ? "" : "\n"));
}

function cmdMap(refFile, lyricsFile, outFile) {
  const session = loadSession(refFile);
  const mine = fs.readFileSync(lyricsFile, "utf8");
  const mapped = SS.buildMappedSheet(session, mine, {
    title: session.reference && session.reference.title,
    artist: session.reference && session.reference.artist
  });
  const text = mapped.text + "\n\n" + mapped.stylePrompt + "\n";
  writeOut(outFile, text);
}

function cmdRequest(refFile, lyricsFile, outFile) {
  const session = loadSession(refFile);
  const mine = fs.readFileSync(lyricsFile, "utf8");
  const request = SS.buildMapRequest(session, mine, {
    title: session.reference && session.reference.title,
    artist: session.reference && session.reference.artist
  });
  writeOut(outFile, request + (request.slice(-1) === "\n" ? "" : "\n"));
}

function cmdValidate(file) {
  const text = fs.readFileSync(file, "utf8");
  const session = SS.parseSessionText(text, Buffer.byteLength(text));
  const json = SS.sessionToJSON(session);
  if (SS.exportContainsSecrets(json)) {
    throw new Error("This file looks like it contains secret-like keys and is not a valid export.");
  }
  console.log("OK  " + file);
  console.log("    schema " + session.schema_version + ", app " + (session.app_version || "?"));
  console.log(
    "    " + session.strokes.length + " hand stroke(s), " +
    (session.anchors ? session.anchors.length : 0) + " anchor(s), " +
    (session.draft && session.draft.strokes ? session.draft.strokes.length : 0) + " draft stroke(s)."
  );
}

// ---------------------------------------------------------------- v0.2.8 output set
function buildRecords(session, newLyrics, opts) {
  opts = opts || {};
  const mapOpts = { excludeUnconfirmedAi: !!opts.excludeUnconfirmedAi };
  const map = SS.buildPerformanceMap(SS.sessionToJSON(session), mapOpts);
  const transfer = SS.buildTransfer(map, newLyrics);
  const handoff = SS.makeHandoff(map, transfer);
  const dirs = SS.exportDirections(map, transfer);
  const strokes = session.strokes || [];
  const records = {
    'project.json': JSON.stringify(SS.sessionToJSON(session), null, 2),
    'performance-map.json': JSON.stringify(map, null, 2),
    'ai-handoff.json': JSON.stringify(handoff.payload, null, 2),
    'ai-request.txt': handoff.prompt,
    'tagged-lyrics.txt': handoff.lyrics + '\n\n[Style prompt]\n' + dirs.style + '\n',
    'visual-map.svg': SS.svgPicture(map, handoff),
    'visual-handoff.html': SS.htmlReport(map, handoff)
  };
  const quality = {
    version: SS.APP_VERSION, input_audio_uploaded: false,
    total_source_words: session.lyrics.words.length, total_anchors: session.anchors.length,
    machine_pitch_strokes: strokes.filter(s => (s.annotations || []).includes('machine_measured_pitch_draft')).length,
    ai_drafted_strokes: strokes.filter(s => SS.isAiStroke(s)).length,
    ai_unconfirmed_strokes: SS.countUnconfirmedAi(session),
    ai_unconfirmed_excluded: !!opts.excludeUnconfirmedAi,
    source_word_timings_verified: false, lead_voice_identity_verified: false,
    review_lines: handoff.rows.filter(r => r.status === 'needs_review').length,
    warnings: handoff.warnings,
    limits: 'Energy timing is NOT forced alignment; measured frequency is NOT subjective intensity. Singers in harmony may confuse F0. Target syllable fits are drafts. AI strokes are proposals until confirmed.'
  };
  return { records, quality, handoff, map };
}
function writeRecords(folder, records, quality) {
  if (!folder) throw new Error('Provide an output folder with -o (do not use an existing nonempty output folder).');
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new Error('Output folder already contains files. Use a new folder; no files were overwritten.');
  fs.mkdirSync(folder, { recursive: true });
  const all = Object.assign({}, records, { 'QUALITY_CHECK.json': JSON.stringify(quality, null, 2) });
  for (const [filename, body] of Object.entries(all)) fs.writeFileSync(path.join(folder, filename), body + '\n', { encoding: 'utf8', flag: 'wx' });
  return Object.keys(all).length;
}
function outputs(folder, session, newLyrics, opts) {
  const built = buildRecords(session, newLyrics, opts);
  const n = writeRecords(folder, built.records, built.quality);
  console.log('Created ' + n + ' offline artifacts in ' + folder);
  console.log('AI handoff: ai-request.txt + visual-map.svg (or visual-handoff.html).');
  console.log('All proposed source word placements and sampled contours require review.');
}
function waveformFromSamples(samples,sr){
  const hop=Math.max(1,Math.round(sr/100));const n=Math.ceil(samples.length/hop);
  const peaks=new Float32Array(n);
  for(let i=0;i<n;i++){
    let peak=0;for(let j=i*hop;j<Math.min(samples.length,(i+1)*hop);j++)peak=Math.max(peak,Math.abs(samples[j]));
    peaks[i]=peak;
  }
  return {peaks,duration:samples.length/sr,sampleRate:sr};
}

// ---------------------------------------------------------------- v0.2.8 optional GPU/tool hooks
// Opt-in only: nothing is detected or run unless the user passes an executable path.
function splitArgs(template) {
  const out = []; let cur = ''; let quote = null; let any = false;
  for (const ch of String(template || '')) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else cur += ch;
  }
  if (quote) throw new Error('Unbalanced quote in hook arguments.');
  if (cur || any) out.push(cur);
  return out;
}
function fillTemplate(s, vars) {
  return String(s).replace(/\{(audio|lyrics|out|outdir|name)\}/g, (m, k) => vars[k] != null ? vars[k] : m);
}
const HOOK_PRESETS = {
  // Verify against your installed version: `demucs --help`.
  demucs: { args: '--two-stems=vocals -o {outdir} {audio}', output: '{outdir}/htdemucs/{name}/vocals.wav' }
};
function hookConfig(kind) {
  const exe = arg('--' + kind, null);
  if (!exe) return null;
  if (!fs.existsSync(exe)) throw new Error('--' + kind + ' path not found: ' + exe + ' (give the full path to the executable).');
  const known = Object.keys(HOOK_PRESETS).find(k => path.basename(exe).toLowerCase().replace(/\.(exe|cmd|bat)$/, '') === k);
  const preset = known ? HOOK_PRESETS[known] : null;
  const args = arg('--' + kind + '-args', preset ? preset.args : null);
  if (!args) throw new Error('--' + kind + ' needs --' + kind + '-args "<arguments with {audio} {lyrics} {out} {outdir} {name}>".');
  const output = arg('--' + kind + '-output', preset ? preset.output : '{out}');
  return { kind, exe, args, output, detected: known || 'generic', timeoutMs: Number(arg('--hook-timeout', '1800')) * 1000 };
}
function runHook(cfg, vars) {
  const cp = require('child_process');
  const argv = splitArgs(cfg.args).map(a => fillTemplate(a, vars));
  const r = cp.spawnSync(cfg.exe, argv, { shell: false, timeout: cfg.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error(cfg.kind + ' could not run: ' + r.error.message);
  if (r.status !== 0) throw new Error(cfg.kind + ' exited with ' + r.status + ': ' + String(r.stderr || '').trim().slice(-300));
  const produced = fillTemplate(cfg.output, vars);
  if (!fs.existsSync(produced)) throw new Error(cfg.kind + ' finished but its output was not found at ' + produced + ' (set --' + cfg.kind + '-output).');
  return produced;
}

// ---------------------------------------------------------------- v0.2.8 full chain (CPU first, AI optional)
function isFatalAiError(err) {
  return /blocked|connection is off|Set a base URL|valid HTTP|opt in/i.test(String(err && err.message || err));
}
async function runChain(audioPath, opts) {
  const os = require('os');
  const log = { stages: {} };
  const t0 = Date.now();
  const audio = decodeAudioFile(audioPath, opts.ffmpeg);
  const durationMs = Math.round((audio.samples.length / audio.sampleRate) * 1000);
  const name = path.basename(audioPath).replace(/\.(wav|mp3)$/i, '');
  let analysis = audio;
  let vocalsPath = null;
  let tmp = null;
  const tmpDir = () => (tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'songshape-hook-')));
  try {
    if (opts.separator) {
      const vocals = runHook(opts.separator, { audio: path.resolve(audioPath), outdir: tmpDir(), out: path.join(tmpDir(), 'vocals.wav'), name });
      analysis = decodeAudioFile(vocals, opts.ffmpeg);
      vocalsPath = vocals;
      log.stages.separate = { tool: opts.separator.detected, ok: true };
    }
    const session = SS.createSession();
    session.audio = { name: path.basename(audioPath), included_in_export: false, duration_ms: durationMs };
    // Stage 1: place the original words.
    if (opts.newLyrics) {
      const nc = SS.cleanLyricInput(opts.newLyrics);
      log.lyric_input = Object.assign(log.lyric_input || {}, { new_lyrics: { ignored_tags: nc.ignored_tags.length, stripped_cues: nc.stripped_cues.length, ambiguous: nc.ambiguous } });
    }
    if (opts.refLyrics) {
      const rc = SS.cleanLyricInput(opts.refLyrics);
      log.lyric_input = Object.assign(log.lyric_input || {}, { original_lyrics: { ignored_tags: rc.ignored_tags.length, stripped_cues: rc.stripped_cues.length, ambiguous: rc.ambiguous } });
      SS.setLyrics(session, rc.text);
      let proposal, source;
      if (opts.aligner) {
        const lyr = path.join(tmpDir(), 'lyrics.txt'); fs.writeFileSync(lyr, opts.refLyrics);
        const out = runHook(opts.aligner, { audio: path.resolve(vocalsPath || audioPath), lyrics: lyr, outdir: tmpDir(), out: path.join(tmpDir(), 'alignment.json'), name });
        proposal = SS.proposeImportedAlignment(session, JSON.parse(fs.readFileSync(out, 'utf8'))); source = 'aligner:' + opts.aligner.detected;
      } else if (opts.alignmentFile) {
        proposal = SS.proposeImportedAlignment(session, JSON.parse(fs.readFileSync(opts.alignmentFile, 'utf8'))); source = 'alignment_file';
      } else {
        proposal = SS.estimateWordTimes(session, waveformFromSamples(analysis.samples, analysis.sampleRate), {}); source = 'cpu_energy_estimate';
      }
      const applied = SS.applyProposals(session, proposal);
      log.stages.place_words = { source, anchors: session.anchors.length, words: session.lyrics.words.length, added: applied.added };
    } else {
      log.stages.place_words = { skipped: 'no reference lyrics' };
    }
    // Stage 2: shape. CPU always; AI improves it when configured.
    const frames = SS.analyzePitchLoudness(analysis.samples, analysis.sampleRate, { winMs: 40, hopMs: 30, minHz: 80, maxHz: 1000, silenceRms: SS.adaptiveSilenceRms(analysis.samples, analysis.sampleRate) });
    const draft = SS.buildDraft(frames, { cleanup: true });
    session.draft = draft;
    if (opts.ai) {
      const t2 = Date.now();
      try {
        const r = await SS.runChunkedTraceDraft(session, draft, durationMs, opts.examples || [], {
          send: (messages) => SS.sendAiChatAsync(messages, { jsonMode: opts.jsonMode, timeoutMs: opts.timeoutMs }),
          includeWordText: !!opts.includeWordText, chunkMs: opts.chunkMs, isFatal: isFatalAiError
        });
        const extra = ['ai-chunked'];
        if (r.used_word_timing) extra.push('ai-word-timing');
        if (r.word_text_sent) extra.push('ai-word-text');
        SS.applyAiTraceDraft(session, r.strokes, { model: opts.ai.model, examples: (opts.examples || []).length, extraTags: extra });
        log.stages.draft_shape = { mode: 'ai', model: opts.ai.model, chunks: r.chunks, failed_chunks: r.failed.length, strokes: r.strokes.length,
          used_word_timing: r.used_word_timing, word_text_sent: r.word_text_sent, ms: Date.now() - t2, failed: r.failed.slice(0, 5) };
      } catch (err) {
        if (isFatalAiError(err)) throw err;
        SS.acceptDraft(session);
        log.stages.draft_shape = { mode: 'cpu_fallback', ai_error: String(err && err.message || err).slice(0, 300), strokes: session.strokes.length, ms: Date.now() - t2 };
      }
    } else {
      SS.acceptDraft(session);
      log.stages.draft_shape = { mode: 'cpu', strokes: session.strokes.length };
    }
    // Stage 3 + 4: fit the new lyrics; CPU sheet always, AI sheet optional.
    let records, quality;
    if (opts.newLyrics) {
      session.replacement_lyrics = opts.newLyrics;
      const built = buildRecords(session, opts.newLyrics, { excludeUnconfirmedAi: opts.excludeUnconfirmedAi });
      records = built.records; quality = built.quality;
      log.stages.fit_lyrics = { lines: built.handoff.rows.length, review_lines: quality.review_lines };
      log.stages.final_sheet = { cpu_sheet: 'tagged-lyrics.txt', ai_sheet: 'off' };
      if (opts.ai && opts.aiSheet) {
        const t4 = Date.now();
        try {
          const res = await SS.sendAndCheckSheet(built.handoff.prompt, opts.newLyrics,
            (messages) => SS.sendAiChatAsync(messages, { timeoutMs: opts.timeoutMs }));
          records['ai-tagged-lyrics.txt'] = res.text;
          records['ai-sheet-check.json'] = JSON.stringify(Object.assign({ model: opts.ai.model, context: SS.getAiContextInfo() }, res.check), null, 2);
          log.stages.final_sheet = { cpu_sheet: 'tagged-lyrics.txt', ai_sheet: 'ai-tagged-lyrics.txt', missing_lines: res.check.missing_lines.length,
            missing_blocks: res.check.missing_blocks, format_warnings: res.check.format_warnings, ms: Date.now() - t4 };
        } catch (err) {
          if (isFatalAiError(err)) throw err;
          log.stages.final_sheet = { cpu_sheet: 'tagged-lyrics.txt', ai_sheet: 'failed', ai_error: String(err && err.message || err).slice(0, 300) };
        }
      }
    } else {
      records = { 'project.json': JSON.stringify(SS.sessionToJSON(session), null, 2) };
      quality = { version: SS.APP_VERSION, input_audio_uploaded: false, note: 'No replacement lyrics: stages 3-4 skipped.' };
      log.stages.fit_lyrics = { skipped: 'no replacement lyrics' };
      log.stages.final_sheet = { skipped: 'no replacement lyrics' };
    }
    if (opts.ai) log.ai_context = SS.getAiContextInfo();
    log.duration_ms = durationMs; log.total_ms = Date.now() - t0;
    quality.chain = log;
    const json = JSON.parse(records['project.json']);
    if (SS.exportContainsSecrets(json)) throw new Error('Internal error: export contained secret-like keys.');
    return { records, quality, log, session };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function chainOptions(ai) {
  return {
    ai, examples: ai ? loadExamples() : [],
    ffmpeg: arg('--ffmpeg', null),
    alignmentFile: arg('--alignment', null),
    aligner: hookConfig('aligner'),
    separator: hookConfig('separator'),
    includeWordText: hasFlag('--send-word-text'),
    chunkMs: Number(arg('--chunk-seconds', '12')) * 1000,
    aiSheet: !hasFlag('--no-ai-sheet'),
    excludeUnconfirmedAi: hasFlag('--exclude-unconfirmed-ai'),
    jsonMode: ai ? ai.jsonMode : false,
    timeoutMs: Number(arg('--timeout', '300')) * 1000
  };
}

async function cmdAnalyze(file, refFile, newFile, outputDir) {
  if (!file || !refFile || !newFile || !outputDir) throw new Error('analyze requires <lead.wav|.mp3> <reference.txt> <replacement.txt> -o <folder>');
  if (!SS.audioKindFromName(file)) throw new Error(SS.SUPPORTED_AUDIO_MESSAGE);
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length) throw new Error('Output folder already contains files. Use a new folder; no files were overwritten.');
  const ai = configureAi({ optional: true });
  const opts = Object.assign(chainOptions(ai), { refLyrics: fs.readFileSync(refFile, 'utf8'), newLyrics: fs.readFileSync(newFile, 'utf8') });
  console.error('Song Shape chain for ' + path.basename(file) + ': ' + (ai ? 'CPU + AI (' + ai.model + ' at ' + (ai.local ? 'local ' : 'REMOTE ') + ai.endpoint + ')' : 'CPU only') + '…');
  const r = await runChain(file, opts);
  const n = writeRecords(outputDir, r.records, r.quality);
  console.log('Created ' + n + ' offline artifacts in ' + outputDir);
  console.log('Stages: ' + Object.entries(r.log.stages).map(([k, v]) => k + '=' + (k === 'final_sheet' && v.cpu_sheet ? 'cpu' + (v.ai_sheet && v.ai_sheet !== 'off' ? '+ai(' + v.ai_sheet + ')' : '') : (v.mode || v.source || (v.skipped ? 'skipped' : 'ok')))).join(', '));
  console.log('All proposed source word placements and sampled contours require review.');
}
function cmdHandoff(traceFile,newFile,outputDir){
  if(!traceFile||!newFile||!outputDir)throw new Error('handoff requires <project.json> <replacement.txt> -o <folder>');
  const session=loadSession(traceFile);
  outputs(outputDir,session,fs.readFileSync(newFile,'utf8'),{excludeUnconfirmedAi:hasFlag('--exclude-unconfirmed-ai')});
}

async function cmdAiSheet(projectFile, newFile, outFile) {
  if (!projectFile || !newFile || projectFile === '-o' || newFile === '-o') throw new Error('ai-sheet requires <project.json> <replacement.txt> [-o out.txt] --endpoint/--provider …');
  if (outFile && fs.existsSync(outFile)) throw new Error('Output file already exists; choose a new name. Nothing was overwritten.');
  const ai = configureAi();
  const session = loadSession(projectFile);
  const newLyrics = fs.readFileSync(newFile, 'utf8');
  const built = buildRecords(session, newLyrics, { excludeUnconfirmedAi: hasFlag('--exclude-unconfirmed-ai') });
  console.error('Sending the stage 3-4 handoff (new lyrics + contour events; no audio, no reference lyrics) to ' + (ai.local ? 'local ' : 'REMOTE ') + ai.endpoint + ' (' + ai.model + ')…');
  const res = await SS.sendAndCheckSheet(built.handoff.prompt, newLyrics, (m) => SS.sendAiChatAsync(m, { timeoutMs: Number(arg('--timeout', '300')) * 1000 }));
  if (outFile) { fs.writeFileSync(outFile, res.text + '\n', { flag: 'wx' }); console.error('Wrote ' + outFile); }
  else process.stdout.write(res.text + '\n');
  console.error('Check: ' + (res.check.ok ? 'all ' + res.check.lyric_lines + ' lyric lines present' : res.check.missing_lines.length + ' lyric line(s) missing — review: ' + res.check.missing_lines.slice(0, 3).join(' | ')) +
    (res.check.missing_blocks.length ? '; missing block(s): ' + res.check.missing_blocks.join(', ') : '') +
    (res.check.format_warnings && res.check.format_warnings.length ? '; format: ' + res.check.format_warnings.join('; ') : '') + '. Context ' + (SS.getAiContextInfo().version || SS.getAiContextInfo().label) + '.');
}

function cmdConfirm(projectFile, outFile) {
  if (!projectFile || !outFile) throw new Error('confirm requires <project.json> -o <new.json> (--all or --stroke <id>)');
  if (fs.existsSync(outFile)) throw new Error('Output file already exists; choose a new name. Nothing was overwritten.');
  const session = loadSession(projectFile);
  let n;
  if (hasFlag('--all')) n = SS.confirmAllAiStrokes(session);
  else if (arg('--stroke', null)) n = SS.confirmAiStroke(session, arg('--stroke', null)) ? 1 : 0;
  else throw new Error('confirm needs --all or --stroke <id>.');
  fs.writeFileSync(outFile, JSON.stringify(SS.sessionToJSON(session), null, 2) + '\n', { flag: 'wx' });
  console.log('Confirmed ' + n + ' AI-drafted stroke(s); ' + SS.countUnconfirmedAi(session) + ' still unconfirmed. Wrote ' + outFile);
}

// ---------------------------------------------------------------- v0.2.7 AI drafting
function hasFlag(name) { return process.argv.indexOf(name) >= 0; }

function decodeAudioFile(file, ffmpeg) {
  const kind = SS.audioKindFromName(file);
  if (kind === "wav") {
    const buf = fs.readFileSync(file);
    SS.validateWavAudio(file, buf);
    const wav = SS.readWavPcm(buf);
    return { samples: wav.samples, sampleRate: wav.sampleRate };
  }
  if (kind === "mp3") {
    if (!ffmpeg) throw new Error("MP3 needs --ffmpeg <path> on the command line (the browser app decodes MP3 itself).");
    const head = Buffer.alloc(10);
    const fd = fs.openSync(file, "r"); fs.readSync(fd, head, 0, 10, 0); fs.closeSync(fd);
    if (!SS.isMp3Header(head)) throw new Error("Not an MP3 file: " + path.basename(file));
    const cp = require("child_process");
    const r = cp.spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-i", file, "-f", "f32le", "-ac", "1", "-ar", "22050", "pipe:1"],
      { maxBuffer: 1024 * 1024 * 1024, shell: false });
    if (r.error) throw new Error("Could not run ffmpeg: " + r.error.message);
    if (r.status !== 0) throw new Error("ffmpeg could not decode " + path.basename(file) + ": " + String(r.stderr || "").trim().slice(0, 200));
    const b = r.stdout;
    const samples = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength - (b.byteLength % 4))));
    return { samples, sampleRate: 22050 };
  }
  throw new Error("Unsupported audio file: " + path.basename(file));
}

function loadExamples() {
  const files = [];
  const list = arg("--examples", null);
  if (list) list.split(",").map((x) => x.trim()).filter(Boolean).forEach((f) => files.push(f));
  const dir = arg("--examples-dir", null);
  if (dir) fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort().forEach((f) => files.push(path.join(dir, f)));
  const examples = [];
  files.forEach((f) => {
    if (examples.length >= SS.AI_MAX_EXAMPLES) return;
    const session = loadSession(f);
    examples.push(SS.exampleFromSession(session, path.basename(f)));
  });
  if (files.length > SS.AI_MAX_EXAMPLES) console.error("Using the first " + SS.AI_MAX_EXAMPLES + " of " + files.length + " example files.");
  return examples;
}

function loadContextOverride() {
  const file = arg("--context", null);
  if (!file) return;
  const st = fs.statSync(file);
  if (st.size > 64000) throw new Error("--context file is larger than 64,000 bytes.");
  const info = SS.setAiContextOverride(fs.readFileSync(file, "utf8"), path.basename(file));
  console.error("AI context: " + info.label + " (override" + (info.version ? ", version " + info.version : "") + ").");
}

/**
 * AI settings from --provider / --endpoint / --model. Returns null when optional
 * and no AI was requested (the CPU-only chain still runs).
 */
function configureAi(o) {
  o = o || {};
  const providerName = arg("--provider", null);
  const preset = providerName ? SS.getAiPreset(providerName) : null;
  if (providerName && !preset) throw new Error("Unknown --provider " + providerName + ". Use one of: " + Object.keys(SS.AI_PRESETS).join(", ") + ".");
  const endpoint = arg("--endpoint", preset && preset.baseUrl ? preset.baseUrl : null);
  const model = arg("--model", preset && preset.model ? preset.model : null);
  if (!endpoint && !model && !providerName && o.optional) return null;
  if (!endpoint) throw new Error("AI commands need --endpoint <url> (or --provider <name>).");
  if (!model) throw new Error("AI commands need --model <name>" + (preset && preset.remote ? " (the exact model id from your " + preset.name + " account)" : "") + ".");
  const local = SS.isAiLoopbackEndpoint(endpoint);
  if (!local && !hasFlag("--allow-remote")) {
    throw new Error("Non-local endpoint " + endpoint + " needs --allow-remote (song features would leave this computer).");
  }
  const keyVar = arg("--api-key-env", preset && preset.keyEnv && (preset.remote || !local) ? preset.keyEnv : null);
  const apiKey = keyVar ? (process.env[keyVar] || "") : "";
  if (keyVar && !apiKey) throw new Error("Environment variable " + keyVar + " is empty. Set it to your API key (it is never written to any file).");
  loadContextOverride();
  SS.setAiConfig({ enabled: true, baseUrl: endpoint, model, apiKey });
  SS.setAiRemoteAllowed(hasFlag("--allow-remote"));
  const jsonMode = hasFlag("--json-mode") || (!!(preset && preset.jsonMode) && !hasFlag("--no-json-mode"));
  return { endpoint, model, local, jsonMode, provider: providerName || "custom" };
}

function sendAsync(messages, opts) {
  return new Promise((resolve, reject) => SS.sendAiChat(messages, (err, text) => (err ? reject(err) : resolve(text)), opts));
}

async function aiDraftOne(file, examples, ai) {
  const t0 = Date.now();
  const audio = decodeAudioFile(file, arg("--ffmpeg", null));
  const durationMs = Math.round((audio.samples.length / audio.sampleRate) * 1000);
  const frames = SS.analyzePitchLoudness(audio.samples, audio.sampleRate, { winMs: 40, hopMs: 30, minHz: 80, maxHz: 1000, silenceRms: SS.adaptiveSilenceRms(audio.samples, audio.sampleRate) });
  const draft = SS.buildDraft(frames, { cleanup: true });
  const features = SS.audioFeatures(draft, durationMs);
  const messages = SS.buildTraceDraftMessages(features, examples);
  const t1 = Date.now();
  const reply = await sendAsync(messages, { jsonMode: hasFlag("--json-mode"), timeoutMs: Number(arg("--timeout", "300")) * 1000 });
  const strokes = SS.parseTraceReply(reply, durationMs, features);
  const session = SS.createSession();
  session.audio = { name: path.basename(file), included_in_export: false, duration_ms: durationMs };
  session.draft = draft;
  SS.applyAiTraceDraft(session, strokes, { model: ai.model, examples: examples.length });
  session.notes = "AI-drafted trace (" + (examples.length ? examples.length + " example(s)" : "zero-shot") + ", model " + ai.model +
    "). Strokes tagged ai_drafted_trace / needs_review are proposals: correct them by ear. The measured-pitch draft layer is separate.";
  const json = SS.sessionToJSON(session);
  if (SS.exportContainsSecrets(json)) throw new Error("Internal error: export contained secret-like keys.");
  return { json, strokes: strokes.length, duration_ms: durationMs, analysis_ms: t1 - t0, ai_ms: Date.now() - t1, prompt_chars: messages[1].content.length };
}

async function cmdAiDraft(file, outFile) {
  if (!file) throw new Error("ai-draft requires an audio file.");
  const ai = configureAi();
  const examples = loadExamples();
  if (outFile && fs.existsSync(outFile)) throw new Error("Output file already exists; choose a new name. Nothing was overwritten.");
  console.error("Sending " + path.basename(file) + " features to " + (ai.local ? "local " : "REMOTE ") + ai.endpoint + " (" + ai.model + "), " +
    (examples.length ? examples.length + " example(s)" : "zero-shot") + "…");
  const r = await aiDraftOne(file, examples, ai);
  writeOut(outFile, JSON.stringify(r.json, null, 2) + "\n");
  console.error("AI draft: " + r.strokes + " stroke(s) for " + (r.duration_ms / 1000).toFixed(1) + " s; analysis " + r.analysis_ms + " ms, model " + r.ai_ms + " ms.");
}

function listAudio(dir, recursive, base) {
  base = base || dir;
  let out = [];
  fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { if (recursive) out = out.concat(listAudio(full, true, base)); }
    else if (SS.audioKindFromName(d.name)) out.push(path.relative(base, full));
  });
  return out;
}

async function cmdAiBatch(folder, outDir) {
  if (arg("--lyrics-dir", null)) return cmdChainBatch(folder, outDir);
  if (!folder || !outDir) throw new Error("ai-batch requires <folder> -o <out-folder>.");
  const ai = configureAi();
  const examples = loadExamples();
  const resume = hasFlag("--resume");
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length && !resume) {
    throw new Error("Output folder already contains files. Use a new folder, or --resume to continue a batch. Nothing was overwritten.");
  }
  fs.mkdirSync(outDir, { recursive: true });
  const ffmpeg = arg("--ffmpeg", null);
  let songs = listAudio(folder, hasFlag("--recursive"));
  const skippedMp3 = ffmpeg ? 0 : songs.filter((f) => SS.audioKindFromName(f) === "mp3").length;
  if (!ffmpeg) songs = songs.filter((f) => SS.audioKindFromName(f) === "wav");
  const limit = Number(arg("--limit", "0")) || Infinity;
  const logFile = path.join(outDir, "batch-log.jsonl");
  const summary = { version: SS.APP_VERSION, endpoint_local: ai.local, model: ai.model, examples: examples.length,
    zero_shot: !examples.length, started: new Date().toISOString(), found: songs.length, skipped_mp3_without_ffmpeg: skippedMp3,
    done: 0, skipped_existing: 0, failed: 0 };
  console.error("ai-batch: " + songs.length + " song(s) → " + (ai.local ? "local " : "REMOTE ") + ai.endpoint + " (" + ai.model + "), " +
    (examples.length ? examples.length + " example(s)" : "zero-shot") + (skippedMp3 ? "; " + skippedMp3 + " MP3 skipped (no --ffmpeg)" : "") + ".");
  let processed = 0;
  for (const rel of songs) {
    if (processed >= limit) break;
    const outName = rel.split(/[\\/]/).join("__").replace(/\.(wav|mp3)$/i, "") + ".songshape.json";
    const outPath = path.join(outDir, outName);
    if (fs.existsSync(outPath)) { summary.skipped_existing += 1; continue; }
    processed += 1;
    const entry = { song: rel, output: outName, time: new Date().toISOString() };
    try {
      const r = await aiDraftOne(path.join(folder, rel), examples, ai);
      fs.writeFileSync(outPath, JSON.stringify(r.json, null, 2) + "\n", { flag: "wx" });
      Object.assign(entry, { status: "ok", strokes: r.strokes, duration_ms: r.duration_ms, analysis_ms: r.analysis_ms, ai_ms: r.ai_ms, prompt_chars: r.prompt_chars });
      summary.done += 1;
    } catch (err) {
      Object.assign(entry, { status: "failed", error: String(err && err.message || err).slice(0, 300) });
      summary.failed += 1;
    }
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
    console.error("[" + processed + "] " + rel + ": " + entry.status + (entry.status === "ok" ? " (" + entry.strokes + " strokes, " + entry.ai_ms + " ms)" : " — " + entry.error));
  }
  summary.finished = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, "batch-summary-" + summary.started.replace(/[:.]/g, "-") + ".json"), JSON.stringify(summary, null, 2) + "\n");
  console.error("ai-batch done: " + summary.done + " ok, " + summary.failed + " failed, " + summary.skipped_existing + " already done.");
  if (summary.failed && !summary.done) process.exitCode = 1;
}

// ---------------------------------------------------------------- v0.2.8 batch: full chain per song
function matchText(dir, rel, label) {
  if (!dir) return null;
  const base = path.basename(rel).replace(/\.(wav|mp3)$/i, "");
  const cands = [path.join(dir, path.dirname(rel), base + ".txt"), path.join(dir, base + ".txt")];
  const hit = cands.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  return hit ? { file: hit, text: fs.readFileSync(hit, "utf8") } : null;
}
function matchAlignment(dir, rel) {
  if (!dir) return null;
  const base = path.basename(rel).replace(/\.(wav|mp3)$/i, "");
  const cands = [path.join(dir, path.dirname(rel), base + ".json"), path.join(dir, base + ".json")];
  return cands.find((f) => fs.existsSync(f)) || null;
}

async function cmdChainBatch(folder, outDir) {
  if (!folder || !outDir) throw new Error("batch requires <folder> -o <out-folder> --lyrics-dir <folder> --new-lyrics <file|folder>.");
  const lyricsDir = arg("--lyrics-dir", null);
  if (!lyricsDir || !fs.existsSync(lyricsDir) || !fs.statSync(lyricsDir).isDirectory()) throw new Error("--lyrics-dir must be a folder of <song>.txt reference lyrics.");
  const newArg = arg("--new-lyrics", null);
  if (!newArg || !fs.existsSync(newArg)) throw new Error("--new-lyrics must be a .txt file (same new lyrics for every song) or a folder of <song>.txt files.");
  const newIsDir = fs.statSync(newArg).isDirectory();
  const sharedNew = newIsDir ? null : fs.readFileSync(newArg, "utf8");
  const ai = configureAi({ optional: true });
  const opts = chainOptions(ai);
  const resume = hasFlag("--resume");
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length && !resume) {
    throw new Error("Output folder already contains files. Use a new folder, or --resume to continue a batch. Nothing was overwritten.");
  }
  fs.mkdirSync(outDir, { recursive: true });
  let songs = listAudio(folder, hasFlag("--recursive"));
  const skippedMp3 = opts.ffmpeg ? 0 : songs.filter((f) => SS.audioKindFromName(f) === "mp3").length;
  if (!opts.ffmpeg) songs = songs.filter((f) => SS.audioKindFromName(f) === "wav");
  const limit = Number(arg("--limit", "0")) || Infinity;
  const alignDir = arg("--alignment-dir", null);
  const logFile = path.join(outDir, "batch-log.jsonl");
  const summary = { version: SS.APP_VERSION, mode: "full_chain", ai: ai ? { model: ai.model, endpoint_local: ai.local, provider: ai.provider,
      ai_sheet: opts.aiSheet, context: SS.getAiContextInfo() } : null, examples: opts.examples.length,
    started: new Date().toISOString(), found: songs.length, skipped_mp3_without_ffmpeg: skippedMp3,
    done: 0, partial: 0, skipped_existing: 0, skipped_no_lyrics: 0, failed: 0 };
  console.error("batch (full chain): " + songs.length + " song(s); " + (ai ? "CPU + AI " + ai.model + " at " + (ai.local ? "local " : "REMOTE ") + ai.endpoint : "CPU only (no AI configured)") +
    (skippedMp3 ? "; " + skippedMp3 + " MP3 skipped (no --ffmpeg)" : "") + ".");
  let processed = 0;
  for (const rel of songs) {
    if (processed >= limit) break;
    const name = rel.split(/[\\/]/).join("__").replace(/\.(wav|mp3)$/i, "");
    const final = path.join(outDir, name);
    if (fs.existsSync(path.join(final, "QUALITY_CHECK.json"))) { summary.skipped_existing += 1; continue; }
    const entry = { song: rel, output: name + "/", time: new Date().toISOString() };
    const ref = matchText(lyricsDir, rel);
    if (!ref) {
      Object.assign(entry, { status: "skipped_no_lyrics", note: "no <song>.txt in --lyrics-dir" });
      summary.skipped_no_lyrics += 1;
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
      console.error("[-] " + rel + ": no matching reference lyrics, skipped");
      continue;
    }
    processed += 1;
    const neu = newIsDir ? matchText(newArg, rel) : { file: newArg, text: sharedNew };
    const tmp = path.join(outDir, "." + name + ".partial-" + process.pid + "-" + Date.now());
    try {
      if (fs.existsSync(final)) throw new Error("An incomplete output folder exists for this song (" + name + "/); move or delete it, then --resume. Nothing was overwritten.");
      const r = await runChain(path.join(folder, rel), Object.assign({}, opts, {
        refLyrics: ref.text, newLyrics: neu ? neu.text : null, alignmentFile: matchAlignment(alignDir, rel) || opts.alignmentFile }));
      writeRecords(tmp, r.records, r.quality);
      fs.renameSync(tmp, final);
      const partial = !neu;
      Object.assign(entry, { status: partial ? "ok_partial" : "ok", reference_lyrics: path.basename(ref.file), new_lyrics: neu ? path.basename(neu.file) : null,
        stages: r.log.stages, duration_ms: r.log.duration_ms, total_ms: r.log.total_ms });
      if (partial) summary.partial += 1; else summary.done += 1;
    } catch (err) {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
      Object.assign(entry, { status: "failed", error: String(err && err.message || err).slice(0, 300) });
      summary.failed += 1;
      if (isFatalAiError(err)) { fs.appendFileSync(logFile, JSON.stringify(entry) + "\n"); throw err; }
    }
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
    const st = entry.stages || {};
    console.error("[" + processed + "] " + rel + ": " + entry.status + (entry.status.indexOf("ok") === 0
      ? " (words " + (st.place_words && st.place_words.anchors) + ", shape " + (st.draft_shape && st.draft_shape.mode) + ", sheet cpu" + (st.final_sheet && st.final_sheet.ai_sheet && st.final_sheet.ai_sheet !== "off" ? "+ai:" + st.final_sheet.ai_sheet : "") + ", " + entry.total_ms + " ms)"
      : " — " + entry.error));
  }
  summary.finished = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, "batch-summary-" + summary.started.replace(/[:.]/g, "-") + ".json"), JSON.stringify(summary, null, 2) + "\n");
  console.error("batch done: " + summary.done + " ok, " + summary.partial + " partial, " + summary.failed + " failed, " + summary.skipped_existing + " already done, " + summary.skipped_no_lyrics + " without lyrics.");
  if (summary.failed && !summary.done) process.exitCode = 1;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const outFile = arg("-o", null);

try {
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(usage());
    process.exit(cmd ? 0 : 1);
  } else if (cmd === "analyze") {
    cmdAnalyze(argv[1],argv[2],argv[3],outFile).catch((err) => { console.error("Error: " + (err && err.message ? err.message : err)); process.exit(1); });
  } else if (cmd === "batch") {
    cmdChainBatch(argv[1], outFile).catch((err) => { console.error("Error: " + (err && err.message ? err.message : err)); process.exit(1); });
  } else if (cmd === "ai-sheet") {
    cmdAiSheet(argv[1], argv[2], outFile).catch((err) => { console.error("Error: " + (err && err.message ? err.message : err)); process.exit(1); });
  } else if (cmd === "confirm") {
    cmdConfirm(argv[1], outFile);
  } else if (cmd === "handoff") {
    cmdHandoff(argv[1],argv[2],outFile);
  } else if (cmd === "draft") {
    if (!argv[1]) throw new Error("draft requires a WAV file.");
    cmdDraft(argv[1], outFile);
  } else if (cmd === "sheet") {
    if (!argv[1]) throw new Error("sheet requires a trace JSON file.");
    const lyrics = argv[2] && argv[2] !== "-o" ? argv[2] : null;
    cmdSheet(argv[1], lyrics, outFile);
  } else if (cmd === "map") {
    if (!argv[1] || !argv[2] || argv[2] === "-o") throw new Error("map requires <reference.json> <new_lyrics.txt>.");
    cmdMap(argv[1], argv[2], outFile);
  } else if (cmd === "request") {
    if (!argv[1] || !argv[2] || argv[2] === "-o") throw new Error("request requires <reference.json> <new_lyrics.txt>.");
    cmdRequest(argv[1], argv[2], outFile);
  } else if (cmd === "ai-draft") {
    cmdAiDraft(argv[1], outFile).catch((err) => { console.error("Error: " + (err && err.message ? err.message : err)); process.exit(1); });
  } else if (cmd === "ai-batch") {
    cmdAiBatch(argv[1], outFile).catch((err) => { console.error("Error: " + (err && err.message ? err.message : err)); process.exit(1); });
  } else if (cmd === "validate") {
    if (!argv[1]) throw new Error("validate requires a JSON file.");
    cmdValidate(argv[1]);
  } else {
    throw new Error("Unknown command: " + cmd + "\n\n" + usage());
  }
} catch (err) {
  console.error("Error: " + (err && err.message ? err.message : err));
  process.exit(1);
}
