# Song Shape vocal performance JSON (`songshape-vocal-performance-0.1`)

Saved with **Download Step 1 vocal performance JSON** or **Download Step 2 vocal performance JSON**. The file name is `songshape-stepN-vocal-performance.json`. It describes the measured reference performance with your lyrics laid over it, so a reasoning AI (or you) can help with tag mapping. The goal is fidelity: your lyrics sung the way the reference is sung. No audio is inside. The reference lyric text is left out unless you tick **Include the reference lyric lines**, and no artist is named.

## Top level

| field | meaning |
|---|---|
| `schema_version` | `songshape-vocal-performance-0.1` |
| `app_version`, `created` | Song Shape version, ISO time |
| `step`, `step_name` | 1 = Map my lyrics to the reference performance; 2 = Extend in that style |
| `lift` | Step 2 only: `true` when the optional Lift was on (default `false`: faithful inheritance) |
| `purpose`, `semantics` | what the numbers mean (time, relative pitch, estimates) |
| `performer_identity` | the one lead singer description |
| `suno_sheet` | the paste sheet as fitted to the Suno limit: `text`, `characters`, `budget`, `remaining`, `line_tags_shortened` |
| `full_sheet` | the same sheet before fitting to the limit |
| `lead_singer_only` | Song Shape tracks a single lead singer; harmonies, backing vocals and choir parts are not tracked |
| `vocal_range` | the lead singer's measured range from the vocal stem (or `null`): `low_note`, `high_note`, `baseline_note`, `low_hz`, `high_hz`, `baseline_hz`, `*_midi`, `span_semitones`, `half_span_octaves`, `percentiles` (default `[2, 98]`), `frames_used`, `excluded` (`harmony_regions`, `quiet`, `unstable_or_isolated`, `outlier_clusters`), `source`. The Singer baseline (contour y = 0) is the midpoint of the range in semitones; `register` is the line's place in the range in fifths (low < −0.6, lower-mid < −0.2, mid ±0.2, upper-mid ≤ 0.6, high above; −1 = lowest note, +1 = highest) |
| `harmony_regions` | detected harmony spans (hints): `id`, `start_ms`, `end_ms`, `score` (0–1), `reasons`, `source` (`stem`, `words`, `stem+words`) |
| `reference_sections` | the reference song's sections: `label`, `type`, `start_ms`, `end_ms`, `lines`, `detected_from`, `style_tag` |
| `sections[]` | your sections, below |
| `warnings`, `caveats` | review notes |
| `contains_reference_audio` (always false), `contains_reference_lyric_text`, `contains_source_artist` (false), `network_transmitted` (false) | privacy flags |

## `sections[]`

`index`, `label` (e.g. `Verse 4`), `type`, `status` (`mapped` or `new`), `new_reason` (`marked_new` when you marked it `[New …]`), `reference_section` (the reference section it follows, with `measured`: syllables per second, mean line length, holds, longest hold, register, intensity, contour), `source_section` (for a new section: your section whose tags it inherits), `style_tag` (the `[Vocal style: …]` line), `lift` and `lift_changes` (`style_before`, `style_after`, `rule`) when Lift is on, `harmony` (true when any line in it is in a harmony span), and `lines[]`.

## `sections[].lines[]`

| field | meaning |
|---|---|
| `line_number`, `lyric` | your line, exactly as written |
| `status` | `line_level_draft` or `needs_review`. Since fix7, `needs_review` means a specific problem listed in `warnings` (a word-count difference beyond the tolerance of max(1, 35% of the reference words), a low-confidence word, unplaced or untimed reference words). Machine-estimated word positions alone no longer set it; that is stated once in `estimate_caveat`. |
| `merged_with_line`, `short_line_rule` | fix7: a 1–2 word line that shares the reference line(s) of the line before has no tag of its own (`merged_with_previous_line`; `merged_with_line` is the line, from 1, whose tag covers it). Other 1–2 word lines keep only direction, register, a hold and a peak (`trimmed_to_essentials`). |
| `maps_to_reference` | `line_numbers` (reference lines, counted from 1), `group_ids`, `start_ms`, `end_ms`, `duration_ms`, `word_count`, `words[]` (`word_id`, `start_ms` of each reference word; `text` only when opted in), `text` only when opted in |
| `delivery_tags` | the per-line tags used in the sheet |
| `performance` | `direction`, `register`, `dynamics`, `holds[]`, `peaks[]`, `contour[]`, `ending`, `phrasing[]`, and the measured numbers `contour_mean/start/end/min/max/range` (relative y), `peak_at` and `longest_hold_at` (0–1 in the line), `longest_hold_ms`, `turns`, `breaks`, `voiced_ratio`, `words_per_s`; `{measured:false}` when no contour was measured |
| `words[]` | each of your words: `word`, `syllables`, `relative_start`, `relative_end` (0–1 in the reference line), `est_reference_start_ms`, `est_reference_end_ms` (proportional estimate, not measured timing of your words), `events` |
| `events[]` | measured contour events: `kind`, `description`, `start_ms`, `end_ms`, `at` (0–1), `word`, `evidence` |
| `contour[]` | the reference pitch contour under the line: strokes with `start_ms`, `end_ms`, `points` `[t_ms, y]` (y in −1…1 around the singer's own baseline, one point per 100 ms) |
| `harmony` | `detected` (overlaps a detected harmony span), `marked_by_you` (you marked harmony), `regions` (ids); each reference word and each of your words also has `harmony: true/false` |
| `fit_notes`, `warnings` | syllable-fit and review notes |
| `lift` | Lift on, new sections only: `final_line`, `tags_before`, `tags_after` |

Times are milliseconds in the reference recording. The pitch is relative contour, not absolute notes: no key and no BPM are claimed.

## Fix7 additions

- `estimate_caveat` (top level, also `caveats`): one sentence when machine-placed reference words (aligner, CPU timing estimate or tap layout) are under some lines.
- `sections[].style_tag`: the pace term agrees with the section's own line tags (most lines rapid → `quick phrasing`, most spacious → `slow, spacious phrasing`, otherwise a contradicted pace term is dropped). `style_tag_before_reconcile` in the section plan keeps the measured one.
- Project files: `anchors[].tap_anchored` (placed or confirmed from your line tap), `anchors[].confidence` (0–1 from the aligner, or null) and `anchors[].review_flags` (e.g. `low_alignment_confidence`, `weak_line_alignment`, `word_spans_long_gap`).
