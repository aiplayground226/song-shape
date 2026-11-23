# Song Shape JSON schema (v0.2)

`schema_version`: `songshape-live-0.2`

v0.2 still **imports** `songshape-live-0.1` files. Exports are always `songshape-live-0.2`.

The top-level session is still a **manual listener trace** of perceived vocal delivery (`method`, `y_semantics`, `y_units` unchanged from v0.1). An optional `draft` object is a *separate* measured-pitch layer and is labeled as such.

## Semantics (unchanged from v0.1)

| Field | Meaning |
|---|---|
| `method` | `manual_listener_trace` for the hand-trace layer. |
| `y_semantics` | `subjective_vocal_delivery_relative_to_singer_baseline` |
| `y_units` | `normalized_relative`. `0` is the singer-specific baseline (center line). These are **not** semitones, Hertz, or MIDI notes. |
| `audio.included_in_export` | Always `false`. The recording stays on the user's computer. |
| `baseline.defined_by` | `annotator` |
| `timing_offset_ms` | Optional manual nudge for human reaction delay. |
| `strokes` | One object per mouse-down/mouse-up gesture. `points` are `[audio_time_ms, y]`. Points never span a release. Optional `word_id` associates the stroke with a placed lyric token. `word_id` may be `null` (unassigned). |
| `gaps` | Intervals between consecutive strokes. `breath` defaults to `unknown` and is **never inferred**. |
| `phrases` / `sections` | Optional grouping, as in v0.1. |

## v0.2 fields

| Field | Meaning |
|---|---|
| `lyrics` | Pasted lyric text plus parsed `lines` and `words`. Section tags (`[Chorus]`) and blank lines are kept. Tags are not placeable words. Line breaks are remembered for sheet export. |
| `anchors` | Placed words. A word is not a stroke. Each anchor has `word_id`, `start_ms`, `end_ms`, `stroke_ids` (one word may own many strokes), optional `harmony` (default `false`), and `needs_review` if a drag left associations inconsistent. |
| `active_word_id` | The word new traces will attach to, or `null`. Tracing never advances this by itself. |
| `draft` | Optional measured-pitch layer (`method: "measured_pitch_and_rms"`). Distinct from the hand trace. |
| `reference` | `{ title, artist }` for the Map my lyrics workflow. The artist may be stored here and used in a paste-ready request; style prompts must not name the artist. |
| `performer` | `{ identity, allow_harmony }`. `identity` is a user-editable global lead-singer description, written once on lyric sheets as `[Global Vocal Direction: …]`. The app default is a generic lead, not a named singer or a hardcoded tenor. |
| `harmony_ranges` | Optional time ranges marked as backing harmony under the same lead. Off unless the user adds one. |
| `place_parentheses` | If `true`, words inside `(parentheses)` are placeable ad-libs. Default `false`. Bracket `[...]` cues are never placeable words. |

## Examples

- `examples/honor_quickstart.json` — one word (“honor”) owning several strokes, with an unlabeled gap.
- `examples/honor_reference.json` — reference trace for the Map my lyrics sample.
- `demo/example_peak_break_pickup_nosedive.json` — fictional v0.1 traces; still imports.

## Import validation

A file is accepted only if it parses as JSON, stays under 20 MB, and matches the whitelist. Unknown keys are dropped. Times, durations, and levels must be finite numbers (`Number.isFinite`): times in 0–24 hours, levels in −1 to +1 (clamped). Strings must be strings; control characters are stripped and lengths are capped. Arrays are capped (10,000 strokes, 100,000 points). Secret-like keys are rejected on AI drafts and never written on export. A failed import does not modify the current session. See `SECURITY.md`.

## v0.2.4 optional addition

`replacement_lyrics` (string, up to 100000 characters) stores the **new original lyrics separately** from `lyrics.text`, `lyrics.words` and reference word anchors. Legacy files without the field import with an empty replacement. v0.2 schema_version remains unchanged for backwards compatibility; older applications may ignore the new field and therefore will not retain replacement lyrics on re-export. The v0.2.4 exporter and importer preserve it.

Draft-origin strokes are marked with annotation tags `machine_measured_pitch_draft` and `machine-draft-fingerprint:<hex>`. These tags are metadata, not evidence of lead identity or human tracing.

## v0.2.5 auxiliary representations (session schema unchanged)

**v0.2.11 vowel targeting:** `anchors[].signal_ms` (optional number) is the aligner's first-sound time; `start_ms` is then the vowel target. `anchors[].anchor_rule` (optional string: `phone_vowel`, `energy_vowel`, `letter_vowel`, `signal`) says which rule set `start_ms`. Both are kept on export/import; older readers ignore them.

**Word anchor provenance:** `anchors[].source` may be `cpu_energy_timing_estimate` (waveform/syllable heuristic) or `imported_known_lyrics_alignment` (external word-time proposal). `anchors[].needs_review` preserves uncertainty. Existing manual anchors are never overwritten by automatic proposals; the user may explicitly confirm one in the browser. Imported model scores are not proof of actual alignment. All imported anchors require explicit human review before removing their `needs_review` flag.

**Offline word timing import:** JSON `{"words":[{"text":"hello","start":0.1,"end":0.3,"score":0.9}]}` (seconds) or `start_ms`/`end_ms` or `segments[].words[]`. Every reference lyric word must match in the original sequence. A mismatched word/count/time causes rejection without changing the working project. No forced-aligner weights or inference are bundled.

**`songshape-visual-handoff-0.2.5`:** separate AI-sharing JSON with `projected_lines`, `projected_words`, `events`, `caveats`, explicit source semantics, and flags `contains_reference_audio:false`, `contains_reference_lyric_text:false`, `contains_source_artist:false`. New-word locations are syllable-weighted, proportional suggestions (0–1); they are not target-audio timing measurements. All original new lyric text/line breaks remain as supplied. AI-output generators may or may not obey the tags.

**Visual output:** static SVG/PNG/HTML. Human expressive traces use teal; accepted measured-F0 strokes use dashed purple. Neither is a source-melody transcription; the SVG uses escaped literal lyrics and no remote resources.
