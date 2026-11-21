# Changelog

All notable changes to Song Shape. Versions follow `MAJOR.MINOR.PATCH`; the app shows its version in the footer and `node cli/songshape.js --help`.

**Credits for bug reports.** Fixes are made by the maintainers on `main` (we don't merge pull requests from forks). When a fix comes from your issue, it is listed here with your GitHub handle, e.g. "Fixed: … (reported by @handle in #12)". Tell us in the issue if you'd rather not be credited.

## Unreleased

- First public release on GitHub. Repository links in the app now point to https://github.com/aiplayground226/song-shape. Added `CONTRIBUTING.md`, issue templates and a pull-request notice. Credit line in the app, README and NOTICE: "Ben / AI Playground LLC - Mr. Bard / ChatGpt - GrokBot". Example and test lyrics are fictional.

## [0.2.9] — 2026-11 — lyric input rules, CPU delivery vocabulary

- **Lyrics are pasted, never fetched.** Two clearly labeled boxes: **Original lyrics (paste)** — optional, if you have them — and **Your replacement lyrics (paste)**. New in-app help "How to paste lyrics" in the guided panel; the CLI usage says the same. Song Shape never downloads lyrics or songs.
- **Incoming tags are ignored** (`js/lyric-input.js`, `SS.cleanLyricInput`). In both lyric inputs, every `[bracket]` tag (whole-line or inline, even unclosed) and every clear `(performance cue)` such as `(whispered)`, `(spoken)`, `(x2)` is removed; unclear parentheses (`(softly, my love)`) are kept as sung backing words and flagged; plain parentheses (`(oh oh)`) stay as backing vocals as before. A UTF-8 BOM and Windows line endings are handled. Sections come from blank lines (a bracket line also marks a section start); Song Shape names them itself — a block that repeats is `[Chorus]`, others `[Verse]`. The output sheet contains only Song Shape's own tags (`[Global Vocal Direction: …]`, `[Verse]`/`[Chorus]`, `[Delivery: …]`, the backing-harmony tag). The cleaning report is shown under each box and written to `QUALITY_CHECK.json` (`chain.lyric_input`).
- **CPU delivery vocabulary** (`js/cpu-tags.js`). Each line's tag is derived deterministically from its contour features (direction, register, dynamics, sustain, peak word, dips/climbs, ending, phrase breaks/labeled breaths, rhythm), at most 8 cues. **No variety logic:** identical or near-identical contours give identical tags; a repeated line with the same text and a contour within tolerance (0.15) reuses the first occurrence's tags (`same_tags_as_line` in the handoff); tags change only where the contour changes. Unlabeled gaps are "phrase break mid-line", never "breath". Calibrated on three real songs: pitch-tracker fragments less than 0.3 s apart count as one sung unit, a phrase break is a rest of at least 0.45 s inside the line (15–85 % of it), and sung time for rhythm uses the merged units — before this, "short detached notes" and "phrase break" fired on almost every real line. Each line's `cpu_tags` are included in the AI handoff.
- **AI context `0.2.9-1`:** documents the vocabulary, the same-contour-same-tags rule and the lyric input rule; the stage-4 instructions say the same.
- **Windows fix:** `tests/test_v02.js` wrote to a hard-coded `/tmp` and failed on Windows (found running the suite on Windows); it now uses the OS temp folder.
- README: `audio-separator` example and a Windows PowerShell 5.1 quoting note for `--separator-args` (nested double quotes were dropped and the separator silently ran with its defaults).
- Tests: new `tests/test_v029.js` (8 tests); headless guided check now pastes `[Belting]`/`(whispered)` and checks they do not reach the sheet. Suite total **123**. Version labels 0.2.9; schemas unchanged.

## [0.2.8] — 2026-11 — CPU-first 4-stage chain, AI context file, providers, opt-in GPU hooks

- **Guided 4-stage panel** (Place the original words → Draft the shape → Fit the new lyrics → Final tagged sheet). Per-stage Run buttons and status; **Run all** pauses for review after stages 1 and 2 (**Continue after review**). Every stage runs on the CPU alone; the AI options only replace stage 2 and/or stage 4 when enabled.
- **AI stroke review.** AI-drafted strokes stay unconfirmed (`needs_review`) until **Confirm selected AI stroke** / **Confirm all AI strokes** (adds `ai_confirmed`). Stages 3–4 flag unconfirmed strokes (`ai_drafted_trace_not_confirmed` review reason, evidence `ai_drafted_trace_unconfirmed`), or leave them out with **Leave out unconfirmed AI strokes in stages 3–4** / `--exclude-unconfirmed-ai`. CLI `confirm`.
- **Line-aware AI draft (stage 2).** Requests are built per line window (consecutive lines up to 12 s): window-relative pitch grid, placed word onsets with syllable counts, and — only with the opt-in — the word text. Replies are clipped to the window, resampled, split at silences and stitched. One retry per window; if the AI fails entirely the chain falls back to the CPU shape. New tags `ai-chunked`, `ai-word-timing`, `ai-word-text`.
- **Stage-4 send-and-check** shared by the app's **Send to connected AI** and the new CLI `ai-sheet`: rejects unsafe replies, reports missing lyric lines/blocks and format problems (missing global direction, section merged into a delivery tag, delivery tag on the lyric line, >8 cues).
- **CLI full chain.** `analyze` runs 1→2→3→4 (MP3 via `--ffmpeg`; optional AI). New `batch` (CPU) and `ai-batch --lyrics-dir … --new-lyrics …` (AI) run the full chain per song with lyrics matched by file name, never overwrite, `--resume`, per-song log; `ai-batch` without `--lyrics-dir` keeps the v0.2.7 behaviour.
- **AI context file** `SONG_SHAPE_AI_CONTEXT.md` (+ `.json`), versioned (`context_version: 0.2.8-2`), placed at the start of the system prompt of every AI call (app and CLI). Override per tab (**Load context file…**) or `--context`. Built-in copy generated into `js/ai-context.js` by `tools/build-ai-context.js`.
- **Provider presets:** Ollama, LM Studio, llama.cpp, other OpenAI-compatible, xAI (Grok) API, OpenAI API. API presets are remote (explicit opt-in / `--allow-remote`), keys from env vars only in the CLI (`XAI_API_KEY`, `OPENAI_API_KEY`, `SONGSHAPE_API_KEY`, or `--api-key-env`), sessionStorage only in the browser. `--provider` in the CLI.
- **Opt-in external/GPU tool hooks** (CLI): `--separator` (vocal separation; demucs preset) and `--aligner` (forced alignment → word import), with `-args`/`-output` templates and `--hook-timeout`. Nothing is detected or run without a path; nothing installed; no shell.
- **Fixes found in the real-model run:** coarse AI replies whose points fell inside silences lost most of the stroke (now resampled onto the grid before splitting); summary line now says `final_sheet=cpu+ai(...)`; status message after guided Run all; `<link rel="icon" href="data:,">` stops the browser's favicon request.
- **Tests:** new `tests/test_v028.js` (14 tests); `tests/headless_check.mjs` now runs the guided Run all (AI off) and checks the pauses and the tagged sheet. `tests/test_v026.js` / `test_v027.js` deliberately updated: Send now goes through `aiSheet` → `sendAndCheckSheet` → `sendAiChatAsync`. Suite total: **115**.
- Version labels 0.2.8. Data schemas unchanged (`songshape-live-0.2`, visual-handoff 0.2.5; performance-map implementation version stays 0.2.5). Calibration examples unchanged; still to be removed before the public release.

## [0.2.7] — 2026-11 — MP3, AI trace drafting, Apache-2.0

- **MP3 loading (browser).** Open `.wav` or `.mp3`; both are decoded locally by the browser's built-in `decodeAudioData` (no libraries). New `SS.validateAudio` checks extension + RIFF/WAVE or ID3/MPEG-frame header; other formats are rejected with a clear message and the loaded song stays. New **Load demo MP3** button (embedded `demo/fictional_tone.mp3`, 34,707 bytes). The CLI `draft`/`analyze` stay WAV-only; the new AI commands accept MP3 through a user-supplied `--ffmpeg`.
- **AI learns from your hand traces.** Under Connect your AI: pick finished hand traces as examples (current project and/or `.json` projects, max 5, memory only), click **Draft trace with AI**; the app measures the pitch contour locally, sends features + example strokes (no audio, no lyrics), and adds the reply as dashed magenta strokes tagged `ai_drafted_trace`/`needs_review` for correction by ear. Works zero-shot without examples. **Remove AI-drafted strokes** undoes it. Optional JSON mode and a 300 s timeout. Replies are validated (clamped, sorted, split at measured silences); nothing in a reply is executed.
- **Batch CLI.** `ai-draft <audio>` and `ai-batch <folder> -o <new folder>` (`--examples`, `--examples-dir`, `--recursive`, `--ffmpeg`, `--limit`, `--resume`, `--json-mode`, `--timeout`). Writes one project per song plus `batch-log.jsonl` and a summary; never overwrites; non-local endpoints need `--allow-remote`; API keys only via `--api-key-env`.
- **Local serving helper.** `Serve-Local.cmd` / `tools/serve-local.js` (loopback-only, read-only, no dependencies). Real-model testing showed Ollama's default CORS rejects `file://` pages; served over `http://127.0.0.1:8765/` it works with default Ollama settings. Error messages on `file://` now point to this.
- **License and provenance.** Apache-2.0 `LICENSE`, `NOTICE` (credit Ben Hayward and AI Playground LLC), README credit-for-forks section, disclaimer ("no tracking, analytics, accounts or data collection …") in README, PRIVACY and an in-app **About** panel with repository and **Report a bug** links. The repository URL is defined once in `js/project-info.js`.
- **Tests.** New `tests/test_v027.js` (11 tests). Two legacy assertions that MP3 must be rejected (`test_strokes.js`, `test_v02.js`) were deliberately updated to the new behavior. `tests/headless_check.mjs` now loads an MP3, rejects a bogus `.ogg`, and uses the demo-MP3 button. Suite total: 101. Real Ollama runs are logged in `verification/real_model_v0.2.7/`.
- Version labels bumped to 0.2.7. Data schemas unchanged (`songshape-live-0.2`, visual-handoff 0.2.5).

## [0.2.6] — 2026-11 — AI Send fix and AI Playground credit

- **Fixed:** "Send to my AI" posted `messages` as a plain string, which OpenAI-compatible servers (Ollama, LM Studio, llama.cpp, OpenAI) reject. `SS.sendAiChat` now normalizes input with the new `SS.toChatMessages()` into `[{role, content}]`, rejects malformed or empty input before any network call, sends `stream:false`, and uses `redirect:"error"` so a loopback endpoint cannot silently forward the request elsewhere. The Send button wraps the prompt as chat messages; Copy/Save mapping request still produce plain text.
- **Added:** visible header credit "Song Shape, a free tool from AI Playground." with one plain link to [MTA Music Master](https://www.aiplayground.spot/music-master) (`target=_blank`, `rel="noopener noreferrer"`, `referrerpolicy="no-referrer"`). No images, scripts, prefetch or any request to the site unless the user clicks. Same credit in the README.
- **Tests:** new `tests/test_v026.js` (4 tests) posts to a local loopback mock server and asserts the body is valid JSON with a non-empty `messages` array of `{role, content}`; it fails on v0.2.5 code and passes on v0.2.6. New optional `tests/network_probe.mjs` proves zero outbound requests at page load. Suite total: 90.
- Version labels bumped to 0.2.6 (app, CLI `QUALITY_CHECK.json`, launcher text). Data schemas (`songshape-live-0.2`, `songshape-visual-handoff-0.2.5`, performance-map 0.2.5) are unchanged.

## [0.2.5] — 2026-11 — Local Vocal Performance Translator

- Built on the preserved v0.2.4 source, remaining CPU-first and local by default.
- Added audio-energy timing suggestions and a selected-loop next-line alignment helper, **not** a phonetic recognizer.
- Added strict import of external known-lyrics word-alignment JSON (seconds or milliseconds), without overwriting manual anchors; uncertain timing metadata is explicit.
- Added full-track CPU contour button using existing YIN/RMS implementation and pitch draft acceptance, keeping human and machine-origin strokes distinct.
- Improved line grouping for zero-duration click anchors with neighboring word timing and recording duration.
- Added projected new-word cue mapping, SVG/PNG/HTML picture output, reduced-data AI handoff JSON and stronger word-specific AI prompt.
- Added single-song Node `analyze` and `handoff` commands, no automatic overwrites, and packaged controlled synthetic example.
- Added 11 new unit/regression tests and an interactive browser test. No real-song accuracy validation yet.
- No singer-conditioned separation, forced alignment engine, actual GPU processing, MP3 support or large-scale catalog implemented.

## [0.2.4] — 2026-11

Earlier prototype versions (v0.1–v0.2.4) were not published.
