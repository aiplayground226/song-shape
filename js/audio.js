/**
 * Song Shape — local audio playback wrapper.
 * Authoritative clock is audio.currentTime. Accepts local .wav and .mp3
 * (extension plus a matching RIFF/WAVE or MPEG header, checked before decode).
 * Decoding uses the browser's built-in decodeAudioData; no libraries.
 * No network requests are made; files stay in the browser as object URLs.
 */
(function (root) {
  "use strict";

  function createPlayer() {
    var audio = document.createElement("audio");
    audio.preload = "auto";
    audio.playsInline = true;
    try { audio.preservesPitch = true; } catch (e) {}
    try { audio.mozPreservesPitch = true; } catch (e) {}
    try { audio.webkitPreservesPitch = true; } catch (e) {}

    var objectUrl = null;
    var arrayBuffer = null;
    var waveform = null;
    var audioBuffer = null;
    var fileName = "";
    var fileType = "";
    var loopRegion = null; // { start, end } in seconds, inclusive-exclusive
    var onPauseWhileHeld = null;
    var listeners = {
      timeupdate: [],
      play: [],
      pause: [],
      ended: [],
      seeked: [],
      ratechange: [],
      error: []
    };

    function bind(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
      audio.addEventListener(type, fn);
    }

    function fire(type, ev) {
      (listeners[type] || []).forEach(function (fn) { fn(ev); });
    }

    async function loadFile(file) {
      if (!file) throw new Error("No file provided.");
      var SS = root.SongShape || {};
      var unsupported = SS.SUPPORTED_AUDIO_MESSAGE || "Song Shape accepts .wav and .mp3 files.";
      if (SS.isSupportedAudioFile && !SS.isSupportedAudioFile(file)) throw new Error(unsupported);
      var incoming = await file.arrayBuffer();
      if (SS.validateAudio) SS.validateAudio(file.name || "", incoming);
      else throw new Error(unsupported);
      // Only replace the current recording after the file has been accepted.
      audioBuffer = null;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      arrayBuffer = incoming;
      fileName = file.name || "audio";
      fileType = file.type || "";
      objectUrl = URL.createObjectURL(file);
      audio.src = objectUrl;
      audio.load();
      waveform = null;
      var duration = await new Promise(function (resolve, reject) {
        var ok = function () {
          audio.removeEventListener("loadedmetadata", ok);
          audio.removeEventListener("error", err);
          resolve(audio.duration);
        };
        var err = function () {
          audio.removeEventListener("loadedmetadata", ok);
          audio.removeEventListener("error", err);
          reject(new Error(unsupported));
        };
        audio.addEventListener("loadedmetadata", ok);
        audio.addEventListener("error", err);
      });
      try {
        var decodedInfo = await decodeWaveform(arrayBuffer);
        waveform = decodedInfo.waveform;
        audioBuffer = decodedInfo.buffer;
      } catch (e) {
        waveform = null;
        console.warn("Waveform decode failed; playback may still work.", e);
      }
      return {
        duration: duration,
        name: fileName,
        type: fileType,
        waveform: waveform
      };
    }

    async function loadArrayBuffer(buf, name, mime) {
      var blob = new Blob([buf], { type: mime || "audio/wav" });
      blob.name = name || "audio.wav";
      // File constructor keeps a name, which we want for the session record.
      var file;
      try {
        file = new File([blob], name || "audio.wav", { type: mime || "audio/wav" });
      } catch (e) {
        file = blob;
        file.name = name || "audio.wav";
      }
      return loadFile(file);
    }

    async function decodeWaveform(buf) {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var copy = buf.slice(0);
      var decoded = await ctx.decodeAudioData(copy);
      var channel = decoded.getChannelData(0);
      var duration = decoded.duration;
      var targetPeaks = Math.min(8000, Math.max(400, Math.floor(duration * 200)));
      var samplesPerPeak = Math.max(1, Math.floor(channel.length / targetPeaks));
      var peaks = new Float32Array(targetPeaks);
      for (var i = 0; i < targetPeaks; i += 1) {
        var start = i * samplesPerPeak;
        var end = Math.min(channel.length, start + samplesPerPeak);
        var max = 0;
        for (var j = start; j < end; j += 1) {
          var v = Math.abs(channel[j]);
          if (v > max) max = v;
        }
        peaks[i] = max;
      }
      try { await ctx.close(); } catch (e) {}
      return {
        waveform: { peaks: peaks, duration: duration, sampleRate: decoded.sampleRate },
        buffer: decoded
      };
    }

    function play() {
      return audio.play();
    }

    function pause() {
      audio.pause();
    }

    function toggle() {
      if (audio.paused) return play();
      pause();
      return Promise.resolve();
    }

    function seek(seconds, durationFallback) {
      var dur = isFinite(audio.duration) ? audio.duration : (durationFallback || 0);
      var t = Math.max(0, Math.min(dur || seconds, seconds));
      audio.currentTime = t;
    }

    function setRate(rate) {
      var r = Number(rate);
      if (!isFinite(r) || r <= 0) return;
      audio.playbackRate = r;
      try { audio.preservesPitch = true; } catch (e) {}
      try { audio.mozPreservesPitch = true; } catch (e) {}
    }

    function currentTime() {
      return audio.currentTime || 0;
    }

    function duration() {
      return isFinite(audio.duration) ? audio.duration : 0;
    }

    function paused() {
      return audio.paused;
    }

    function ended() {
      return audio.ended;
    }

    function rate() {
      return audio.playbackRate || 1;
    }

    function setLoop(start, end) {
      if (start == null || end == null || end <= start) {
        loopRegion = null;
        audio.loop = false;
        return;
      }
      loopRegion = { start: start, end: end };
    }

    function getLoop() {
      return loopRegion;
    }

    function tickLoop() {
      if (!loopRegion || audio.paused) return;
      if (audio.currentTime >= loopRegion.end - 0.01) {
        audio.currentTime = loopRegion.start;
      }
    }

    bind("timeupdate", function () { tickLoop(); });

    return {
      element: audio,
      loadFile: loadFile,
      loadArrayBuffer: loadArrayBuffer,
      play: play,
      pause: pause,
      toggle: toggle,
      seek: seek,
      setRate: setRate,
      currentTime: currentTime,
      duration: duration,
      paused: paused,
      ended: ended,
      rate: rate,
      setLoop: setLoop,
      getLoop: getLoop,
      tickLoop: tickLoop,
      on: bind,
      getWaveform: function () { return waveform; },
      getAudioBuffer: function () { return audioBuffer; },
      getFileName: function () { return fileName; },
      getFileType: function () { return fileType; },
      hasAudio: function () { return !!objectUrl; }
    };
  }

  root.SongShape = root.SongShape || {};
  root.SongShape.createPlayer = createPlayer;
})(typeof globalThis !== "undefined" ? globalThis : this);
