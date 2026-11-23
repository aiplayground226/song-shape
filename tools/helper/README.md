# Optional local helper — v0.2.11-dev

The browser cannot launch Demucs or an aligner by itself. This small Python helper is the opt-in bridge.
It binds to `127.0.0.1` only; a random per-run token is required. Nothing runs at page load. You choose
which separator and aligner executables it may run in the local config file (argv arrays, never shell commands).
The AI can call only `load_song`, `separate_vocals`, `map_vocals`, `place_words`, `review` — no arbitrary shell,
filesystem or network tools.

## Windows: shared tools folder (v0.2.11 fix6)

Keep the venv, the model weights and the work folder in one `SongShape_Tools` folder next to the version folders, with a `songshape-tools.json` (template: `tools/launch/songshape-tools.example.json`). `Start-SongShape.cmd` in the version folder checks each tool, writes this version's helper config into the tools work folder and starts the helper. `/health` lists each tool with its path and whether it was found; a run with a missing program, script or ffmpeg stops with a clear "not found" message.

## Setup (do this yourself; no installer runs automatically)

1. Install Python 3.10+ and ffmpeg, then a private Python environment with `torch`, `torchaudio`, `numpy`,
   and optionally `demucs`. Use a mutually compatible torch/torchaudio version that still has `forced_align`.
   Tested here: CPU torch/torchaudio 2.11.0, Python 3.13.5. Demucs compatibility is separate and untested here.
2. Copy `helper-config.example.json` to a private `helper-config.json`. Edit the absolute Python/script paths.
   Leave `device` as `cpu` unless you choose to use a GPU. Set `separator` to `[]` if you already have a vocal stem.
3. Start: `python songshape_helper.py --config helper-config.json`
4. Paste its address and token into the page's **Stage 0 — Vocal stem** panel. The token stays only in that tab.
5. Click **Check helper**, then **Run local tools** (fixed order) or **Run with local AI** (connect a tool-capable
   local model first). No API key is needed by Song Shape itself; your local model server may ask for one.

First-time Demucs/torchaudio model use may download weights: do that while online, then use the app offline.
No model is bundled and the helper does not install/download anything on its own. Torch/Demucs may download
weights as part of the tool the user explicitly invokes. For strict offline use, pre-cache them and block egress.
All project audio and intermediate files stay in the helper's private work directory. It tells you where; delete
that directory when done. Windows users should keep it in their own profile, not a shared folder.

## Licenses / limits

- Helper, browser, CLI and these adapters: Apache-2.0 (project LICENSE).
- Python: PSF; PyTorch/torchaudio: BSD-style; NumPy: BSD. Demucs code: MIT. The `htdemucs`
  weights ship under the repo's MIT license, but they were trained partly on MUSDB18, whose terms are research/non-commercial.
  Whether that limits commercial use of the output is an open legal question (my guess: get advice before commercial release). The helper runs these as user-installed separate tools.
- `align_ctc.py --model base` uses the official wav2vec2-base-960h checkpoint from fairseq/torchaudio (MIT).
  `large` is also MIT but tested worse on a reference song excerpt. The `mms` comparison option is **CC-BY-NC-4.0**
  weights: not a commercial/product default and not included in the build. Avoid it for commercial work.
- ffmpeg is a separate user-installed program. Its binary license depends on the build (LGPL/GPL); we do not
  bundle or link it. For redistribution choose an LGPL-only build and satisfy its license.
- The aligner returns character-frame timing, not a phonetic lab annotation. The energy vowel target is the
  default when audio is decoded, because letter-based vowel timing was worse with the MIT aligner on this test. True first/second vowel-*sound* alignment
  needs a phoneme aligner. `word-onset.js` accepts phone spans for that future path.

## API (loopback + token)

`GET /health`; `POST /upload` raw WAV/MP3 -> `{audio_id}`;
`POST /separate` raw WAV/MP3 -> vocal WAV bytes + `X-Audio-Id`;
`POST /align` `{audio_id, words:[{id,text}]}` -> `{words:[{text,start,end,score,chars:[...]}]}`.
The page cannot send a path, command, model name, device choice or extra arguments. The human's config controls them.
