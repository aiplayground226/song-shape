# Examples

Everything here is synthetic or fictional — no commercial recordings or published lyrics.

| File | What it is |
|---|---|
| `automatic_demo/reference.txt` | Fictional "original" lyrics for the demo tone (`demo/fictional_tone.wav`). |
| `automatic_demo/replacement.txt` | Fictional replacement lyrics. |
| `automatic_demo/output/` | What the CPU-only chain writes for the two files above: `node cli/songshape.js analyze demo/fictional_tone.wav examples/automatic_demo/reference.txt examples/automatic_demo/replacement.txt -o <new folder>`. |
| `new_lyrics_sample.txt` | A short replacement-lyrics sample in the paste format (plain lines, blank line between sections). |
| `sine_sweep.wav` | A synthetic sweep for `node cli/songshape.js draft examples/sine_sweep.wav`. |

See also `demo/` (the demo tone as WAV and MP3, and a small hand-trace project, `example_peak_break_pickup_nosedive.json`).
