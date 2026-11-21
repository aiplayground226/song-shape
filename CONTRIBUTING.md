# Contributing to Song Shape

> **In short:** report bugs as GitHub issues. We only use `main` and don't merge pull requests from forks. Each fix is credited in `CHANGELOG.md` to whoever found the bug.

Thanks for helping make Song Shape better. This project takes **bug reports and ideas as GitHub issues**; the maintainers write and land the fixes.

## How it works

1. **Report bugs as issues.** Use the **Bug report** template: https://github.com/aiplayground226/song-shape/issues/new/choose
2. **Fixes land only on `main`, made by the maintainers.** We do **not merge pull requests from forks.** A PR that shows a fix is still welcome as an illustration, but it will be closed and the fix rewritten on `main`; please describe the problem in an issue first.
3. **Reporters are credited.** When your issue leads to a fix, `CHANGELOG.md` credits you, e.g. *"Fixed: MP3 files with ID3v2.4 tags failed to load (reported by @yourhandle in #12)."* Say so in the issue if you'd prefer not to be named.

## A good bug report

- **Version:** shown in the app footer ("Release v0.2.9") or by `node cli/songshape.js --help`.
- **Where:** browser app (which browser and OS) or command line (Node version, the exact command).
- **Steps to reproduce:** numbered, starting from opening the app or running the command.
- **Expected vs. actual:** what you thought would happen, and what did (paste error text, attach a screenshot if useful).
- **A sample you are allowed to share:** a few lines of lyrics, and if possible a short audio clip (a few seconds) or the exported `project.json`. **Do not attach copyrighted audio or lyrics you don't have the right to share** — a synthetic tone or your own recording is ideal; `demo/fictional_tone.wav` reproduces many problems.
- **AI stage problems:** which provider and model (e.g. Ollama + a model name), and the `QUALITY_CHECK.json` from the output folder. Never paste API keys.

## Ideas and questions

Open an issue with the **Feature request** template. Keep in mind the project's design rules: everything runs locally, the CPU path must always work without an AI or GPU, nothing is sent anywhere unless the user explicitly connects an AI, and Song Shape never downloads lyrics or songs.

## Running the checks yourself

- `node tests/run.js` — the full unit and regression suite (no dependencies, no network).
- Optional browser checks: `tests/headless_check.mjs` and `tests/network_probe.mjs` (need Chrome/Chromium and `npm install puppeteer-core` in a scratch copy; set `CHROME_PATH`).

## Security

Please report security problems privately via **Security → Report a vulnerability** on the repository, not in a public issue. See `SECURITY.md`.

## License

Song Shape is Apache-2.0 (`LICENSE`). Keep `NOTICE` in copies and derivatives.
