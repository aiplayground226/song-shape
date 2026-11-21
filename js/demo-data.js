/**
 * Bundled fictional demo for Song Shape.
 * Embedded so the app runs from a double-clicked index.html (file://)
 * with no server, no Python, and no network fetch.
 */
(function (root) {
  "use strict";

  root.SongShape = root.SongShape || {};

  root.SongShape.DEMO_EXAMPLE = {
  "schema_version": "songshape-live-0.1",
  "app_version": "0.1.0",
  "method": "manual_listener_trace",
  "y_semantics": "subjective_vocal_delivery_relative_to_singer_baseline",
  "y_units": "normalized_relative",
  "audio": {
    "name": "fictional_tone.wav",
    "included_in_export": false,
    "duration_ms": 6500
  },
  "baseline": {
    "y": 0.0,
    "defined_by": "annotator"
  },
  "timing_offset_ms": 0,
  "phrases": [
    {
      "id": "phrase-1",
      "text": "rise, peak, break, pickup, nosedive (fictional demo)",
      "stroke_ids": [
        "stroke-1",
        "stroke-2"
      ]
    }
  ],
  "strokes": [
    {
      "id": "stroke-1",
      "phrase_id": "phrase-1",
      "start_ms": 500,
      "end_ms": 2500,
      "points": [
        [
          500,
          0.0
        ],
        [
          540,
          0.001
        ],
        [
          580,
          0.002
        ],
        [
          620,
          0.005
        ],
        [
          660,
          0.009
        ],
        [
          700,
          0.014
        ],
        [
          740,
          0.02
        ],
        [
          780,
          0.027
        ],
        [
          820,
          0.035
        ],
        [
          860,
          0.044
        ],
        [
          900,
          0.054
        ],
        [
          940,
          0.066
        ],
        [
          980,
          0.078
        ],
        [
          1020,
          0.092
        ],
        [
          1060,
          0.106
        ],
        [
          1100,
          0.122
        ],
        [
          1140,
          0.139
        ],
        [
          1180,
          0.157
        ],
        [
          1220,
          0.176
        ],
        [
          1260,
          0.196
        ],
        [
          1300,
          0.217
        ],
        [
          1340,
          0.239
        ],
        [
          1380,
          0.263
        ],
        [
          1420,
          0.287
        ],
        [
          1460,
          0.313
        ],
        [
          1500,
          0.339
        ],
        [
          1540,
          0.367
        ],
        [
          1580,
          0.396
        ],
        [
          1620,
          0.425
        ],
        [
          1660,
          0.456
        ],
        [
          1700,
          0.488
        ],
        [
          1740,
          0.521
        ],
        [
          1780,
          0.556
        ],
        [
          1820,
          0.591
        ],
        [
          1860,
          0.627
        ],
        [
          1900,
          0.665
        ],
        [
          1940,
          0.703
        ],
        [
          1980,
          0.743
        ],
        [
          2020,
          0.783
        ],
        [
          2060,
          0.825
        ],
        [
          2100,
          0.868
        ],
        [
          2140,
          0.912
        ],
        [
          2180,
          0.957
        ],
        [
          2240,
          0.98
        ],
        [
          2280,
          0.983
        ],
        [
          2320,
          0.986
        ],
        [
          2360,
          0.989
        ],
        [
          2400,
          0.992
        ],
        [
          2440,
          0.995
        ],
        [
          2480,
          0.998
        ],
        [
          2500,
          1.0
        ]
      ],
      "annotations": [
        "rise",
        "peak"
      ]
    },
    {
      "id": "stroke-2",
      "phrase_id": "phrase-1",
      "start_ms": 2900,
      "end_ms": 5400,
      "points": [
        [
          2900,
          0.95
        ],
        [
          2940,
          0.943
        ],
        [
          2980,
          0.937
        ],
        [
          3020,
          0.93
        ],
        [
          3060,
          0.923
        ],
        [
          3100,
          0.917
        ],
        [
          3140,
          0.91
        ],
        [
          3180,
          0.903
        ],
        [
          3240,
          0.839
        ],
        [
          3280,
          0.779
        ],
        [
          3320,
          0.72
        ],
        [
          3360,
          0.662
        ],
        [
          3400,
          0.605
        ],
        [
          3440,
          0.549
        ],
        [
          3480,
          0.495
        ],
        [
          3520,
          0.441
        ],
        [
          3560,
          0.389
        ],
        [
          3600,
          0.338
        ],
        [
          3640,
          0.288
        ],
        [
          3680,
          0.239
        ],
        [
          3720,
          0.191
        ],
        [
          3760,
          0.145
        ],
        [
          3800,
          0.099
        ],
        [
          3840,
          0.055
        ],
        [
          3880,
          0.012
        ],
        [
          3920,
          -0.031
        ],
        [
          3960,
          -0.072
        ],
        [
          4000,
          -0.112
        ],
        [
          4040,
          -0.15
        ],
        [
          4080,
          -0.188
        ],
        [
          4120,
          -0.225
        ],
        [
          4160,
          -0.26
        ],
        [
          4200,
          -0.294
        ],
        [
          4240,
          -0.327
        ],
        [
          4280,
          -0.359
        ],
        [
          4320,
          -0.39
        ],
        [
          4360,
          -0.42
        ],
        [
          4400,
          -0.449
        ],
        [
          4440,
          -0.476
        ],
        [
          4480,
          -0.503
        ],
        [
          4520,
          -0.528
        ],
        [
          4560,
          -0.552
        ],
        [
          4600,
          -0.575
        ],
        [
          4640,
          -0.597
        ],
        [
          4680,
          -0.618
        ],
        [
          4720,
          -0.638
        ],
        [
          4760,
          -0.656
        ],
        [
          4800,
          -0.674
        ],
        [
          4840,
          -0.69
        ],
        [
          4880,
          -0.705
        ],
        [
          4920,
          -0.719
        ],
        [
          4960,
          -0.732
        ],
        [
          5000,
          -0.744
        ],
        [
          5040,
          -0.754
        ],
        [
          5080,
          -0.764
        ],
        [
          5120,
          -0.772
        ],
        [
          5160,
          -0.78
        ],
        [
          5200,
          -0.786
        ],
        [
          5240,
          -0.791
        ],
        [
          5280,
          -0.795
        ],
        [
          5320,
          -0.798
        ],
        [
          5360,
          -0.799
        ],
        [
          5400,
          -0.8
        ]
      ],
      "annotations": [
        "pickup",
        "nosedive"
      ]
    }
  ],
  "gaps": [
    {
      "start_ms": 2500,
      "end_ms": 2900,
      "duration_ms": 400,
      "label": "user_marked_break",
      "breath": "unknown"
    }
  ],
  "notes": "Fictional example annotation for the bundled demo tone. Coordinates illustrate a rise to a peak, a timed break, a pickup, and a nosedive. This is a manual listener trace, not measured pitch, and is not taken from any copyrighted recording."
};

  var SR = 44100;

  function envelope(n, attack, release) {
    var env = new Float64Array(n);
    var i, a = Math.min(n, Math.round(SR * (attack || 0.015)));
    var r = Math.min(n, Math.round(SR * (release || 0.03)));
    for (i = 0; i < n; i++) env[i] = 1;
    if (a > 0) {
      for (i = 0; i < a; i++) env[i] = i / (a - 1 || 1);
    }
    if (r > 0) {
      for (i = 0; i < r; i++) env[n - r + i] = 1 - i / (r - 1 || 1);
    }
    return env;
  }

  function chirp(freqStart, freqEnd, duration, amp) {
    var n = Math.round(SR * duration);
    var out = new Float64Array(n);
    var env = envelope(n, 0.015, 0.03);
    var phase = 0;
    var i;
    for (i = 0; i < n; i++) {
      var freq = freqStart + (freqEnd - freqStart) * (n === 1 ? 0 : i / (n - 1));
      phase += 2 * Math.PI * freq / SR;
      out[i] = (amp || 0.32) * Math.sin(phase) * env[i];
    }
    return out;
  }

  function silence(duration) {
    return new Float64Array(Math.round(SR * duration));
  }

  function concat(parts) {
    var total = 0, i, p, out, offset = 0;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    out = new Float64Array(total);
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  function samplesToWavBuffer(samples) {
    var n = samples.length;
    var buffer = new ArrayBuffer(44 + n * 2);
    var view = new DataView(buffer);
    function u32(o, v) { view.setUint32(o, v, true); }
    function u16(o, v) { view.setUint16(o, v, true); }
    function str(o, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
    }
    str(0, "RIFF");
    u32(4, 36 + n * 2);
    str(8, "WAVE");
    str(12, "fmt ");
    u32(16, 16);
    u16(20, 1);
    u16(22, 1);
    u32(24, SR);
    u32(28, SR * 2);
    u16(32, 2);
    u16(34, 16);
    str(36, "data");
    u32(40, n * 2);
    var peak = 0, i, s;
    for (i = 0; i < n; i++) {
      s = Math.abs(samples[i]);
      if (s > peak) peak = s;
    }
    var gain = peak > 0 ? 0.89 / peak : 0;
    for (i = 0; i < n; i++) {
      var v = Math.round(Math.max(-1, Math.min(1, samples[i] * gain)) * 32767);
      view.setInt16(44 + i * 2, v, true);
    }
    return buffer;
  }

  /**
   * Same fictional tone as tools/make_demo_tone.py:
   * rise, silence, pickup, nosedive. Original audio, not a commercial recording.
   */
  function buildDemoToneWav() {
    var samples = concat([
      silence(0.50),
      chirp(220, 698, 2.00, 0.34),
      silence(0.40),
      chirp(680, 660, 0.30, 0.34),
      chirp(660, 110, 2.20, 0.33),
      chirp(110, 98, 0.80, 0.22),
      silence(0.30)
    ]);
    return samplesToWavBuffer(samples);
  }

  root.SongShape.buildDemoToneWav = buildDemoToneWav;
  root.SongShape.DEMO_TONE_NAME = "fictional_tone.wav";

  if (typeof module !== "undefined" && module.exports) {
    module.exports.buildDemoToneWav = buildDemoToneWav;
    module.exports.DEMO_EXAMPLE = root.SongShape.DEMO_EXAMPLE;
    module.exports.DEMO_TONE_NAME = root.SongShape.DEMO_TONE_NAME;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
