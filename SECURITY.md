# Security

Song Shape is a local, offline, single-folder web app. It is meant to be opened from disk (`file://`) or from a static folder you control. It does not open a network connection, does not create an account, and does not upload audio or annotations.

This is not a formal security audit. The notes below describe the v0.1.1 import hardening.

## What the app does not do

- No analytics, sign-in, cookies, or outbound API calls in the application code.
- No remote scripts, fonts, or stylesheets. The page only loads its own classic scripts and CSS from the same folder.
- Export JSON, PNG, and the Ask an AI text describe the annotation only. The audio file itself is never included.

## How JSON imports are validated

Importing a `.json` file (the Import button or a dropped file) is the main untrusted-input path.

1. Files larger than 20 MB are rejected before parsing. The current session is left unchanged.
2. The text is parsed with `JSON.parse` inside a try/catch. Invalid JSON is rejected.
3. Only a whitelist of schema fields is copied. Unknown keys, including `__proto__`, `constructor`, and `prototype`, are dropped.
4. Every time, duration, offset, and level value must already be a finite `Number` (`Number.isFinite`). Strings that look like numbers, `NaN`, and `Infinity` are rejected. Times must fall in 0 to 24 hours (offsets may be negative within that span). Levels are clamped to the tracing range −1 to +1.
5. Labels, names, ids, notes, and other strings must be strings. Control characters are stripped and lengths are capped (200 characters for labels and names, 4,000 for notes).
6. Arrays are capped (10,000 strokes, 100,000 points, and similar limits for gaps, phrases, and sections).
7. The live session is replaced only after the whole file has been validated. On failure the app shows a plain-text error (`textContent`) and keeps the current session.

The stroke list and status line are built with `createElement` and `textContent`. Imported timestamps, labels, file names, and notes are never assigned to `innerHTML`.

Exports (JSON and the Ask an AI / text summaries) are built from the same sanitized fields and only emit finite numbers and length-capped strings.

## How to report issues

Ordinary bugs: open an issue at https://github.com/aiplayground226/song-shape/issues. For security issues, please report privately through the repository's **Security → Report a vulnerability** form (GitHub private vulnerability reporting) rather than posting exploit files in a public issue. Only the official repository is the verified source; copies from elsewhere may have been modified.

Please include a description of the issue, a minimal sample file or steps to reproduce it, and whether any data left the machine. Do not attach copyrighted audio unless you have the right to share it.


## Optional AI connection (v0.2)

“Connect your AI” is off by default. When the user enables it, the app may call an OpenAI-compatible HTTP endpoint they typed (for example a local Ollama or LM Studio server). The API key is held in memory and `sessionStorage` only. Export JSON, PNG, lyric sheets, mapping requests, and Ask an AI prompts are built from a whitelist and must not contain secret-like keys (`api_key`, `apiKey`, `authorization`, `token`, and similar). Model output is parsed and schema-checked; it is never executed (`eval`, dynamic script, or `innerHTML`).

A page opened as `file://` may be blocked by the browser from reaching `http://127.0.0.1`. That is a platform limitation, not a reason to relax validation.

## v0.2.8 additions

- The AI context file is plain text placed in the system prompt; an override is capped at 64,000 characters and is never executed. Model replies stay data (validated, clamped, never executed).
- External tool hooks (`--separator`, `--aligner`, `--ffmpeg`) run only when the user gives an existing path, with `spawnSync` and `shell: false`, a timeout, and argument templates split without a shell. Song Shape never downloads or installs tools.
- API keys: CLI from environment variables only (never argv, files or logs); browser sessionStorage only. Remote endpoints need explicit opt-in.

## Harmony and performer fields

Imported `performer.identity` and lyric text are treated as plain text, same as other labels: length-capped, control characters stripped, never assigned to `innerHTML`.
