/**
 * Song Shape v0.2 — measured pitch (YIN) and RMS loudness.
 * This is a SIGNAL measurement, not a listener's perceived-delivery trace.
 * Works on a Float32Array of samples in the browser (Web Audio) and in Node.
 * No network. No extra packages.
 */
(function (root) {
  "use strict";

  var DEFAULTS = {
    minHz: 80,
    maxHz: 1000,
    threshold: 0.12,
    winMs: 40,
    hopMs: 10
  };

  function rms(buffer, start, end) {
    var i;
    var sum = 0;
    var n = 0;
    var a = start < 0 ? 0 : start;
    var b = end > buffer.length ? buffer.length : end;
    for (i = a; i < b; i += 1) {
      sum += buffer[i] * buffer[i];
      n += 1;
    }
    return n ? Math.sqrt(sum / n) : 0;
  }

  /**
   * YIN pitch estimate for one window (de Cheveigné & Kawahara).
   * Returns frequency in Hz, or 0 if unvoiced.
   */
  function yinPitch(window, sampleRate, opts) {
    opts = opts || {};
    var threshold = opts.threshold == null ? DEFAULTS.threshold : opts.threshold;
    var minHz = opts.minHz == null ? DEFAULTS.minHz : opts.minHz;
    var maxHz = opts.maxHz == null ? DEFAULTS.maxHz : opts.maxHz;
    var n = window.length;
    if (n < 32 || !sampleRate) return 0;
    var tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
    var tauMax = Math.min(Math.floor(n / 2) - 1, Math.floor(sampleRate / minHz));
    if (tauMax <= tauMin) return 0;

    var yinBuf = new Float32Array(tauMax + 1);
    var tau, i, sum, d;
    for (tau = 1; tau <= tauMax; tau += 1) {
      sum = 0;
      for (i = 0; i < n - tau; i += 1) {
        d = window[i] - window[i + tau];
        sum += d * d;
      }
      yinBuf[tau] = sum;
    }
    yinBuf[0] = 1;
    var running = 0;
    for (tau = 1; tau <= tauMax; tau += 1) {
      running += yinBuf[tau];
      yinBuf[tau] = running ? (yinBuf[tau] * tau) / running : 1;
    }

    var tauEst = -1;
    for (tau = tauMin; tau <= tauMax; tau += 1) {
      if (yinBuf[tau] < threshold) {
        while (tau + 1 <= tauMax && yinBuf[tau + 1] < yinBuf[tau]) tau += 1;
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) {
      var best = threshold;
      for (tau = tauMin; tau <= tauMax; tau += 1) {
        if (yinBuf[tau] < best) {
          best = yinBuf[tau];
          tauEst = tau;
        }
      }
      if (tauEst < 0 || best > 0.3) return 0;
    }

    var better = tauEst;
    if (tauEst > 0 && tauEst < tauMax) {
      var s0 = yinBuf[tauEst - 1];
      var s1 = yinBuf[tauEst];
      var s2 = yinBuf[tauEst + 1];
      var denom = s0 - 2 * s1 + s2;
      if (denom !== 0) better = tauEst + (s0 - s2) / (2 * denom);
    }
    if (better <= 0) return 0;
    return sampleRate / better;
  }

  /**
   * Frame the samples and return {t_ms, f0, rms, voiced} rows.
   * Optional startMs/endMs (or startIndex/endIndex) limits the range;
   * t_ms is always absolute from the start of the buffer.
   */
  function analysisPlan(samples, sampleRate, opts) {
    opts = opts || {};
    var winMs = opts.winMs == null ? DEFAULTS.winMs : opts.winMs;
    var hopMs = opts.hopMs == null ? DEFAULTS.hopMs : opts.hopMs;
    var win = Math.max(32, Math.round(sampleRate * (winMs / 1000)));
    var hop = Math.max(8, Math.round(sampleRate * (hopMs / 1000)));
    var length = samples && samples.length ? samples.length : 0;
    var startIndex = 0;
    var endIndex = length;
    if (opts.startIndex != null) startIndex = opts.startIndex;
    else if (opts.startMs != null && sampleRate) startIndex = Math.floor((opts.startMs / 1000) * sampleRate);
    if (opts.endIndex != null) endIndex = opts.endIndex;
    else if (opts.endMs != null && sampleRate) endIndex = Math.ceil((opts.endMs / 1000) * sampleRate);
    if (startIndex < 0) startIndex = 0;
    if (endIndex > length) endIndex = length;
    if (endIndex < startIndex) endIndex = startIndex;
    var totalFrames = 0;
    if (length && sampleRate && endIndex - startIndex >= win && hop > 0) {
      totalFrames = Math.floor((endIndex - startIndex - win) / hop) + 1;
    }
    return {
      winMs: winMs,
      hopMs: hopMs,
      win: win,
      hop: hop,
      startIndex: startIndex,
      endIndex: endIndex,
      totalFrames: totalFrames,
      sampleRate: sampleRate
    };
  }

  function analyzeFrame(samples, sampleRate, index, win, opts) {
    opts = opts || {};
    var slice = samples.subarray ? samples.subarray(index, index + win) : samples.slice(index, index + win);
    var level = rms(samples, index, index + win);
    var f0 = 0;
    var voiced = false;
    if (level >= (opts.silenceRms == null ? 0.02 : opts.silenceRms)) {
      f0 = yinPitch(slice, sampleRate, opts);
      voiced = f0 > 0;
    }
    return {
      t_ms: Math.round((index / sampleRate) * 1000),
      f0: f0,
      rms: level,
      voiced: voiced
    };
  }

  function analyzePitchLoudness(samples, sampleRate, opts) {
    opts = opts || {};
    var plan = analysisPlan(samples, sampleRate, opts);
    var frames = [];
    if (!samples || !samples.length || !sampleRate || plan.totalFrames === 0) return frames;
    var i;
    for (i = plan.startIndex; i + plan.win <= plan.endIndex; i += plan.hop) {
      frames.push(analyzeFrame(samples, sampleRate, i, plan.win, opts));
    }
    return frames;
  }

  function scheduleSlice(fn) {
    if (typeof setImmediate === "function") {
      setImmediate(fn);
    } else if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(function () { setTimeout(fn, 0); });
    } else {
      setTimeout(fn, 0);
    }
  }

  /**
   * Same result as analyzePitchLoudness, but work is split across
   * setImmediate / setTimeout / rAF slices so a UI thread can paint.
   * opts.onProgress({ done, total, percent })
   * opts.cancel = { canceled: false } — set canceled to stop.
   * opts.framesPerSlice controls how many YIN frames run per slice.
   */
  function analyzePitchLoudnessChunked(samples, sampleRate, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress;
    var cancel = opts.cancel || { canceled: false };
    var framesPerSlice = opts.framesPerSlice == null ? 24 : opts.framesPerSlice;
    if (framesPerSlice < 1) framesPerSlice = 1;
    var plan = analysisPlan(samples, sampleRate, opts);
    return new Promise(function (resolve, reject) {
      var frames = [];
      var i = plan.startIndex;
      var done = 0;
      var total = plan.totalFrames;

      function failCanceled() {
        var err = new Error("Draft analysis canceled.");
        err.code = "CANCELED";
        reject(err);
      }

      function report() {
        if (!onProgress) return;
        var percent = total ? Math.min(100, Math.round((done / total) * 100)) : 100;
        onProgress({ done: done, total: total, percent: percent });
      }

      function slice() {
        if (cancel.canceled) {
          failCanceled();
          return;
        }
        var n = 0;
        while (n < framesPerSlice && i + plan.win <= plan.endIndex) {
          frames.push(analyzeFrame(samples, sampleRate, i, plan.win, opts));
          i += plan.hop;
          n += 1;
          done += 1;
        }
        report();
        if (i + plan.win <= plan.endIndex) {
          scheduleSlice(slice);
        } else {
          resolve(frames);
        }
      }

      report();
      if (total === 0) {
        resolve(frames);
        return;
      }
      scheduleSlice(slice);
    });
  }

  function pitchWorkerSource() {
    return [
      "var DEFAULTS = " + JSON.stringify(DEFAULTS) + ";",
      "var rms = " + rms.toString() + ";",
      "var yinPitch = " + yinPitch.toString() + ";",
      "var analysisPlan = " + analysisPlan.toString() + ";",
      "var analyzeFrame = " + analyzeFrame.toString() + ";",
      "onmessage = function (ev) {",
      "  var data = ev.data || {};",
      "  try {",
      "    var samples = data.samples;",
      "    var sampleRate = data.sampleRate;",
      "    var opts = data.opts || {};",
      "    var framesPerSlice = opts.framesPerSlice == null ? 80 : opts.framesPerSlice;",
      "    var plan = analysisPlan(samples, sampleRate, opts);",
      "    var frames = [];",
      "    var i = plan.startIndex;",
      "    var done = 0;",
      "    var total = plan.totalFrames;",
      "    function report() {",
      "      var percent = total ? Math.min(100, Math.round((done / total) * 100)) : 100;",
      "      postMessage({ type: 'progress', done: done, total: total, percent: percent });",
      "    }",
      "    report();",
      "    while (i + plan.win <= plan.endIndex) {",
      "      var n = 0;",
      "      while (n < framesPerSlice && i + plan.win <= plan.endIndex) {",
      "        frames.push(analyzeFrame(samples, sampleRate, i, plan.win, opts));",
      "        i += plan.hop;",
      "        n += 1;",
      "        done += 1;",
      "      }",
      "      report();",
      "    }",
      "    postMessage({ type: 'done', frames: frames });",
      "  } catch (err) {",
      "    postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });",
      "  }",
      "};"
    ].join("\n");
  }

  function canUsePitchWorker() {
    if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
      return false;
    }
    try {
      var blob = new Blob(["onmessage=function(){}"], { type: "text/javascript" });
      var url = URL.createObjectURL(blob);
      var worker = new Worker(url);
      worker.terminate();
      URL.revokeObjectURL(url);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Browser: prefer a Blob Web Worker (works on file:// because the script
   * is inlined, not fetched). Falls back to chunked slices if Worker fails.
   * Node: always uses the chunked path.
   */
  function analyzePitchLoudnessAsync(samples, sampleRate, opts) {
    opts = opts || {};
    var cancel = opts.cancel || { canceled: false };
    if (opts.useWorker !== false && canUsePitchWorker()) {
      return new Promise(function (resolve, reject) {
        var url = null;
        var worker = null;
        var settled = false;
        function finish(err, frames) {
          if (settled) return;
          settled = true;
          if (cancel._cleanup) {
            try { cancel._cleanup(); } catch (e2) {}
            cancel._cleanup = null;
          }
          if (worker) {
            try { worker.terminate(); } catch (e3) {}
            worker = null;
          }
          if (url) {
            try { URL.revokeObjectURL(url); } catch (e4) {}
            url = null;
          }
          if (err) reject(err);
          else resolve(frames);
        }
        try {
          url = URL.createObjectURL(new Blob([pitchWorkerSource()], { type: "text/javascript" }));
          worker = new Worker(url);
        } catch (err) {
          if (url) {
            try { URL.revokeObjectURL(url); } catch (e) {}
            url = null;
          }
          analyzePitchLoudnessChunked(samples, sampleRate, opts).then(resolve, reject);
          return;
        }
        cancel._cleanup = function () {
          if (worker) {
            try { worker.terminate(); } catch (e) {}
            worker = null;
          }
        };
        worker.onmessage = function (ev) {
          var data = ev.data || {};
          if (cancel.canceled) {
            var c = new Error("Draft analysis canceled.");
            c.code = "CANCELED";
            finish(c);
            return;
          }
          if (data.type === "progress" && opts.onProgress) opts.onProgress(data);
          else if (data.type === "done") finish(null, data.frames || []);
          else if (data.type === "error") finish(new Error(data.message || "Draft analysis failed."));
        };
        worker.onerror = function (err) {
          // Worker failed (some file:// browsers). Fall back to chunked
          // processing on a fresh copy if this buffer was transferred.
          if (settled) return;
          settled = true;
          if (cancel._cleanup) cancel._cleanup();
          if (worker) {
            try { worker.terminate(); } catch (e) {}
          }
          if (url) {
            try { URL.revokeObjectURL(url); } catch (e) {}
          }
          analyzePitchLoudnessChunked(samples, sampleRate, opts).then(resolve, reject);
        };
        try {
          // Do not transfer the buffer: a structured clone keeps the
          // main-thread copy so we can fall back or cancel cleanly.
          worker.postMessage({
            samples: samples,
            sampleRate: sampleRate,
            opts: {
              winMs: opts.winMs,
              hopMs: opts.hopMs,
              startMs: opts.startMs,
              endMs: opts.endMs,
              startIndex: opts.startIndex,
              endIndex: opts.endIndex,
              silenceRms: opts.silenceRms,
              minHz: opts.minHz,
              maxHz: opts.maxHz,
              threshold: opts.threshold,
              framesPerSlice: opts.framesPerSlice == null ? 80 : opts.framesPerSlice
            }
          });
        } catch (err) {
          if (worker) {
            try { worker.terminate(); } catch (e) {}
            worker = null;
          }
          if (url) {
            try { URL.revokeObjectURL(url); } catch (e) {}
            url = null;
          }
          analyzePitchLoudnessChunked(samples, sampleRate, opts).then(resolve, reject);
        }
      });
    }
    return analyzePitchLoudnessChunked(samples, sampleRate, opts);
  }

  function median(values) {
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /**
   * Read a RIFF WAVE file (PCM 16 or IEEE float 32, mono or stereo)
   * into a mono Float32Array in [-1, 1] plus the sample rate.
   */
  function readWavPcm(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length < 44) throw new Error("WAV file is too small.");
    function four(offset) {
      return String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
    }
    function u16(offset) { return u8[offset] | (u8[offset + 1] << 8); }
    function u32(offset) {
      return (u8[offset] | (u8[offset + 1] << 8) | (u8[offset + 2] << 16) | (u8[offset + 3] << 24)) >>> 0;
    }
    if (four(0) !== "RIFF" || four(8) !== "WAVE") throw new Error("Not a RIFF/WAVE file.");
    var offset = 12;
    var fmt = null;
    var dataOffset = -1;
    var dataSize = 0;
    while (offset + 8 <= u8.length) {
      var id = four(offset);
      var size = u32(offset + 4);
      if (id === "fmt ") {
        fmt = {
          format: u16(offset + 8),
          channels: u16(offset + 10),
          sampleRate: u32(offset + 12),
          bits: u16(offset + 22)
        };
      } else if (id === "data") {
        dataOffset = offset + 8;
        dataSize = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!fmt || dataOffset < 0) throw new Error("WAV file is missing fmt or data.");
    var channels = fmt.channels || 1;
    var sr = fmt.sampleRate;
    var view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var samples;
    var i;
    if (fmt.format === 1 && fmt.bits === 16) {
      var count = Math.floor(dataSize / 2);
      var frames = Math.floor(count / channels);
      samples = new Float32Array(frames);
      for (i = 0; i < frames; i += 1) {
        var acc = 0;
        var c;
        for (c = 0; c < channels; c += 1) {
          acc += view.getInt16(dataOffset + (i * channels + c) * 2, true) / 32768;
        }
        samples[i] = acc / channels;
      }
    } else if ((fmt.format === 3 || fmt.format === 1) && fmt.bits === 32) {
      var count32 = Math.floor(dataSize / 4);
      var frames32 = Math.floor(count32 / channels);
      samples = new Float32Array(frames32);
      for (i = 0; i < frames32; i += 1) {
        var acc32 = 0;
        var c32;
        for (c32 = 0; c32 < channels; c32 += 1) {
          var pos = dataOffset + (i * channels + c32) * 4;
          acc32 += fmt.format === 3 ? view.getFloat32(pos, true) : view.getInt32(pos, true) / 2147483648;
        }
        samples[i] = acc32 / channels;
      }
    } else {
      throw new Error("Only 16-bit PCM or 32-bit float WAV is supported in the CLI.");
    }
    return { samples: samples, sampleRate: sr, channels: channels };
  }

  /**
   * Write a mono 16-bit PCM WAV buffer (ArrayBuffer).
   */
  function writeWavPcm16(samples, sampleRate) {
    var n = samples.length;
    var out = new ArrayBuffer(44 + n * 2);
    var view = new DataView(out);
    function str(offset, s) {
      var i;
      for (i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
    }
    str(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, "data");
    view.setUint32(40, n * 2, true);
    var i;
    for (i = 0; i < n; i += 1) {
      var v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, Math.round(v * 32767), true);
    }
    return out;
  }

  /**
   * A linear sine sweep, useful as a synthetic test tone.
   */
  function makeSineSweep(durationSec, sampleRate, f0, f1, amplitude) {
    var sr = sampleRate || 44100;
    var dur = durationSec || 2;
    var start = f0 || 220;
    var end = f1 || 880;
    var amp = amplitude == null ? 0.4 : amplitude;
    var n = Math.round(sr * dur);
    var samples = new Float32Array(n);
    var i;
    for (i = 0; i < n; i += 1) {
      var t = i / sr;
      var frac = n === 1 ? 0 : i / (n - 1);
      var freq = start * Math.pow(end / start, frac);
      var phase = 2 * Math.PI * (start * dur) / Math.log(end / start) * (Math.pow(end / start, t / dur) - 1);
      if (!isFinite(phase)) phase = 2 * Math.PI * start * t;
      samples[i] = amp * Math.sin(phase);
    }
    return { samples: samples, sampleRate: sr };
  }

  var api = {
    yinPitch: yinPitch,
    analyzePitchLoudness: analyzePitchLoudness,
    analyzePitchLoudnessChunked: analyzePitchLoudnessChunked,
    analyzePitchLoudnessAsync: analyzePitchLoudnessAsync,
    analysisPlan: analysisPlan,
    analyzeFrame: analyzeFrame,
    canUsePitchWorker: canUsePitchWorker,
    pitchWorkerSource: pitchWorkerSource,
    rms: rms,
    median: median,
    readWavPcm: readWavPcm,
    writeWavPcm16: writeWavPcm16,
    makeSineSweep: makeSineSweep,
    PITCH_DEFAULTS: DEFAULTS
  };

  root.SongShape = root.SongShape || {};
  Object.keys(api).forEach(function (k) { root.SongShape[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) {
    var base;
    try { base = require("./strokes.js"); } catch (e) { base = root.SongShape; }
    Object.keys(api).forEach(function (k) { base[k] = api[k]; });
    module.exports = base;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
