/**
 * Song Shape — Live Tracing v0.2
 * Local, offline UI. Optional AI is off by default and never writes secrets
 * into exports. file:// may block localhost fetches.
 */
(function () {
  "use strict";

  var SS = window.SongShape;
  var session = SS.createSession();
  var recorder = SS.createRecorder();
  var player = SS.createPlayer();
  var canvas = document.getElementById("stage");
  var renderer = SS.createRenderer(canvas);

  var pointerHeld = false;
  var recording = false;
  var statusEl = document.getElementById("status");
  var timeEl = document.getElementById("time-readout");
  var strokeListEl = document.getElementById("stroke-list");
  var labelInput = document.getElementById("stroke-labels");
  var offsetInput = document.getElementById("timing-offset");
  var sensitivityInput = document.getElementById("sensitivity");
  var dropRoot = document.getElementById("app");
  var fileAudio = document.getElementById("file-audio");
  var fileJson = document.getElementById("file-json");
  var recBadge = document.getElementById("rec-badge");
  var audioLabel = document.getElementById("audio-label");
  var rulerDrag = null;
  var lastY = 0;
  var anchorDrag = null;
  var lyricsDirty = false;
  var draftJob = null;
  var draftViewManual = false;

  function offsetMs() {
    return Number(session.timing_offset_ms) || 0;
  }

  function nowMs() {
    return SS.audioTimeMs(player.currentTime(), offsetMs());
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.dataset.kind = kind || "info";
  }

  function formatTime(sec) {
    if (!SS.isFiniteNumber(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ":" + s.toFixed(2).padStart(5, "0");
  }

  function refreshTime() {
    var cur = player.hasAudio() ? player.currentTime() : 0;
    var dur = player.hasAudio() ? player.duration() : 0;
    var rate = player.hasAudio() ? player.rate() : 1;
    timeEl.textContent =
      formatTime(cur) + " / " + formatTime(dur) + "  ·  " + rate.toFixed(2).replace(/0$/, "") + "×";
  }

  function appendTextEl(parent, tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text == null ? "" : String(text);
    parent.appendChild(el);
    return el;
  }

  function formatMsRange(start, end, extra) {
    var a = SS.isFiniteNumber(start) ? start : 0;
    var b = SS.isFiniteNumber(end) ? end : 0;
    var s = a + "–" + b + " ms";
    if (arguments.length > 2) {
      var x = SS.isFiniteNumber(extra) ? extra : 0;
      s += " (" + x + " ms)";
    }
    return s;
  }

  function refreshStrokeList() {
    // Never use innerHTML with session or file data. Clear and rebuild with textContent.
    strokeListEl.textContent = "";
    if (typeof refreshConfirmInfo === "function") refreshConfirmInfo();
    if (!session.strokes.length) {
      var empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "No strokes yet. Load a song, press play, and hold the left mouse button to trace.";
      strokeListEl.appendChild(empty);
      return;
    }
    session.strokes.forEach(function (s) {
      var li = document.createElement("li");
      li.className = "stroke-item" + (renderer.view.selectedId === s.id ? " selected" : "");
      var labels = s.annotations && s.annotations.length ? s.annotations.join(", ") : "unlabeled";
      if (SS.isUnconfirmedAiStroke && SS.isUnconfirmedAiStroke(s)) labels = "AI · unconfirmed · " + labels;
      else if (SS.isAiStroke && SS.isAiStroke(s)) labels = "AI · confirmed · " + labels;
      var section = SS.strokeSectionLabel(session, s);
      if (section) labels = section + " · " + labels;
      appendTextEl(li, "strong", "", s.id);
      li.appendChild(document.createTextNode(" "));
      appendTextEl(li, "span", "meta", formatMsRange(s.start_ms, s.end_ms));
      li.appendChild(document.createTextNode(" "));
      appendTextEl(li, "span", "tags", labels);
      li.addEventListener("click", function () {
        renderer.view.selectedId = s.id;
        labelInput.value = (s.annotations || []).join(", ");
        syncSectionUi(s);
        refreshStrokeList();
        draw();
      });
      strokeListEl.appendChild(li);
    });
    (session.gaps || []).forEach(function (g) {
      var li = document.createElement("li");
      li.className = "gap-item";
      var tag = g.label && g.label !== "unlabeled_gap" ? g.label : "unlabeled gap";
      appendTextEl(li, "strong", "", "gap");
      li.appendChild(document.createTextNode(" "));
      appendTextEl(li, "span", "meta", formatMsRange(g.start_ms, g.end_ms, g.duration_ms));
      li.appendChild(document.createTextNode(" "));
      appendTextEl(li, "span", "tags", tag + " · breath: " + (g.breath || "unknown"));
      strokeListEl.appendChild(li);
    });
  }

  function updateRecBadge() {
    recBadge.hidden = !recording;
  }

  function draw() {
    renderer.draw(session, player, recorder);
    refreshTime();
    updateRecBadge();
  }

  function closeStroke(reason) {
    if (!recorder.active) {
      recording = false;
      updateRecBadge();
      return null;
    }
    var saved = SS.endStroke(session, recorder, nowMs());
    recording = false;
    updateRecBadge();
    refreshStrokeList();
    if (saved && reason) {
      setStatus("Stroke " + saved.id + " ended (" + reason + "). Gap timing is preserved.", "info");
    } else if (saved) {
      setStatus("Stroke " + saved.id + " saved (" + (saved.end_ms - saved.start_ms) + " ms).", "ok");
    }
    return saved;
  }

  function beginStroke(yNorm) {
    if (!player.hasAudio()) {
      setStatus("Click Open audio (.wav or .mp3) first, or click “Load demo tone.”", "warn");
      return;
    }
    if (player.paused()) {
      setStatus("Press play before tracing. Click the ruler or the paused plot to seek.", "warn");
      return;
    }
    SS.startStroke(session, recorder, nowMs(), yNorm, currentPhraseId());
    recording = true;
    updateRecBadge();
    setStatus("Tracing… move up and down with the singer. Release to leave a gap.", "rec");
  }

  function currentPhraseId() {
    var field = document.getElementById("phrase-label");
    var text = SS.sanitizeLabel(field && field.value, SS.MAX_STRING_LEN).trim();
    if (!text) return null;
    var existing = (session.phrases || []).find(function (p) { return p.text === text; });
    if (existing) return existing.id;
    var id = SS.nextId("phrase-", session.phrases);
    session.phrases.push({ id: id, text: text, stroke_ids: [] });
    return id;
  }

  function syncPhraseMembership() {
    (session.phrases || []).forEach(function (p) {
      p.stroke_ids = session.strokes.filter(function (s) { return s.phrase_id === p.id; }).map(function (s) { return s.id; });
    });
  }

  function yFromEvent(ev) {
    var rect = canvas.getBoundingClientRect();
    return renderer.yToNorm(ev.clientY - rect.top);
  }

  function canvasXY(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  canvas.addEventListener("pointerdown", function (ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    canvas.focus();
    var pos = canvasXY(ev);
    var region = renderer.regionAt(pos.y);
    lastY = ev.clientY;
    if (region === "ruler" || region === "wave") {
      pointerHeld = false;
      var t = renderer.xToTime(pos.x, player.currentTime());
      rulerDrag = { start: t, last: t, moved: false };
      return;
    }
    if (region !== "plot") return;
    if (renderer.view.mode === "place") {
      var anchorHit = renderer.hitTestAnchor ? renderer.hitTestAnchor(session, player, pos.x, pos.y, offsetMs()) : null;
      if (anchorHit) {
        renderer.view.selectedAnchorId = anchorHit;
        beginAnchorDrag(anchorHit, ev);
        refreshLyricsUi();
        draw();
        return;
      }
      placeWordAtEvent(ev);
      return;
    }
    if (player.paused()) {
      var aHit = renderer.hitTestAnchor ? renderer.hitTestAnchor(session, player, pos.x, pos.y, offsetMs()) : null;
      if (aHit) {
        renderer.view.selectedAnchorId = aHit;
        refreshLyricsUi();
        draw();
        setStatus("Selected a word. Switch to Place word to drag it, or mark harmony with the lead.", "info");
        return;
      }
      var hit = renderer.hitTestStroke(session, player, pos.x, pos.y, offsetMs());
      if (hit) {
        renderer.view.selectedId = hit;
        var s = session.strokes.find(function (st) { return st.id === hit; });
        labelInput.value = s && s.annotations ? s.annotations.join(", ") : "";
        syncSectionUi(s);
        refreshStrokeList();
        draw();
        setStatus("Selected " + hit + ". Edit labels or press Delete to remove it.", "info");
        return;
      }
      var seekTo = renderer.xToTime(pos.x, player.currentTime());
      seekSafely(seekTo);
      return;
    }
    pointerHeld = true;
    beginStroke(yFromEvent(ev));
    draw();
  });

  canvas.addEventListener("pointermove", function (ev) {
    lastY = ev.clientY;
    var pos = canvasXY(ev);
    if (anchorDrag) {
      ev.preventDefault();
      moveAnchorDrag(ev);
      return;
    }
    if (rulerDrag) {
      var t = renderer.xToTime(pos.x, player.currentTime());
      if (Math.abs(t - rulerDrag.start) > 0.05) rulerDrag.moved = true;
      rulerDrag.last = t;
      if (rulerDrag.moved) {
        var a = Math.min(rulerDrag.start, t);
        var b = Math.max(rulerDrag.start, t);
        player.setLoop(a, b);
        document.getElementById("btn-loop").classList.add("on");
      }
      draw();
      return;
    }
    if (pointerHeld || recorder.active) {
      var rect = canvas.getBoundingClientRect();
      var outside = ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom;
      if (outside && !rulerDrag) {
        pointerFinished(ev, "pointer left the canvas");
        return;
      }
    }
    if (!pointerHeld || !recorder.active) return;
    if (player.paused()) {
      closeStroke("playback paused");
      return;
    }
    var result = SS.addPoint(session, recorder, nowMs(), yFromEvent(ev));
    if (result.status === "closed_on_backward_jump" || result.status === "closed_on_forward_jump") {
      recording = false;
      pointerHeld = false;
      refreshStrokeList();
      setStatus("Stroke closed because the playhead jumped. That prevents accidental joining across a seek.", "warn");
    }
  });

  function pointerFinished(ev, reason) {
    if (anchorDrag) {
      endAnchorDrag();
      return;
    }
    if (rulerDrag) {
      if (!rulerDrag.moved) {
        seekSafely(rulerDrag.start);
        setStatus("Seeked to " + formatTime(rulerDrag.start) + ".", "info");
      } else {
        setStatus("Loop set. Drag the ruler again to change it, or press L to clear.", "ok");
      }
      rulerDrag = null;
      draw();
      return;
    }
    if (!pointerHeld && !recorder.active) return;
    pointerHeld = false;
    closeStroke(reason);
    syncPhraseMembership();
    refreshStrokeList();
    draw();
  }

  canvas.addEventListener("pointerup", function (ev) {
    if (ev.button !== 0 && ev.pointerType !== "touch") return;
    pointerFinished(ev, null);
  });
  window.addEventListener("pointerup", function (ev) {
    if (ev.button !== 0 && ev.pointerType !== "touch") return;
    if (pointerHeld || recorder.active || rulerDrag) pointerFinished(ev, "pointer released");
  });

  canvas.addEventListener("pointercancel", function (ev) {
    pointerFinished(ev, "pointer canceled");
  });

  canvas.addEventListener("pointerleave", function (ev) {
    if (rulerDrag) return;
    if (pointerHeld || recorder.active) {
      pointerFinished(ev, "pointer left the canvas");
    }
  });

  window.addEventListener("blur", function () {
    if (recorder.active) {
      pointerHeld = false;
      closeStroke("window lost focus");
      draw();
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden && recorder.active) {
      pointerHeld = false;
      closeStroke("tab lost visibility");
      draw();
    }
  });

  function seekSafely(seconds) {
    if (recorder.active) closeStroke("seek");
    player.seek(seconds);
    draw();
  }

  player.on("play", function () {
    setStatus("Playing. Hold the left mouse button on the plot to trace tone and delivery.", "ok");
    document.getElementById("btn-play").textContent = "Pause";
  });
  player.on("pause", function () {
    if (recorder.active) closeStroke("playback paused");
    document.getElementById("btn-play").textContent = "Play";
    draw();
  });
  player.on("ended", function () {
    if (recorder.active) closeStroke("audio ended");
    document.getElementById("btn-play").textContent = "Play";
    draw();
  });
  player.on("seeked", function () {
    draw();
  });
  player.on("ratechange", function () {
    setStatus("Playback speed is now " + player.rate() + "×. Timing still uses the audio clock, not wall time.", "info");
    refreshRateButtons();
  });
  player.on("error", function () {
    setStatus(SS.SUPPORTED_AUDIO_MESSAGE, "warn");
  });

  document.getElementById("btn-play").addEventListener("click", function () {
    if (!player.hasAudio()) {
      setStatus("Click Open audio (.wav or .mp3) first, or click “Load demo tone.”", "warn");
      return;
    }
    player.toggle().catch(function () {
      setStatus("Playback was blocked until you click Play again.", "warn");
    });
  });

  document.getElementById("btn-back-1").addEventListener("click", function () {
    seekSafely(player.currentTime() - 1);
  });
  document.getElementById("btn-back-5").addEventListener("click", function () {
    seekSafely(player.currentTime() - 5);
  });
  document.getElementById("btn-fwd-1").addEventListener("click", function () {
    seekSafely(player.currentTime() + 1);
  });

  document.querySelectorAll("[data-rate]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      player.setRate(Number(btn.getAttribute("data-rate")));
      refreshRateButtons();
    });
  });

  function refreshRateButtons() {
    document.querySelectorAll("[data-rate]").forEach(function (btn) {
      btn.classList.toggle("on", Number(btn.getAttribute("data-rate")) === player.rate());
    });
  }

  document.getElementById("btn-loop").addEventListener("click", function () {
    if (player.getLoop()) {
      player.setLoop(null, null);
      this.classList.remove("on");
      setStatus("Loop cleared.", "info");
    } else {
      setStatus("Drag across the time ruler to set a loop region.", "info");
    }
    draw();
  });

  document.getElementById("chk-waveform").addEventListener("change", function (ev) {
    renderer.view.showWaveform = ev.target.checked;
    renderer.resize();
    draw();
  });

  sensitivityInput.addEventListener("input", function () {
    renderer.view.sensitivity = Number(sensitivityInput.value) || 1;
    document.getElementById("sensitivity-val").textContent = Number(sensitivityInput.value).toFixed(1) + "×";
  });

  offsetInput.addEventListener("change", function () {
    session.timing_offset_ms = Number(offsetInput.value) || 0;
    setStatus("Timing offset set to " + session.timing_offset_ms + " ms. This is a manual nudge for human reaction delay.", "info");
    draw();
  });

  document.getElementById("zoom").addEventListener("input", function (ev) {
    renderer.view.pixelsPerSecond = Number(ev.target.value);
    document.getElementById("zoom-val").textContent = ev.target.value + " px/s";
    syncDraftViewDefault();
    draw();
  });

  canvas.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    var next = renderer.view.pixelsPerSecond * (ev.deltaY > 0 ? 0.9 : 1.1);
    next = SS.clamp(next, 30, 400);
    renderer.view.pixelsPerSecond = next;
    document.getElementById("zoom").value = String(Math.round(next));
    document.getElementById("zoom-val").textContent = Math.round(next) + " px/s";
    syncDraftViewDefault();
    draw();
  }, { passive: false });

  document.getElementById("btn-undo").addEventListener("click", undoStroke);
  document.getElementById("btn-delete").addEventListener("click", deleteSelected);
  document.getElementById("btn-reset").addEventListener("click", function () {
    if (!confirm("Clear all strokes, gaps and labels and start over?")) return;
    performReset();
  });
  document.getElementById("btn-clear").addEventListener("click", function () {
    if (!session.strokes.length && !recorder.active) return;
    if (!confirm("Clear all strokes? This cannot be undone.")) return;
    SS.clearStrokes(session, recorder);
    renderer.view.selectedId = null;
    refreshStrokeList();
    setStatus("All strokes cleared.", "info");
    draw();
  });

  function performReset() {
    // End any in-progress stroke without saving it, then wipe the trace.
    // Pause is called after the recorder is idle so the pause handler does not re-save a stroke.
    pointerHeld = false;
    recording = false;
    if (recorder) recorder.active = null;
    SS.resetTrace(session, recorder);
    renderer.view.selectedId = null;
    renderer.view.selectedAnchorId = null;
    labelInput.value = "";
    document.getElementById("phrase-label").value = "";
    syncSectionUi(null);
    refreshLyricsUi();
    var ta = document.getElementById("summary-fallback");
    if (ta) {
      ta.value = SS.textSummary(session);
    }
    if (player.hasAudio && player.hasAudio()) {
      player.pause();
      player.seek(0);
    }
    refreshStrokeList();
    updateRecBadge();
    setStatus("Trace cleared.", "info");
    draw();
  }

  function undoStroke() {
    var result = SS.undoLastStroke(session, recorder);
    recording = !!recorder.active;
    if (result.undone === "active") setStatus("In-progress stroke discarded.", "info");
    else if (result.undone) setStatus("Removed " + result.undone.id + ".", "info");
    else setStatus("Nothing to undo.", "info");
    renderer.view.selectedId = null;
    refreshStrokeList();
    draw();
  }

  function deleteSelected() {
    if (!renderer.view.selectedId) {
      setStatus("Select a stroke first (pause, then click it).", "warn");
      return;
    }
    var id = renderer.view.selectedId;
    SS.deleteStrokeById(session, id);
    renderer.view.selectedId = null;
    labelInput.value = "";
    refreshStrokeList();
    setStatus("Deleted " + id + ".", "info");
    draw();
  }

  labelInput.addEventListener("change", function () {
    if (!renderer.view.selectedId) return;
    var parts = labelInput.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    SS.setStrokeAnnotations(session, renderer.view.selectedId, parts);
    refreshStrokeList();
  });

  document.getElementById("btn-open").addEventListener("click", function () {
    fileAudio.click();
  });
  // v0.2.11 fix7: guided step 1 opens the same file picker as the header button.
  var flowOpen = document.getElementById("btn-flow-open");
  if (flowOpen) flowOpen.addEventListener("click", function () { fileAudio.click(); });
  fileAudio.addEventListener("change", function (ev) {
    var file = ev.target.files && ev.target.files[0];
    if (file) loadAudioFile(file);
    ev.target.value = "";
  });

  document.getElementById("btn-export-json").addEventListener("click", exportJSON);
  document.getElementById("btn-save-top").addEventListener("click", exportJSON);
  document.getElementById("btn-import-json").addEventListener("click", function () {
    fileJson.click();
  });
  fileJson.addEventListener("change", function (ev) {
    var file = ev.target.files && ev.target.files[0];
    if (file) importJSONFile(file);
    ev.target.value = "";
  });
  document.getElementById("btn-export-png").addEventListener("click", function () {
    exportPNG(false);
  });
  document.getElementById("btn-export-png-full").addEventListener("click", function () {
    exportPNG(true);
  });
  document.getElementById("btn-copy-summary").addEventListener("click", copySummary);
  document.getElementById("btn-load-demo").addEventListener("click", function () {
    loadDemo(true);
  });
  document.getElementById("btn-load-demo-mp3").addEventListener("click", function () {
    loadDemoMp3();
  });
  document.getElementById("btn-load-example").addEventListener("click", function () {
    loadExampleTraces();
  });

  var currentAudioFile = null; // v0.2.11: kept in memory only, for the optional loopback helper
  function loadAudioFile(file) {
    if (!SS.isSupportedAudioFile(file)) {
      setStatus(SS.SUPPORTED_AUDIO_MESSAGE, "warn");
      return;
    }
    if (recorder.active) closeStroke("new audio loaded");
    var displayName = SS.sanitizeLabel(file.name, SS.MAX_STRING_LEN) || "audio";
    setStatus("Loading " + displayName + "…", "info");
    player.loadFile(file).then(function (info) {
      currentAudioFile = file;
      var name = SS.sanitizeLabel(info.name, SS.MAX_STRING_LEN) || displayName;
      var durationMs = Math.round((info.duration || 0) * 1000);
      if (!SS.isFiniteNumber(durationMs) || durationMs < 0) durationMs = 0;
      var oldAudio = session.audio && session.audio.name;
      if (oldAudio && oldAudio !== name) {
        session.draft = null;
        document.getElementById("draft-baseline-hz").value = "";
      }
      session.audio = {
        name: name,
        included_in_export: false,
        duration_ms: durationMs
      };
      audioLabel.textContent = name + "  (" + formatTime(info.duration) + ")";
      audioLabel.title = name + " · " + (info.type || "audio") + " · local file, not uploaded";
      var fas = document.getElementById("flow-audio-status");
      if (fas) fas.textContent = "Open: " + name + " (" + formatTime(info.duration) + ").";
      setStatus(
        "Loaded " + name + ". This file stays on your computer. Press Play and hold the left button to trace.",
        "ok"
      );
      draftViewManual = false;
      syncDraftViewDefault();
      renderer.resize();
      draw();
    }).catch(function (err) {
      setStatus(err.message || "Could not load that audio file.", "warn");
    });
  }

  function exportJSON() {
    session.replacement_lyrics = document.getElementById("new-lyrics").value;
    session.extend_lyrics = document.getElementById("extend-lyrics").value;
    syncPhraseMembership();
    var data = SS.sessionToJSON(session);
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    downloadBlob(blob, suggestName("json"));
    setStatus("Exported JSON. Audio is not included in the file.", "ok");
  }

  function importJSONFile(file) {
    if (file && SS.isFiniteNumber(file.size) && file.size > SS.MAX_IMPORT_BYTES) {
      setStatus("That file is too large to import (limit 20 MB). The current session was left unchanged.", "warn");
      return;
    }
    file.text().then(function (text) {
      // Parse and validate first. Only then replace the live session.
      var next = SS.parseSessionText(text, file && file.size);
      session = next;
      document.getElementById("draft-baseline-hz").value = session.vocal_range ? String(session.vocal_range.baseline_hz) : session.draft && session.draft.baseline_hz ? String(session.draft.baseline_hz) : "";
      document.getElementById("draft-baseline-hz").readOnly = !!session.vocal_range; renderVocalRange();
      recorder = SS.createRecorder();
      recording = false;
      offsetInput.value = String(session.timing_offset_ms || 0);
      if (session.phrases && session.phrases[0]) {
        document.getElementById("phrase-label").value = session.phrases[0].text || "";
      } else {
        document.getElementById("phrase-label").value = "";
      }
      refreshStrokeList();
      refreshLyricsUi();
      document.getElementById("new-lyrics").value = session.replacement_lyrics || "";
      document.getElementById("extend-lyrics").value = session.extend_lyrics || "";
      renderHarmonyList();
      setStatus(
        "Imported " + session.strokes.length + " stroke(s) and " + session.gaps.length + " gap(s). Audio is not inside the JSON; load the matching file if you want to hear it.",
        "ok"
      );
      draw();
      // v0.2.11: imported word marks count as stage 1.
      var placedN = (session.anchors || []).filter(function (a) { return a && !a.skipped; }).length;
      if (placedN && typeof gSet === "function") gSet(1, "done", placedN + " word(s) placed (from the imported project)");
    }).catch(function (err) {
      var msg = err && err.message ? err.message : "That file is not valid Song Shape JSON.";
      setStatus(msg + " The current session was left unchanged.", "warn");
    });
  }

  function exportPNG(full) {
    var url = renderer.exportPNG(session, player, recorder, { fullTimeline: full });
    var a = document.createElement("a");
    a.href = url;
    a.download = suggestName("png");
    a.click();
    setStatus("Exported PNG (" + (full ? "full timeline" : "current view") + ").", "ok");
  }

  function suggestName(ext) {
    var base = (session.audio && session.audio.name ? session.audio.name.replace(/\.[^.]+$/, "") : "song-shape")
      .replace(/[^\w.-]+/g, "_");
    return base + "-songshape." + ext;
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function currentSectionValue() {
    var preset = document.getElementById("section-preset").value;
    if (preset === "__custom__") return document.getElementById("section-custom").value.trim();
    return preset || "";
  }

  function syncSectionUi(stroke) {
    var preset = document.getElementById("section-preset");
    var custom = document.getElementById("section-custom");
    var wrap = document.getElementById("section-custom-wrap");
    var value = stroke && stroke.section ? stroke.section : "";
    var known = { Verse: 1, Chorus: 1, Bridge: 1, Outro: 1 };
    if (!value) {
      preset.value = "";
      wrap.hidden = true;
      custom.value = "";
    } else if (known[value]) {
      preset.value = value;
      wrap.hidden = true;
      custom.value = "";
    } else {
      preset.value = "__custom__";
      wrap.hidden = false;
      custom.value = value;
    }
  }

  function applySectionToSelected() {
    if (!renderer.view.selectedId) return;
    SS.setStrokeSection(session, renderer.view.selectedId, currentSectionValue());
    refreshStrokeList();
  }

  document.getElementById("section-preset").addEventListener("change", function () {
    var wrap = document.getElementById("section-custom-wrap");
    wrap.hidden = this.value !== "__custom__";
    if (this.value === "__custom__") document.getElementById("section-custom").focus();
    applySectionToSelected();
  });
  document.getElementById("section-custom").addEventListener("change", applySectionToSelected);
  document.getElementById("btn-section-loop").addEventListener("click", function () {
    var loop = player.getLoop && player.getLoop();
    var label = currentSectionValue();
    if (!label) {
      setStatus("Pick a section (Verse, Chorus, Bridge, Outro, or a custom name) first.", "warn");
      return;
    }
    if (!loop) {
      setStatus("Drag across the time ruler to set a loop, then apply the section to that range.", "warn");
      return;
    }
    var offset = offsetMs() / 1000;
    SS.setSectionRange(session, Math.round((loop.start + offset) * 1000), Math.round((loop.end + offset) * 1000), label);
    refreshStrokeList();
    setStatus("Applied section “" + label + "” to strokes in the loop.", "ok");
    draw();
  });

  function copyText(text, okMsg) {
    var ta = document.getElementById("summary-fallback");
    function showFallback(msg) {
      ta.value = text;
      ta.hidden = false;
      ta.select();
      setStatus(msg, "info");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        ta.value = text;
        ta.hidden = false;
        setStatus(okMsg, "ok");
      }).catch(function () {
        showFallback("Clipboard was blocked (common on file://). The text is selected below — copy it, or use Save AI prompt .txt.");
      });
    } else {
      showFallback("Select the text below and copy it, or use Save AI prompt .txt.");
    }
  }

  document.getElementById("btn-ask-ai").addEventListener("click", function () {
    var text = SS.aiPrompt(session);
    copyText(
      text,
      "Copied an Ask an AI prompt. Paste it into ChatGPT or GrokBot. No audio was sent anywhere."
    );
  });
  document.getElementById("btn-save-ai-txt").addEventListener("click", function () {
    var text = SS.aiPrompt(session);
    var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    var name = suggestName("txt");
    if (name.slice(-4) === ".txt") name = name.slice(0, -4) + "-ai-prompt.txt";
    downloadBlob(blob, name);
    setStatus("Saved the Ask an AI prompt as a .txt file. Nothing was uploaded.", "ok");
  });

  function copySummary() {
    copyText(
      SS.textSummary(session),
      "Copied a text summary for pasting into a chat. It only describes the annotation, not a hearing of the song."
    );
  }

  // Drag and drop: audio and/or JSON, anywhere on the page.
  ["dragenter", "dragover"].forEach(function (type) {
    dropRoot.addEventListener(type, function (ev) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
      dropRoot.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (type) {
    dropRoot.addEventListener(type, function () {
      dropRoot.classList.remove("dragover");
    });
  });
  dropRoot.addEventListener("drop", function (ev) {
    ev.preventDefault();
    var files = ev.dataTransfer && ev.dataTransfer.files ? Array.prototype.slice.call(ev.dataTransfer.files) : [];
    if (!files.length) return;
    var audio = files.filter(SS.isSupportedAudioFile);
    var jsons = files.filter(SS.isSongShapeJSONName);
    var other = files.filter(function (f) { return !SS.isSupportedAudioFile(f) && !SS.isSongShapeJSONName(f); });
    if (audio.length) loadAudioFile(audio[0]);
    if (jsons.length) importJSONFile(jsons[0]);
    if (!audio.length && !jsons.length) {
      setStatus("Drop a .wav, an .mp3 or a Song Shape .json file. " + SS.SUPPORTED_AUDIO_MESSAGE, "warn");
    } else if (other.length) {
      setStatus("Loaded the supported file. Other dropped types were ignored.", "info");
    }
  });

  document.getElementById("btn-clear-loop").addEventListener("click", function () {
    player.setLoop(null, null);
    document.getElementById("btn-loop").classList.remove("on");
    setStatus("Loop cleared.", "info");
    draw();
  });

  // v0.2.11 fix5: tap-to-mark line starts. Tap times are audio times (not display/timing-offset times).
  var tappingLines = false;
  // v0.2.11 fix6e: while tapping, a compact dock beside the graph keeps the tap controls in reach.
  function positionTapDock() {
    var dock = document.getElementById("tap-dock"), cv = document.getElementById("stage");
    if (!dock || dock.hidden || !cv) return;
    var r = cv.getBoundingClientRect(), vw = window.innerWidth || document.documentElement.clientWidth, vh = window.innerHeight || document.documentElement.clientHeight;
    var side = document.querySelector(".workspace") ? document.querySelector(".workspace").getBoundingClientRect() : r;
    var leftGap = r.left - 8, rightGap = vw - Math.max(r.right, side.right) - 8, w = 190;
    dock.classList.remove("floating");
    var left;
    if (leftGap >= 150) { w = Math.min(230, leftGap - 8); left = Math.max(4, r.left - w - 8); }
    else if (rightGap >= 150) { w = Math.min(230, rightGap - 8); left = vw - rightGap; }
    else {
      var aside = document.querySelector(".workspace .side"), ar = aside ? aside.getBoundingClientRect() : null;
      if (ar && ar.width >= 150 && ar.left >= r.right - 10) { w = Math.min(230, ar.width - 8); left = ar.left + 4; dock.classList.add("floating"); } // over the side panel, beside the graph
      else { w = 180; left = Math.max(4, r.left + 6); dock.classList.add("floating"); } // very narrow: float over the graph's left edge
    }
    dock.style.width = w + "px"; dock.style.left = Math.round(left) + "px";
    var h = dock.offsetHeight || 220;
    // follow the bottom word lane of the graph, but stay on screen while scrolling
    var top = r.bottom - h - 24;
    top = Math.max(8, Math.min(vh - h - 8, top));
    dock.style.top = Math.round(top) + "px";
  }
  window.addEventListener("scroll", positionTapDock, { passive: true });
  window.addEventListener("resize", positionTapDock);
  function refreshTapUi() {
    var next = SS.nextTapLine(session), taps = SS.lineTaps(session), marked = taps.filter(function (t) { return !t.skipped; }).length;
    var dock = document.getElementById("tap-dock");
    if (dock) {
      var lastTap = taps.length ? taps[taps.length - 1] : null, lines = (session.lyrics && session.lyrics.lines) || [];
      var cur = lastTap ? lines.filter(function (l) { return l.id === lastTap.line_id; })[0] : null;
      dock.hidden = !tappingLines;
      document.getElementById("tap-dock-current").textContent = cur ? "\u201c" + cur.text + "\u201d" + (lastTap.skipped ? " (skipped)" : "") : "—";
      document.getElementById("tap-dock-next").textContent = next ? "\u201c" + next.text + "\u201d" : "all lines done";
      document.getElementById("tap-dock-count").textContent = marked + " tapped, " + (taps.length - marked) + " skipped";
      var lat = document.getElementById("tap-latency"), dl = document.getElementById("tap-dock-latency");
      if (lat && dl && document.activeElement !== dl) dl.value = lat.value;
      renderer.view.tapNext = tappingLines && next ? next.text : null;
      var dw = document.getElementById("tap-dock-warn"), tw = document.getElementById("tap-warn");
      if (dw) { dw.hidden = !tapWarning; document.getElementById("tap-dock-warn-text").textContent = tapWarning; }
      if (tw) { tw.hidden = !tapWarning; tw.textContent = tapWarning ? tapWarning + " Use Clear taps to start again." : ""; }
      var big = document.getElementById("tap-next-big");
      if (big) big.textContent = next ? "Next to tap: \u201c" + next.text + "\u201d" : !lines.length ? "Paste the original lyrics first (step 2)." : "All lines tapped.";
      if (tappingLines) positionTapDock();
    }
    document.getElementById("btn-tap-start").textContent = tappingLines ? "Stop tapping" : "Start tapping";
    document.getElementById("tap-next").textContent = marked + " line start(s) tapped, " + (taps.length - marked) + " skipped. " +
      (next ? "Next: \u201c" + next.text + "\u201d" : "All lines done. Undo or Clear to redo.") + (tappingLines ? " Enter / Space taps; use Play / pause to pause." : "");
  }
  // v0.2.11 fix6e: one tap per line. Two taps very close together, or more taps than lines, usually mean line
  // ends were tapped too; say so gently and offer Clear taps.
  var tapWarning = "";
  function checkTapPattern(extraAttempt) {
    var taps = SS.lineTaps(session).filter(function (t) { return !t.skipped; }), lines = SS.tapLines ? SS.tapLines(session) : (session.lyrics && session.lyrics.lines || []);
    var close = 0;
    for (var i = 1; i < taps.length; i++) if (taps[i].t_ms - taps[i - 1].t_ms < 800) close++;
    var dur = player.hasAudio() ? player.duration() * 1000 : 0, ranOut = !SS.nextTapLine(session) && dur && player.currentTime() * 1000 < dur * 0.7;
    tapWarning = extraAttempt ? "More taps than lyric lines. Are you tapping line ends too? Tap only each line's first sound." :
      close ? close + " pair(s) of taps less than 0.8 s apart. Tap once per line (its first sound), not at line ends." :
      ranOut ? "All lines were tapped but most of the song is still to come. Were line ends tapped too? Tap once per line." : "";
  }
  function tapThisLine() {
    ensureLyricsFromBox();
    if (!player.hasAudio()) { setStatus("Open a song first.", "warn"); return; }
    var correction = Number(document.getElementById("tap-latency").value);
    var tap = SS.addLineTap(session, player.currentTime() * 1000, isFinite(correction) ? correction : -120);
    checkTapPattern(!tap);
    refreshTapUi(); draw();
  }
  // v0.2.11 fix7: Clear taps removes only the taps. Words placed from them keep their positions (no longer
  // labelled as tap-anchored); run Place words again to re-place them without taps.
  function clearTapsOnly() {
    var n = SS.clearLineTaps(session);
    (session.anchors || []).forEach(function (a) { if (a.tap_anchored) a.tap_anchored = false; });
    setStatus(n + " tap(s) cleared. Placed words were kept.", "info");
    var g1 = document.getElementById("g-status-1");
    if (g1 && g1.dataset.state !== "todo" && g1.dataset.state !== "running") {
      var ws = (session.lyrics && session.lyrics.words || []).filter(function (w) { return !w.skipped; });
      g1.textContent = stage1Label(ws) + " (taps cleared)";
    }
    return n;
  }
  document.getElementById("btn-tap-start").addEventListener("click", function () {
    ensureLyricsFromBox(); tappingLines = !tappingLines;
    if (tappingLines && document.activeElement && document.activeElement.blur) document.activeElement.blur(); // keys tap, never type into the lyrics
    refreshTapUi(); document.getElementById("btn-tap-start").blur();
  });
  document.getElementById("btn-tap-play").addEventListener("click", function () { if (player.hasAudio()) player.toggle().catch(function () {}); this.blur(); });
  document.getElementById("btn-tap-mark").addEventListener("click", function () { tapThisLine(); this.blur(); });
  document.getElementById("btn-tap-skip").addEventListener("click", function () { ensureLyricsFromBox(); SS.skipLineTap(session); refreshTapUi(); this.blur(); });
  document.getElementById("btn-tap-undo").addEventListener("click", function () { SS.undoLineTap(session); checkTapPattern(false); refreshTapUi(); draw(); this.blur(); });
  document.getElementById("btn-tap-clear").addEventListener("click", function () { if (!SS.lineTaps(session).length || confirm("Clear all line taps? Only the taps are removed; your placed words stay.")) { clearTapsOnly(); tapWarning = ""; refreshTapUi(); draw(); } this.blur(); });

  document.getElementById("tap-dock-clear").addEventListener("click", function () { if (confirm("Clear all line taps and start again? Only the taps are removed; your placed words stay.")) { clearTapsOnly(); tapWarning = ""; refreshTapUi(); draw(); } this.blur(); });
  document.getElementById("tap-dock-stop").addEventListener("click", function () { tappingLines = false; refreshTapUi(); draw(); });
  document.getElementById("tap-dock-play").addEventListener("click", function () { if (player.hasAudio()) player.toggle().catch(function () {}); this.blur(); });
  document.getElementById("tap-dock-mark").addEventListener("click", function () { tapThisLine(); this.blur(); });
  document.getElementById("tap-dock-skip").addEventListener("click", function () { ensureLyricsFromBox(); SS.skipLineTap(session); refreshTapUi(); draw(); this.blur(); });
  document.getElementById("tap-dock-undo").addEventListener("click", function () { SS.undoLineTap(session); checkTapPattern(false); refreshTapUi(); draw(); this.blur(); });
  document.getElementById("tap-dock-latency").addEventListener("input", function () { document.getElementById("tap-latency").value = this.value; });
  document.getElementById("tap-latency").addEventListener("input", function () { var dl = document.getElementById("tap-dock-latency"); if (dl) dl.value = this.value; });
  window.addEventListener("keydown", function (ev) {
    var tag = (ev.target && ev.target.tagName) || "";
    // v0.2.11 fix7: while tapping, Enter / Space in a text box tap the line instead of typing into the lyrics.
    if (tappingLines && tag === "TEXTAREA" && (ev.code === "Enter" || ev.code === "Space")) { ev.preventDefault(); if (!ev.repeat) { tapThisLine(); refreshTapUi(); draw(); } return; }
    if (tag === "INPUT" || tag === "TEXTAREA" || ev.target && ev.target.isContentEditable) return;
    if (tappingLines && !ev.altKey && (ev.code === "Space" || ev.code === "Enter" || ev.code === "Backspace" || (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z")) {
      ev.preventDefault(); if (ev.repeat) return;
      if (ev.code === "Backspace" || (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") { SS.undoLineTap(session); checkTapPattern(false); } else tapThisLine();
      refreshTapUi(); draw(); return;
    }
    if (ev.code === "Space") {
      ev.preventDefault();
      if (!player.hasAudio()) return;
      player.toggle().catch(function () {});
    } else if (ev.code === "ArrowLeft") {
      ev.preventDefault();
      seekSafely(player.currentTime() - (ev.shiftKey ? 5 : 1));
    } else if (ev.code === "ArrowRight") {
      ev.preventDefault();
      seekSafely(player.currentTime() + (ev.shiftKey ? 5 : 1));
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      undoStroke();
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      if (renderer.view.selectedId) {
        ev.preventDefault();
        deleteSelected();
      }
    } else if (ev.key.toLowerCase() === "l" && !ev.ctrlKey) {
      player.setLoop(null, null);
      document.getElementById("btn-loop").classList.remove("on");
      setStatus("Loop cleared.", "info");
      draw();
    }
  });

  window.addEventListener("resize", function () {
    renderer.resize();
    draw();
  });

  var raf = function () {
    if (player && player.tickLoop) player.tickLoop();
    if (recording && recorder.active && !player.paused()) {
      var rect = canvas.getBoundingClientRect();
      var y = renderer.yToNorm(lastY - rect.top);
      var result = SS.addPoint(session, recorder, nowMs(), y);
      if (result.status === "closed_on_backward_jump" || result.status === "closed_on_forward_jump") {
        recording = false;
        pointerHeld = false;
        refreshStrokeList();
        setStatus("Stroke closed because the playhead jumped. That prevents accidental joining across a seek.", "warn");
      }
    }
    draw();
    requestAnimationFrame(raf);
  };

  function loadDemo(withTraces) {
    if (!SS.buildDemoToneWav) {
      setStatus("Demo tone is missing. Open a local .wav with the file picker, or drop one on this page.", "warn");
      return Promise.resolve();
    }
    var buf = SS.buildDemoToneWav();
    return player.loadArrayBuffer(buf, SS.DEMO_TONE_NAME || "fictional_tone.wav", "audio/wav").then(function (info) {
      var name = SS.sanitizeLabel(info.name, SS.MAX_STRING_LEN) || "fictional_tone.wav";
      var durationMs = Math.round((info.duration || 0) * 1000);
      if (!SS.isFiniteNumber(durationMs) || durationMs < 0) durationMs = 0;
      session.audio = {
        name: name,
        included_in_export: false,
        duration_ms: durationMs
      };
      audioLabel.textContent = name + "  (" + formatTime(info.duration) + ")";
      setStatus("Loaded the fictional demo tone (a rise, a silence, a pickup, then a nosedive). No copyrighted audio. This was generated in the browser, so it works without a server.", "ok");
      if (withTraces) return loadExampleTraces();
      renderer.resize();
      draw();
    }).catch(function (err) {
      setStatus((err && err.message) || "Could not load the demo tone. Open a local .wav instead.", "warn");
    });
  }

  function loadDemoMp3() {
    if (!SS.buildDemoMp3) {
      setStatus("Demo MP3 is missing. Open demo/fictional_tone.mp3 with the file picker instead.", "warn");
      return Promise.resolve();
    }
    return player.loadArrayBuffer(SS.buildDemoMp3(), SS.DEMO_MP3_NAME || "fictional_tone.mp3", "audio/mpeg").then(function (info) {
      var name = SS.sanitizeLabel(info.name, SS.MAX_STRING_LEN) || "fictional_tone.mp3";
      var durationMs = Math.round((info.duration || 0) * 1000);
      if (!SS.isFiniteNumber(durationMs) || durationMs < 0) durationMs = 0;
      session.audio = { name: name, included_in_export: false, duration_ms: durationMs };
      audioLabel.textContent = name + "  (" + formatTime(info.duration) + ")";
      setStatus("Loaded the fictional demo tone as MP3, decoded locally by your browser. No copyrighted audio.", "ok");
      renderer.resize();
      draw();
    }).catch(function (err) {
      setStatus((err && err.message) || "This browser could not decode the demo MP3.", "warn");
    });
  }

  function loadExampleTraces() {
    var obj = SS.DEMO_EXAMPLE;
    if (!obj) {
      setStatus("Example traces are missing. Use Import JSON, or drop a Song Shape .json file on this page.", "warn");
      return Promise.resolve();
    }
    var audioMeta = session.audio;
    session = SS.parseSession(obj);
    document.getElementById("draft-baseline-hz").value = session.vocal_range ? String(session.vocal_range.baseline_hz) : session.draft && session.draft.baseline_hz ? String(session.draft.baseline_hz) : "";
      document.getElementById("draft-baseline-hz").readOnly = !!session.vocal_range; renderVocalRange();
    if (audioMeta && audioMeta.name) session.audio = audioMeta;
    recorder = SS.createRecorder();
    if (session.phrases && session.phrases[0]) {
      document.getElementById("phrase-label").value = session.phrases[0].text || "";
    }
    refreshStrokeList();
    refreshLyricsUi();
    document.getElementById("new-lyrics").value = session.replacement_lyrics || "";
    document.getElementById("extend-lyrics").value = session.extend_lyrics || "";
    renderHarmonyList();
    setStatus("Loaded the example annotation: rise to a peak, a timed break, a pickup, then a nosedive. Two strokes, one gap. Fictional data.", "ok");
    renderer.resize();
    draw();
    return Promise.resolve();
  }


  function audioTimeFromEvent(ev) {
    var pos = canvasXY(ev);
    var tSec = renderer.xToTime(pos.x, player.currentTime());
    var ms = Math.round((tSec + offsetMs() / 1000) * 1000);
    if (!SS.isFiniteNumber(ms) || ms < 0) ms = 0;
    return ms;
  }

  function placeWordAtEvent(ev) {
    ensureLyricsFromBox();
    var next = SS.nextWord(session);
    if (!next) {
      setStatus("No word left to place. Paste lyrics first, or undo / unskip.", "warn");
      return;
    }
    var ms = audioTimeFromEvent(ev);
    var anchor = SS.placeNextWord(session, { start_ms: ms, end_ms: ms, source: "next_word" });
    renderer.view.selectedAnchorId = anchor.id;
    refreshLyricsUi();
    draw();
    var more = SS.nextWord(session);
    setStatus(
      "Placed “" + next.text + "” at " + (ms / 1000).toFixed(2) + "s." +
        (more ? " Next: “" + more.text + "”." : " All placeable words are down.") +
        " Switch to Trace to draw gestures for this word — that will not advance the lyrics.",
      "ok"
    );
  }

  function beginAnchorDrag(anchorId, ev) {
    var a = (session.anchors || []).filter(function (x) { return x.id === anchorId; })[0];
    if (!a) return;
    anchorDrag = {
      id: anchorId,
      duration: Math.max(0, (a.end_ms || a.start_ms) - a.start_ms)
    };
    canvas.setPointerCapture && ev.pointerId != null && canvas.setPointerCapture(ev.pointerId);
    setStatus("Dragging “" + (SS.wordById(session, a.word_id) || {}).text + "”. Release to drop it. Token identity stays the same.", "info");
  }

  function moveAnchorDrag(ev) {
    if (!anchorDrag) return;
    var start = audioTimeFromEvent(ev);
    var end = start + (anchorDrag.duration || 0);
    SS.moveAnchor(session, anchorDrag.id, start, end);
    draw();
  }

  function endAnchorDrag() {
    if (!anchorDrag) return;
    var id = anchorDrag.id;
    anchorDrag = null;
    var a = (session.anchors || []).filter(function (x) { return x.id === id; })[0];
    if (a && a.needs_review) {
      setStatus("Moved the word. One or more linked strokes no longer overlap it and are marked for review.", "warn");
    } else {
      setStatus("Moved the word. Its identity and sequence are unchanged.", "ok");
    }
    refreshLyricsUi();
    draw();
  }

  // v0.2.9: pasted lyrics are cleaned first: [bracket] tags and (performance cues) are ignored.
  var lastLyricsInput = null;
  function setLyricsFromInput(text) {
    var res;
    try { res = SS.cleanLyricInput ? SS.cleanLyricInput(String(text || "")) : { text: String(text || "") }; }
    catch (e) { showLyricInputError("lyrics-input-note", "Original lyrics", e); throw e; }
    SS.setLyrics(session, res.text);
    lastLyricsInput = text;
    var note = SS.lyricInputNote ? SS.lyricInputNote(res) : "";
    var el = document.getElementById("lyrics-input-note");
    if (el) el.textContent = note ? "Original lyrics: " + note : "";
    return res;
  }
  (function () {
    var nl = document.getElementById("new-lyrics"), note = document.getElementById("new-lyrics-input-note");
    if (!nl || !note || !SS.cleanLyricInput) return;
    nl.addEventListener("input", function () {
      var msg = "";
      try { msg = SS.lyricInputNote(SS.cleanLyricInput(nl.value)); } catch (e) { showLyricInputError("new-lyrics-input-note", "Replacement lyrics", e); return; }
      note.textContent = msg ? "Replacement lyrics: " + msg : "";
      note.removeAttribute("data-kind");
    });
  })();
  // v0.2.10: standalone dashes are refused with a plain message (never a silent failure).
  function showLyricInputError(noteId, label, e) {
    var msg = label + ": " + String(e && e.message || e);
    var el = document.getElementById(noteId);
    if (el) { el.textContent = msg; el.setAttribute("data-kind", "error"); }
    setStatus(msg, "error");
  }
  (function () {
    var box = document.getElementById("lyrics-text");
    if (!box || !SS.findStandaloneDashes) return;
    box.addEventListener("input", function () {
      var el = document.getElementById("lyrics-input-note");
      var found = SS.findStandaloneDashes(box.value);
      if (found.length) {
        try { SS.cleanLyricInput(box.value); } catch (e) { showLyricInputError("lyrics-input-note", "Original lyrics", e); }
      } else if (el && el.getAttribute("data-kind") === "error") { el.textContent = ""; el.removeAttribute("data-kind"); }
    });
    window.addEventListener("error", function (ev) {
      var err = ev && ev.error;
      if (err && err.code === "SONG_SHAPE_STANDALONE_DASH") setStatus(String(err.message), "error");
    });
    window.addEventListener("unhandledrejection", function (ev) {
      var err = ev && ev.reason;
      if (err && err.code === "SONG_SHAPE_STANDALONE_DASH") setStatus(String(err.message), "error");
    });
  })();
  function ensureLyricsFromBox() {
    var box = document.getElementById("lyrics-text");
    if (!box) return;
    var text = box.value;
    var current = session.lyrics && session.lyrics.text ? session.lyrics.text : "";
    if (text === current || text === lastLyricsInput) return;
    if (SS.cleanLyricInput && SS.cleanLyricInput(text).text === current) return;
    if (lyricsChangeClearsWork(text) === false) { lastLyricsInput = text; return; }
    setLyricsFromInput(text);
    lyricsDirty = false;
  }

  function setMode(mode) {
    renderer.view.mode = mode === "trace" ? "trace" : "place";
    var placeBtn = document.getElementById("btn-mode-place");
    var traceBtn = document.getElementById("btn-mode-trace");
    if (placeBtn) placeBtn.classList.toggle("on", renderer.view.mode === "place");
    if (traceBtn) traceBtn.classList.toggle("on", renderer.view.mode === "trace");
    canvas.classList.toggle("mode-place", renderer.view.mode === "place");
    canvas.classList.toggle("mode-trace", renderer.view.mode === "trace");
  }

  function refreshLyricsUi() {
    if (document.getElementById("tap-next")) refreshTapUi();
    var box = document.getElementById("lyrics-text");
    if (box && document.activeElement !== box) {
      box.value = session.lyrics && session.lyrics.text ? session.lyrics.text : "";
    }
    var progress = SS.lyricsProgress ? SS.lyricsProgress(session) : { placed: 0, total: 0 };
    var progEl = document.getElementById("lyrics-progress");
    if (progEl) {
      progEl.textContent = progress.placed + " of " + progress.total + " words placed" +
        (progress.skipped ? " (" + progress.skipped + " skipped)" : "");
    }
    var next = SS.nextWord ? SS.nextWord(session) : null;
    var nextEl = document.getElementById("next-word-text");
    if (nextEl) nextEl.textContent = next ? next.text : "—";
    var title = document.getElementById("ref-title");
    var artist = document.getElementById("ref-artist");
    if (title && document.activeElement !== title) title.value = (session.reference && session.reference.title) || "";
    if (artist && document.activeElement !== artist) artist.value = (session.reference && session.reference.artist) || "";
    var ident = document.getElementById("performer-identity");
    if (ident && document.activeElement !== ident) {
      ident.value = (session.performer && session.performer.identity) || (SS.defaultPerformerIdentity ? SS.defaultPerformerIdentity() : "");
    }
    var parens = document.getElementById("chk-place-parentheses");
    if (parens && document.activeElement !== parens) {
      parens.checked = !!session.place_parentheses;
    }
    var harm = document.getElementById("chk-harmony");
    if (harm && document.activeElement !== harm) {
      var selected = selectedAnchor();
      harm.checked = !!(selected && selected.harmony);
    }
  }

  function selectedAnchor() {
    var id = renderer.view.selectedAnchorId;
    if (!id) return null;
    return (session.anchors || []).filter(function (a) { return a.id === id; })[0] || null;
  }

  function currentLoopTimes() {
    var loop = player.getLoop && player.getLoop();
    if (!loop) return null;
    var offset = offsetMs();
    return {
      start: Math.round((loop.start * 1000) + offset),
      end: Math.round((loop.end * 1000) + offset)
    };
  }

  document.getElementById("btn-mode-place").addEventListener("click", function () {
    setMode("place");
    setStatus("Place-word mode: click the plot to drop the next word. Tracing is disabled in this mode so a word is never consumed by a stroke.", "info");
  });
  document.getElementById("btn-mode-trace").addEventListener("click", function () {
    setMode("trace");
    setStatus("Trace mode: hold the left button while the song plays to draw. This never places a lyric. New strokes attach to the active word if one is selected, or stay unassigned.", "info");
  });
  document.getElementById("chk-draft").addEventListener("change", function (ev) {
    renderer.view.showDraft = ev.target.checked;
    draw();
  });

  // v0.2.11 fix7: the box fires "change" whenever it loses focus after any edit (even a stray Enter or space,
  // for example while tapping). Only a real change in the words resets placements, and only after asking.
  function lyricsChangeClearsWork(text) {
    var cleaned;
    try { cleaned = SS.cleanLyricInput ? SS.cleanLyricInput(String(text || "")).text : String(text || ""); } catch (e) { return null; }
    var current = session.lyrics && session.lyrics.text != null ? session.lyrics.text : "";
    var norm = function (t) { return String(t || "").replace(/\r\n?/g, "\n").split("\n").map(function (l) { return l.trim(); }).filter(Boolean).join("\n"); };
    return norm(cleaned) === norm(current) ? false : true;
  }
  document.getElementById("lyrics-text").addEventListener("change", function () {
    var changed = lyricsChangeClearsWork(this.value);
    if (changed === false) { lastLyricsInput = this.value; return; }
    var placed = (session.anchors || []).length, taps = SS.lineTaps(session).length;
    if (changed && (placed || taps) && !window.confirm("The original lyrics changed. Updating them clears " + placed + " placed word(s)" + (taps ? " and " + taps + " line tap(s)" : "") + " because the word list changes. Update the lyrics?")) {
      this.value = lastLyricsInput != null ? lastLyricsInput : (session.lyrics && session.lyrics.text) || "";
      setStatus("Lyrics edit undone: your placed words and taps are kept.", "info");
      return;
    }
    setLyricsFromInput(this.value);
    renderer.view.selectedAnchorId = null;
    refreshLyricsUi();
    setStatus("Lyrics updated. Existing word placements were cleared because the token list changed.", "info");
    draw();
  });
  document.getElementById("chk-place-parentheses").addEventListener("change", function () {
    SS.setPlaceParentheses(session, this.checked);
    renderer.view.selectedAnchorId = null;
    refreshLyricsUi();
    draw();
    setStatus(this.checked
      ? "Words inside (parentheses) will be placed as backing vocals / ad-libs. Word placements were cleared."
      : "Words inside (parentheses) will not be placed. Bracket cues are never placed as words. Word placements were cleared.",
      "info");
  });

  var skipHistory = []; // v0.2.11: Undo word also undoes a Skip made after the last placement
  document.getElementById("btn-skip-word").addEventListener("click", function () {
    ensureLyricsFromBox();
    var next = SS.nextWord(session);
    if (!next) {
      setStatus("No word to skip.", "warn");
      return;
    }
    SS.skipNextWord(session);
    skipHistory.push({ word_id: next.id, anchors: session.anchors.length });
    refreshLyricsUi();
    var after = SS.nextWord(session);
    setStatus("Skipped “" + next.text + "”." + (after ? " Next: “" + after.text + "”." : ""), "ok");
  });

  document.getElementById("btn-place-line").addEventListener("click", function () {
    ensureLyricsFromBox();
    var times = currentLoopTimes();
    var start = times ? times.start : Math.round((player.currentTime() + offsetMs() / 1000) * 1000);
    var end = times ? times.end : start;
    var placed = SS.placeNextLine(session, { start_ms: start, end_ms: end, source: "next_line" });
    if (!placed.length) {
      setStatus("No line left to place.", "warn");
      return;
    }
    renderer.view.selectedAnchorId = placed[placed.length - 1].id;
    refreshLyricsUi();
    draw();
    setStatus("Placed " + placed.length + " word(s) from the current line.", "ok");
  });

  document.getElementById("btn-undo-word").addEventListener("click", function () {
    var lastSkip = skipHistory[skipHistory.length - 1];
    if (lastSkip && lastSkip.anchors === session.anchors.length) {
      skipHistory.pop();
      var back = SS.unskipWord(session, lastSkip.word_id);
      refreshLyricsUi(); draw();
      setStatus("Un-skipped “" + (back ? back.text : "word") + "”. It is the next word to place again.", "ok");
      return;
    }
    var nStrokes = session.strokes.length;
    var removed = SS.undoLastAnchor(session);
    if (!removed || !removed.length) {
      setStatus("No placed word to undo.", "info");
      return;
    }
    renderer.view.selectedAnchorId = session.anchors.length ? session.anchors[session.anchors.length - 1].id : null;
    refreshLyricsUi();
    draw();
    setStatus("Stepped back one word. " + nStrokes + " stroke(s) remain; undoing a word does not delete traces.", "ok");
  });

  document.getElementById("btn-clear-words").addEventListener("click", function () {
    if (!session.anchors.length) {
      setLyricsFromInput(document.getElementById("lyrics-text").value);
      refreshLyricsUi();
      return;
    }
    if (!window.confirm("Clear ALL " + session.anchors.length + " placed word(s)? Line taps and strokes stay. (To remove only the taps, use Clear taps in step 6.)")) return;
    SS.clearAnchors(session);
    renderer.view.selectedAnchorId = null;
    refreshLyricsUi();
    draw();
    setStatus("Word placements cleared. Strokes were left in place.", "info");
  });

  document.getElementById("chk-harmony").addEventListener("change", function () {
    var a = selectedAnchor();
    if (!a) {
      this.checked = false;
      setStatus("Select a placed word first, then mark harmony with the lead.", "warn");
      return;
    }
    SS.setHarmonyOnWord(session, a.word_id, this.checked);
    if (this.checked) session.performer.allow_harmony = true;
    refreshLyricsUi();
    draw();
    setStatus(this.checked
      ? "Marked “" + (SS.wordById(session, a.word_id) || {}).text + "” as harmony with the lead. Export will add a backing-harmony cue on that line."
      : "Harmony mark removed. That line will export as solo lead.",
      "ok");
  });

  document.getElementById("btn-harmony-line").addEventListener("click", function () {
    var a = selectedAnchor();
    if (!a) {
      setStatus("Select a word on the line first.", "warn");
      return;
    }
    SS.setHarmonyOnLine(session, a.line_id, true);
    session.performer.allow_harmony = true;
    refreshLyricsUi();
    draw();
    setStatus("This line is marked as backing harmony under the same lead. The following solo line will stay solo unless you mark it too.", "ok");
  });

  document.getElementById("btn-harmony-loop").addEventListener("click", function () {
    var times = currentLoopTimes();
    if (!times) {
      setStatus("Drag across the time ruler to set a loop, then mark that range as harmony with the lead.", "warn");
      return;
    }
    SS.setHarmonyRange(session, times.start, times.end, true);
    session.performer.allow_harmony = true;
    refreshLyricsUi();
    draw();
    setStatus("The loop is a harmony range under the same lead.", "ok");
  });

  function syncReferenceFromFields() {
    session.reference = session.reference || { title: "", artist: "" };
    session.reference.title = document.getElementById("ref-title").value;
    session.reference.artist = document.getElementById("ref-artist").value;
    session.performer = session.performer || { identity: "", allow_harmony: false };
    session.performer.identity = document.getElementById("performer-identity").value;
  }
  ["ref-title", "ref-artist", "performer-identity"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", syncReferenceFromFields);
  });

  function currentSheetText() {
    syncReferenceFromFields();
    ensureLyricsFromBox();
    var sheet = SS.buildLyricSheet(session, {
      title: session.reference && session.reference.title ? session.reference.title : ""
    });
    return sheet.text || "";
  }

  document.getElementById("btn-copy-sheet").addEventListener("click", function () {
    var text = currentSheetText();
    if (!text) {
      setStatus("Paste lyrics first.", "warn");
      return;
    }
    copyText(text, "Copied the lyric sheet. " + (SS.SUNO_LIMITATIONS || ""));
  });
  document.getElementById("btn-save-sheet").addEventListener("click", function () {
    var text = currentSheetText();
    if (!text) {
      setStatus("Paste lyrics first.", "warn");
      return;
    }
    var blob = new Blob([text + "\n\n" + (SS.SUNO_LIMITATIONS || "") + "\n"], { type: "text/plain;charset=utf-8" });
    var name = suggestName("txt");
    if (name.slice(-4) === ".txt") name = name.slice(0, -4) + "-lyric-sheet.txt";
    downloadBlob(blob, name);
    setStatus("Saved the lyric sheet. Suno-style cues are suggestions, not promised control.", "ok");
  });

  function mapOptions() {
    var el = document.getElementById("chk-exclude-unconfirmed-ai");
    return { excludeUnconfirmedAi: !!(el && el.checked) };
  }
  function extendOn() { var el = document.getElementById("chk-extend"); return !!(el && el.checked && SS.buildExtendTransfer); }
  function contourTransfer(newLyrics, opts) {
    var performanceMap = SS.buildPerformanceMap(SS.sessionToJSON(session), mapOptions());
    // v0.2.11 fix6: Extend maps your sections onto the reference sections; new sections inherit a styled section.
    if (extendOn()) {
      var ext = SS.buildExtendTransfer(performanceMap, newLyrics, opts || {});
      if (ext.refs.length) return { map: performanceMap, transfer: ext.transfer, extend: ext };
    }
    return { map: performanceMap, transfer: SS.buildTransfer(performanceMap, newLyrics), extend: null };
  }

  function fullHandoff(newLyrics, opts) {
    var result = contourTransfer(newLyrics, opts);
    return { map: result.map, transfer: result.transfer, extend: result.extend, handoff: SS.makeHandoff(result.map, result.transfer) };
  }
  function privateMappingRequest(newLyrics) {
    return fullHandoff(newLyrics).handoff.prompt; // plain text for Copy/Save
  }

  document.getElementById("btn-save-vocal-map").addEventListener("click", function () {
    syncReferenceFromFields();
    ensureLyricsFromBox();
    try {
      var detailed = SS.buildPerformanceMap(SS.sessionToJSON(session));
      var filename = suggestName("json").replace(/\.json$/, "-vocal-map.json");
      downloadBlob(new Blob([JSON.stringify(detailed, null, 2)], { type: "application/json" }), filename);
      setStatus("Exported full local vocal map. It contains the supplied reference lyrics, but no audio or API key.", "ok");
    } catch (err) { setStatus("Could not export vocal map: " + err.message, "warn"); }
  });

  document.getElementById("new-lyrics").addEventListener("input", function (ev) {
    session.replacement_lyrics = ev.target.value;
  });

  document.getElementById("btn-map-request").addEventListener("click", function () {
    syncReferenceFromFields();
    ensureLyricsFromBox();
    var mine = document.getElementById("new-lyrics").value;
    var request = privateMappingRequest(mine);
    document.getElementById("map-output").value = request; lastSheet = { full: "", label: "AI request (not for Suno)" }; updateSunoCount();
    copyText(request, "Copied an AI-ready request with your original lyrics and contour events. Reference lyrics and audio were omitted. Nothing was sent.");
  });
  document.getElementById("btn-map-request-save").addEventListener("click", function () {
    syncReferenceFromFields();
    ensureLyricsFromBox();
    var mine = document.getElementById("new-lyrics").value;
    var request = privateMappingRequest(mine);
    document.getElementById("map-output").value = request; lastSheet = { full: "", label: "AI request (not for Suno)" }; updateSunoCount();
    var blob = new Blob([request], { type: "text/plain;charset=utf-8" });
    var name = "songshape-ai-request.txt"; // Do not leak source title via filename.
    downloadBlob(blob, name);
    setStatus("Saved the mapping request as a .txt file. Nothing was uploaded.", "ok");
  });
  function localSheet(mine, opts) {
    syncReferenceFromFields();
    ensureLyricsFromBox();
    var mapped = fullHandoff(mine, opts);
    var directions = SS.exportDirections(mapped.map, mapped.transfer);
    var review = mapped.handoff.rows.filter(function (row) { return row.status === "needs_review"; });
    // v0.2.11: the pasteable sheet holds only the lyrics with tags. Style prompt and notes are separate.
    var untagged = mapped.handoff.rows.filter(function (row) { return !(row.cpu_tags || []).length; }).map(function (row) { return row.text; });
    var fitNotes = mapped.handoff.rows.filter(function (row) { return (row.fit_notes || []).length; }).length;
    var notes = (review.length ? review.length + " line(s) need your ear: " + review.slice(0, 6).map(function (r) { return "“" + r.text + "”"; }).join(", ") + (review.length > 6 ? "…" : "") + ".\n" : "No line needs a timing check.\n") +
      (fitNotes ? fitNotes + " line(s) have a different word count from the reference line (normal for new lyrics; check the syllable fit).\n" : "") +
      (untagged.length ? untagged.length + " line(s) got no delivery tag (no contour measured there): " + untagged.slice(0, 6).map(function (t) { return "“" + t + "”"; }).join(", ") + ".\n" : "") +
      mapped.handoff.caveats + "\n" + (SS.SUNO_LIMITATIONS || "");
    var text = mapped.handoff.lyrics + "\n\n[Style prompt]\n" + directions.style;
    var extNotes = mapped.extend ? mapped.extend.notes : (extendOn() ? "No reference sections yet: place the reference words (step 7) first." : "");
    var extEl = document.getElementById("extend-notes");
    if (extEl) extEl.value = extNotes;
    if (mapped.extend) notes = mapped.extend.notes.split("\n")[0] + " Section notes are in Extend.\n" + notes;
    return { text: text, lyrics: mapped.handoff.lyrics, style: directions.style, notes: notes, extend: mapped.extend, review: review.length, untagged: untagged.length, lines: mapped.handoff.rows.length, mapped: mapped };
  }
  // v0.2.11 fix6d: Suno character budget. The paste box holds the sheet fitted to the chosen limit
  // (nothing shortened when the full sheet fits); the full sheet is kept for "No limit".
  var lastSheet = { full: "", label: "" };
  function sunoBudget() {
    var el = document.getElementById("suno-budget");
    var v = el ? parseInt(el.value, 10) : 5000;
    return isFinite(v) ? v : 5000;
  }
  function updateSunoCount() {
    var out = document.getElementById("map-output"), el = document.getElementById("suno-count");
    if (!out || !el || !SS.sheetChars) return;
    var n = SS.sheetChars(out.value), b = sunoBudget(), f = lastSheet.fit;
    var fmt = function (x) { return x.toLocaleString("en-US"); };
    var txt = (lastSheet.label ? lastSheet.label + ": " : "") + fmt(n) + " used" + (b ? " · " + fmt(Math.max(0, b - n)) + " left of " + fmt(b) : " (no limit)") +
      (f && f.text === out.value ? " (lyrics + line tags " + fmt(f.core_length) + " · global description " + fmt(f.global_length) + (f.harmony_notes ? " · harmony notes " + fmt(f.harmony_notes_length) : "") + ")" : "") + (b && n > b ? " — over the limit" : "");
    el.textContent = txt;
    el.className = "hint" + ((b && n > b) || (f && f.line_tags_shortened) ? " warn-text" : "");
    var s2 = document.getElementById("suno-count-step2");
    if (s2) s2.textContent = lastSheet.label === "Step 2 sheet" ? "In Lyrics for Suno: " + txt.replace(/^Step 2 sheet: /, "") + "." : "";
  }
  function putSheet(text, label) {
    lastSheet = { full: String(text || ""), label: label || "", fit: null };
    var b = sunoBudget(), fit = null, out = document.getElementById("map-output");
    if (b && SS.fitSunoBudget && lastSheet.full) {
      try { fit = SS.fitSunoBudget(lastSheet.full, { budget: b }); } catch (err) { fit = null; }
    }
    out.value = fit ? fit.text : lastSheet.full;
    lastSheet.fit = fit;
    var note = document.getElementById("suno-fit-note");
    if (note) note.textContent = fit ? SS.sunoBudgetNote(fit) : (b ? "" : "No limit: the full sheet is shown (" + SS.sheetChars(lastSheet.full).toLocaleString("en-US") + " characters).");
    if (note) note.className = "hint" + (fit && (fit.lyrics_over_budget || fit.line_tags_shortened) ? " warn-text" : "");
    updateSunoCount();
    return fit;
  }
  (function () {
    var sel = document.getElementById("suno-budget");
    if (!sel) return;
    try { var saved = localStorage.getItem("songshape.sunoBudget"); if (saved != null && sel.querySelector('option[value="' + saved + '"]')) sel.value = saved; } catch (e) { /* storage off */ }
    sel.addEventListener("change", function () {
      try { localStorage.setItem("songshape.sunoBudget", sel.value); } catch (e) { /* storage off */ }
      if (lastSheet.full) putSheet(lastSheet.full, lastSheet.label); else updateSunoCount();
    });
  })();
  function showSheet(r, label) {
    r.fit = putSheet(r.lyrics, label || "Step 1 sheet");
    if (r.fit && (r.fit.lyrics_over_budget || r.fit.line_tags_shortened)) setTimeout(function () { setStatus(SS.sunoBudgetNote(r.fit), "warn"); }, 0);
    document.getElementById("map-style").value = r.style;
    document.getElementById("map-notes").textContent = (r.fit && r.fit.shortened ? SS.sunoBudgetNote(r.fit) + "\n" : "") + r.notes;
    var box = document.getElementById("map-output");
    if (box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "center" });
    return r;
  }
  function copyFrom(id, label) {
    var v = document.getElementById(id).value;
    if (!v) { setStatus("Nothing to copy yet. Run step 10 first.", "warn"); return; }
    (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(v) : Promise.reject(new Error("no clipboard")))
      .then(function () { setStatus("Copied the " + label + ".", "ok"); }, function () { var el = document.getElementById(id); el.focus(); el.select(); setStatus("Press Ctrl+C to copy the selected " + label + ".", "info"); });
  }
  document.getElementById("btn-copy-lyrics").addEventListener("click", function () { copyFrom("map-output", "lyrics"); });
  document.getElementById("btn-copy-style").addEventListener("click", function () { copyFrom("map-style", "style prompt"); });
  document.getElementById("btn-copy-extend").addEventListener("click", function () { copyFrom("extend-notes", "section notes"); });
  // v0.2.11 fix6b: the two steps of Ben's story. Step 1 maps your lyrics onto the reference performance;
  // Step 2 extends that style with sections marked [New ...], anywhere in the song.
  document.getElementById("btn-step1-sheet").addEventListener("click", function () {
    var mine = document.getElementById("new-lyrics").value;
    if (!mine.trim()) { setStatus("Step 1: paste your lyrics first.", "warn"); return; }
    try {
      var r = showSheet(localSheet(mine));
      setStatus("Step 1 done: your lyrics are mapped to the reference performance. Copy the sheet from Lyrics for Suno. " + (r.fit ? SS.sunoBudgetNote(r.fit) + " " : "") + (r.extend ? r.extend.notes.split("\n")[0] : ""), r.fit && r.fit.lyrics_over_budget ? "warn" : "ok");
    } catch (err) { setStatus(err.message || String(err), "warn"); }
  });
  document.getElementById("extend-lyrics").addEventListener("input", function (ev) { session.extend_lyrics = ev.target.value; });
  document.getElementById("btn-extend-from-step1").addEventListener("click", function () {
    var box = document.getElementById("extend-lyrics"), mine = document.getElementById("new-lyrics").value;
    if (!mine.trim()) { setStatus("Paste your Step 1 lyrics first.", "warn"); return; }
    if (box.value.trim() && box.value !== mine && !confirm("Replace your Step 2 text with your Step 1 lyrics?")) return;
    box.value = mine; session.extend_lyrics = mine; box.focus();
    setStatus("Step 2: add each new section where you want it, with a line such as [New Verse] above it, then click Extend in that style.", "info");
  });
  function mappedLines(text) {
    return SS.parseExtendBlocks(text).filter(function (b) { return !b.marked_new; })
      .reduce(function (a, b) { return a.concat(b.texts); }, []).map(function (l) { return l.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); });
  }
  // v0.2.11 fix6d: vocal performance JSON for each step (for a reasoning AI helping with tag mapping).
  function downloadVocalJson(step) {
    var text = step === 2 ? document.getElementById("extend-lyrics").value : document.getElementById("new-lyrics").value;
    if (!text.trim()) { setStatus(step === 2 ? "Step 2: add your extended lyrics first." : "Step 1: paste your lyrics first.", "warn"); return; }
    try {
      syncReferenceFromFields();
      ensureLyricsFromBox();
      var lift = step === 2 && !!(document.getElementById("chk-extend-lift") || {}).checked;
      var m = fullHandoff(text, { lift: lift });
      var b = sunoBudget();
      var fit = b && SS.fitSunoBudget ? SS.fitSunoBudget(m.handoff.lyrics, { budget: b }) : null;
      var json = SS.buildPerformanceJson({ map: m.map, transfer: m.transfer, handoff: m.handoff, refs: m.extend ? m.extend.refs : [], step: step, sheet: fit,
        includeReferenceText: !!(document.getElementById("chk-json-ref-text") || {}).checked, appVersion: SS.APP_VERSION });
      downloadBlob(new Blob([JSON.stringify(json, null, 1)], { type: "application/json" }), "songshape-step" + step + "-vocal-performance.json");
      setStatus("Saved the Step " + step + " vocal performance JSON (" + json.sections.length + " sections" + (lift ? ", Lift on" : "") + "). Nothing was sent; no audio is inside." +
        (json.contains_reference_lyric_text ? " It includes the reference lyric lines: keep it private." : ""), "ok");
    } catch (err) { setStatus(err.message || String(err), "warn"); }
  }
  document.getElementById("btn-step1-json").addEventListener("click", function () { downloadVocalJson(1); });
  document.getElementById("btn-step2-json").addEventListener("click", function () { downloadVocalJson(2); });
  document.getElementById("chk-extend-lift").addEventListener("change", function () {
    if (lastSheet.label === "Step 2 sheet") document.getElementById("btn-step2-sheet").click();
  });
  document.getElementById("btn-step2-sheet").addEventListener("click", function () {
    var text = document.getElementById("extend-lyrics").value, mine = document.getElementById("new-lyrics").value;
    var check = document.getElementById("extend-check");
    if (!text.trim()) { setStatus("Step 2: click Start from my Step 1 lyrics, then add sections marked [New Verse] (or [New Chorus], [New]).", "warn"); return; }
    try {
      var notes = [];
      if (mine.trim()) {
        var a = mappedLines(mine), b = mappedLines(text), i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
        if (i < a.length || i < b.length) notes.push("Outside the [New …] sections your Step 2 lyrics differ from Step 1 (first at Step 1 line " + (i + 1) + "); the sheet uses the Step 2 text as written.");
      }
      var lift = !!(document.getElementById("chk-extend-lift") || {}).checked;
      var r = showSheet(localSheet(text, { lift: lift }), "Step 2 sheet");
      if (lift) notes.push("Lift is on: new sections are stepped up (see the JSON for what changed).");
      var plan = r.extend ? r.extend.plan : [];
      var added = plan.filter(function (p) { return !p.mapped; });
      notes.unshift(added.length ? added.length + " new section(s): " + added.map(function (p) {
        return p.label + " \u201c" + (p.block.texts[0] || "") + "\u201d" + (p.inherits_from != null ? " (tags of your " + plan[p.inherits_from].label + ")" : p.ref ? " (tags of the reference " + p.ref.label + ")" : "");
      }).join("; ") + "." : "No section is marked new yet: put a line such as [New Verse] above each added section.");
      check.textContent = notes.join(" ");
      setStatus("Step 2 done: extended sheet in Lyrics for Suno. " + notes[0] + (r.fit ? " " + SS.sunoBudgetNote(r.fit) : ""), added.length && !(r.fit && r.fit.lyrics_over_budget) ? "ok" : "warn");
    } catch (err) { setStatus(err.message || String(err), "warn"); }
  });
  function stageResult(text) { var el = document.getElementById("stage-result"); el.hidden = !text; el.textContent = text || ""; }
  document.getElementById("btn-map-sheet").addEventListener("click", function () {
    var mine = document.getElementById("new-lyrics").value;
    showSheet(localSheet(mine));
    setStatus("Built a contour-directed draft locally. Review warnings and syllable fit; no AI or audio upload.", "ok");
  });
  // Stage 4 with AI: the one send-and-check path (same as the CLI ai-sheet).
  function aiSheet(mine) {
    syncReferenceFromFields();
    ensureLyricsFromBox();
    var prompt = privateMappingRequest(mine);
    return SS.sendAndCheckSheet(prompt, mine, function (messages) {
      return SS.sendAiChatAsync(messages, { timeoutMs: 300000 });
    });
  }
  function sheetCheckNote(check) {
    if (!check) return "";
    return check.ok ? "All " + check.lyric_lines + " lyric lines are present." + (check.format_warnings && check.format_warnings.length ? " Format: " + check.format_warnings.join("; ") + "." : "") :
      check.missing_lines.length + " lyric line(s) missing from the model's sheet — review: " + check.missing_lines.slice(0, 3).join(" | ") +
      (check.format_warnings && check.format_warnings.length ? " Format: " + check.format_warnings.join("; ") + "." : "");
  }
  document.getElementById("btn-map-send").addEventListener("click", function () {
    syncReferenceFromFields();
    ensureLyricsFromBox();
    var cfg = SS.getAiConfig ? SS.getAiConfig() : { enabled: false };
    if (!cfg.enabled || !cfg.baseUrl) {
      setStatus("Connect your AI first (optional, off by default), enable it, and set a base URL. On file:// some browsers block localhost.", "warn");
      return;
    }
    var mine = document.getElementById("new-lyrics").value;
    document.getElementById("map-output").value = "Sending…";
    setStatus("Sending the mapping request to your endpoint. The key is not written into any export.", "info");
    aiSheet(mine).then(function (res) {
      putSheet(res.text, "AI sheet");
      setStatus("Validated the model’s lyric sheet. It was not executed — only shown. " + sheetCheckNote(res.check), res.check.ok ? "ok" : "warn");
    }).catch(function (err) {
      document.getElementById("map-output").value = ""; lastSheet = { full: "", label: "" }; updateSunoCount();
      setStatus((err.message || String(err)) + localFetchHint(), "warn");
    });
  });

  function currentDraftViewMs() {
    var vis = renderer.visibleRange ? renderer.visibleRange(player.currentTime()) : null;
    if (!vis) return null;
    return { startMs: vis.t0 * 1000, endMs: vis.t1 * 1000 };
  }

  function currentDraftLoopMs() {
    var loop = player.getLoop && player.getLoop();
    if (!loop) return null;
    return { startMs: loop.start * 1000, endMs: loop.end * 1000 };
  }

  function syncDraftViewDefault() {
    var box = document.getElementById("chk-draft-view");
    if (!box || draftViewManual) return;
    var durationMs = Math.round((player.duration && player.duration() ? player.duration() : 0) * 1000);
    if (session.audio && session.audio.duration_ms && !durationMs) durationMs = session.audio.duration_ms;
    box.checked = SS.shouldDefaultDraftOnlyView({
      durationMs: durationMs,
      view: currentDraftViewMs(),
      loop: currentDraftLoopMs()
    });
  }

  function setDraftMessage(text, kind) {
    var el = document.getElementById("draft-message");
    if (el) {
      if (text) {
        el.hidden = false;
        el.textContent = text;
        el.setAttribute("data-kind", kind || "info");
      } else {
        el.hidden = true;
        el.textContent = "";
      }
    }
    if (text) setStatus(text, kind);
  }

  function setDraftProgress(percent, label) {
    var wrap = document.getElementById("draft-progress-wrap");
    var text = document.getElementById("draft-progress-text");
    var bar = document.getElementById("draft-progress-bar");
    if (wrap) wrap.hidden = false;
    var pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
    if (text) text.textContent = (label || "Measuring pitch…") + " " + pct + "%";
    if (bar) bar.value = pct;
    var g2 = document.getElementById("g-status-2");
    if (g2 && g2.dataset.state === "running") g2.textContent = (label || "Measuring pitch…") + " " + pct + "%";
  }

  function hideDraftProgress() {
    var wrap = document.getElementById("draft-progress-wrap");
    if (wrap) wrap.hidden = true;
  }

  function highlightOpenWav() {
    var btn = document.getElementById("btn-open");
    if (!btn) return;
    btn.classList.add("attention");
    setTimeout(function () { btn.classList.remove("attention"); }, 2800);
    try { btn.focus(); } catch (e) {}
  }

  function setDraftRunning(running) {
    var build = document.getElementById("btn-build-draft");
    var cancel = document.getElementById("btn-cancel-draft");
    var view = document.getElementById("chk-draft-view");
    if (build) build.disabled = !!running;
    if (cancel) cancel.hidden = !running;
    if (view) view.disabled = !!running;
  }

  function finishDraftJob() {
    draftJob = null;
    setDraftRunning(false);
    hideDraftProgress();
  }

  function revealDraft(draft, range) {
    renderer.view.showDraft = true;
    var chk = document.getElementById("chk-draft");
    if (chk) chk.checked = true;
    var startSec = null;
    var endSec = null;
    if (draft && draft.strokes && draft.strokes.length) {
      startSec = draft.strokes[0].start_ms / 1000;
      endSec = draft.strokes[draft.strokes.length - 1].end_ms / 1000;
    } else if (range && range.endMs > range.startMs) {
      startSec = range.startMs / 1000;
      endSec = range.endMs / 1000;
    }
    if (startSec == null) {
      draw();
      return;
    }
    if (endSec == null || endSec <= startSec) endSec = startSec + 1;
    var L = renderer.layout ? renderer.layout() : null;
    var width = L && L.plot ? L.plot.w : 800;
    var span = Math.max(0.75, endSec - startSec);
    var fit = width / (span * 1.25);
    if (fit < 30) fit = 30;
    if (fit > 400) fit = 400;
    renderer.view.pixelsPerSecond = fit;
    var zoom = document.getElementById("zoom");
    var zoomVal = document.getElementById("zoom-val");
    if (zoom) zoom.value = String(Math.round(fit));
    if (zoomVal) zoomVal.textContent = Math.round(fit) + " px/s";
    seekSafely(Math.max(0, startSec));
    draw();
  }

  function handleNoAudioDraft() {
    var planned = SS.planDraftJob({ hasAudio: false });
    setDraftMessage(planned.message, "warn");
    if (planned.highlightOpen) highlightOpenWav();
    return planned;
  }

  document.getElementById("chk-draft-view").addEventListener("change", function () {
    draftViewManual = true;
  });

  document.getElementById("btn-cancel-draft").addEventListener("click", function () {
    if (draftJob && draftJob.cancel) draftJob.cancel.canceled = true;
    if (draftJob && draftJob.cancel && draftJob.cancel._cleanup) {
      try { draftJob.cancel._cleanup(); } catch (e) {}
    }
    finishDraftJob();
    setDraftMessage("Draft analysis canceled.", "info");
  });

  document.getElementById("btn-build-draft").addEventListener("click", function () {
    if (draftJob) return;
    var buf = player.getAudioBuffer && player.getAudioBuffer();
    var hasAudio = !!(buf && buf.length && buf.sampleRate);
    if (!hasAudio) {
      handleNoAudioDraft();
      return;
    }
    setDraftMessage("", "info");
    var durationMs = Math.round((buf.duration || (buf.length / buf.sampleRate) || 0) * 1000);
    var planned = SS.planDraftJob({
      hasAudio: true,
      durationMs: durationMs,
      onlyView: document.getElementById("chk-draft-view").checked,
      view: currentDraftViewMs(),
      loop: currentDraftLoopMs()
    });
    var baselineText = document.getElementById("draft-baseline-hz").value.trim();
    var fixedBaselineHz = baselineText ? Number(baselineText) : null;
    if (baselineText && (!Number.isFinite(fixedBaselineHz) || fixedBaselineHz < 40 || fixedBaselineHz > 20000)) {
      setDraftMessage("Choose a fixed reference between 40 and 20000 Hz, or leave it blank for automatic estimation.", "warn");
      return;
    }
    var cancel = { canceled: false };
    draftJob = { cancel: cancel };
    setDraftRunning(true);
    setDraftProgress(0, "Preparing audio…");
    setStatus("Measuring pitch… 0%", "info");

    setTimeout(function () {
      if (cancel.canceled) return;
      var samples;
      try {
        var channel = buf.getChannelData(0);
        samples = new Float32Array(channel.length);
        samples.set(channel);
      } catch (err) {
        finishDraftJob();
        setDraftMessage(err && err.message ? err.message : "Could not read the audio samples.", "warn");
        return;
      }
      setDraftProgress(0, "Measuring pitch…");
      var opts = {
        winMs: 40,
        hopMs: 20,
        startMs: planned.startMs,
        endMs: planned.endMs,
        cancel: cancel,
        onProgress: function (p) {
          setDraftProgress(p.percent, "Measuring pitch…");
          setStatus("Measuring pitch… " + p.percent + "%", "info");
        }
      };
      SS.analyzePitchLoudnessAsync(samples, buf.sampleRate, Object.assign(opts, {silenceRms: SS.adaptiveSilenceRms(samples, buf.sampleRate)})).then(function (frames) {
        if (cancel.canceled) return;
        var draft = SS.buildDraft(frames, { baselineHz: session.vocal_range ? null : fixedBaselineHz, range: session.vocal_range, cleanup: true });
        session.draft = draft;
        if (!session.vocal_range) document.getElementById("draft-baseline-hz").value = String(Number(draft.baseline_hz.toFixed(4)));
        var n = draft.strokes ? draft.strokes.length : 0;
        revealDraft(draft, planned);
        finishDraftJob();
        var rangeBit = planned.onlyView
          ? " for the current view / selection (" + (planned.startMs / 1000).toFixed(1) + "–" + (planned.endMs / 1000).toFixed(1) + "s)"
          : "";
        if (!n) {
          setDraftMessage(
            "No pitch was found" + rangeBit + " — the region looks like silence or was below the detector. Try a sung section, or uncheck “Draft only the current view / selection” to measure more of the file. This is measured pitch, not the hand trace.",
            "warn"
          );
          return;
        }
        setDraftMessage(
          "Draft layer ready" + rangeBit + ": " + n + " stroke" + (n === 1 ? "" : "s") +
            " of measured pitch and loudness (teal dashed line). It is not the hand trace. Accept it, or keep tracing by ear.",
          "ok"
        );
      }).catch(function (err) {
        if (cancel.canceled || (err && err.code === "CANCELED")) {
          finishDraftJob();
          setDraftMessage("Draft analysis canceled.", "info");
          return;
        }
        finishDraftJob();
        setDraftMessage(err && err.message ? err.message : "Could not build a draft from this audio.", "warn");
      });
    }, 0);
  });
  document.getElementById("btn-accept-draft").addEventListener("click", function () {
    if (!session.draft || !session.draft.strokes || !session.draft.strokes.length) {
      setStatus("Build a draft first.", "warn");
      return;
    }
    SS.acceptDraft(session);
    refreshStrokeList();
    draw();
    setStatus("Accepted draft candidates as editable machine-origin strokes; original hand strokes and word anchors are preserved. Repeated acceptance creates no duplicates.", "ok");
  });
  document.getElementById("btn-clear-draft").addEventListener("click", function () {
    session.draft = SS.emptyDraft ? SS.emptyDraft() : null;
    draw();
    setStatus("Draft layer cleared.", "info");
  });

  function fillAiForm(cfg) {
    cfg = cfg || (SS.getAiConfig && SS.getAiConfig()) || {};
    document.getElementById("chk-ai-enabled").checked = !!cfg.enabled;
    document.getElementById("ai-base").value = cfg.baseUrl || "";
    document.getElementById("ai-model").value = cfg.model || "";
  }
  function saveAiForm() {
    if (!SS.setAiConfig) return;
    SS.setAiConfig({
      enabled: document.getElementById("chk-ai-enabled").checked,
      baseUrl: document.getElementById("ai-base").value,
      model: document.getElementById("ai-model").value,
      apiKey: document.getElementById("ai-key").value
    });
  }
  if (SS.getAiConfig) fillAiForm(SS.getAiConfig());
  document.getElementById("chk-ai-remote").addEventListener("change", function (ev) {
    if (SS.setAiRemoteAllowed) SS.setAiRemoteAllowed(!!ev.target.checked);
  });
  ["chk-ai-enabled", "ai-base", "ai-model", "ai-key"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", saveAiForm);
  });
  document.querySelectorAll("[data-ai-preset]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var preset = SS.applyAiPreset && SS.applyAiPreset(btn.getAttribute("data-ai-preset"));
      if (preset) {
        fillAiForm(SS.getAiConfig());
        document.getElementById("chk-ai-json").checked = !!preset.jsonMode;
        var msg = "Filled " + (preset.name || "preset") + " settings. ";
        if (preset.remote) msg += "This is a remote API: paste your key (kept in this tab only), type the exact model id from your account, and tick the LAN/cloud opt-in. Requests then leave this computer. ";
        else if (preset.remote === null) msg += "Enter your server's base URL and model. ";
        setStatus(msg + "Enable the checkbox to allow a request. The key is never exported.", "info");
      }
    });
  });

  // ---------------------------------------------------------------- v0.2.7
  // About links come from one constant (js/project-info.js). Plain links only.
  (function wireProjectLinks() {
    var info = SS.PROJECT_INFO || {};
    var repo = document.getElementById("link-repo");
    var bug = document.getElementById("link-report-bug");
    if (repo && info.REPO_URL) { repo.href = info.REPO_URL; repo.textContent = info.REPO_URL; }
    if (bug && info.ISSUES_URL) bug.href = info.ISSUES_URL;
    var note = document.getElementById("repo-placeholder-note");
    if (note) note.hidden = !info.REPO_IS_PLACEHOLDER;
  })();

  // AI learns from your hand traces. Examples live only in this tab's memory.
  var aiExamples = [];
  var aiDraftBusy = false;
  function renderAiExamples() {
    var list = document.getElementById("ai-example-list");
    list.textContent = "";
    if (!aiExamples.length) {
      var li0 = document.createElement("li");
      li0.className = "muted";
      li0.textContent = "No examples: the AI will draft from the audio features alone (zero-shot).";
      list.appendChild(li0);
      return;
    }
    aiExamples.forEach(function (ex, i) {
      var li = document.createElement("li");
      li.textContent = ex.label + " — " + ex.stroke_count + " hand stroke(s), " +
        (ex.has_audio_features ? "with measured audio features" : "no audio features (trace shape only)");
      var rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "Remove";
      rm.addEventListener("click", function () { aiExamples.splice(i, 1); renderAiExamples(); });
      li.appendChild(rm);
      list.appendChild(li);
    });
  }
  function addAiExample(ex) {
    if (aiExamples.length >= (SS.AI_MAX_EXAMPLES || 5)) {
      setStatus("Up to " + (SS.AI_MAX_EXAMPLES || 5) + " examples fit in one request. Remove one first.", "warn");
      return false;
    }
    aiExamples.push(ex);
    renderAiExamples();
    return true;
  }
  document.getElementById("btn-ai-example-current").addEventListener("click", function () {
    try {
      var ex = SS.exampleFromSession(SS.parseSession(SS.sessionToJSON(session)), (session.audio && session.audio.name) || "current project");
      if (addAiExample(ex)) setStatus("Added the current hand traces as an example (" + ex.stroke_count + " stroke(s)). Nothing was sent.", "ok");
    } catch (err) { setStatus(err.message || String(err), "warn"); }
  });
  document.getElementById("btn-ai-example-files").addEventListener("click", function () {
    document.getElementById("file-ai-examples").click();
  });
  document.getElementById("file-ai-examples").addEventListener("change", function (ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    ev.target.value = "";
    files.reduce(function (p, file) {
      return p.then(function () {
        return file.text().then(function (text) {
          var parsed = SS.parseSessionText(text, file.size);
          addAiExample(SS.exampleFromSession(parsed, SS.sanitizeLabel(file.name, SS.MAX_STRING_LEN)));
        }).catch(function (err) { setStatus(file.name + ": " + (err.message || err), "warn"); });
      });
    }, Promise.resolve()).then(function () {
      setStatus(aiExamples.length + " example(s) ready. Nothing was sent.", "info");
    });
  });
  document.getElementById("btn-ai-clear-examples").addEventListener("click", function () {
    aiExamples = [];
    renderAiExamples();
  });
  document.getElementById("btn-ai-remove-draft").addEventListener("click", function () {
    var n = SS.removeAiTraceDraft(session);
    refreshStrokeList(); draw();
    setStatus("Removed " + n + " AI-drafted stroke(s). Your hand strokes were not touched.", "info");
  });
  function localFetchHint() {
    return location.protocol === "file:"
      ? " — Ollama rejects pages opened from disk by default: run Serve-Local.cmd and use http://127.0.0.1:8765/ (see README)."
      : "";
  }
  function measuredFeaturesForCurrentAudio() {
    var dur = (session.audio && session.audio.duration_ms) || 0;
    if (session.draft && session.draft.strokes && session.draft.strokes.length) {
      return Promise.resolve(SS.audioFeatures(session.draft, dur));
    }
    var audio = player.getAudioBuffer && player.getAudioBuffer();
    if (!audio) return Promise.reject(new Error("Load and decode a .wav or .mp3 first."));
    var samples = new Float32Array(audio.getChannelData(0));
    setStatus("Measuring the pitch contour locally for the AI request…", "info");
    return SS.analyzePitchLoudnessAsync(samples, audio.sampleRate, {
      winMs: 40, hopMs: 30, silenceRms: SS.adaptiveSilenceRms(samples, audio.sampleRate), startMs: 0, endMs: Math.floor(audio.duration * 1000), cancel: { canceled: false }
    }).then(function (frames) {
      session.draft = SS.buildDraft(frames, { cleanup: true });
      return SS.audioFeatures(session.draft, Math.round(audio.duration * 1000));
    });
  }
  // v0.2.8 stage 2 with AI: chunked by lyric line windows, then stitched.
  function aiDraftRun() {
    if (aiDraftBusy) return Promise.reject(new Error("An AI draft is already running."));
    saveAiForm();
    var cfg = SS.getAiConfig ? SS.getAiConfig() : { enabled: false };
    if (!cfg.enabled || !cfg.baseUrl) return Promise.reject(new Error("Connect your AI first: enable it and set a base URL. Nothing was sent."));
    if (!player.hasAudio()) return Promise.reject(new Error("Load a .wav or .mp3 first."));
    ensureLyricsFromBox();
    aiDraftBusy = true;
    var examples = aiExamples.slice();
    var includeText = document.getElementById("chk-ai-word-text").checked;
    var jsonMode = document.getElementById("chk-ai-json").checked;
    return measuredFeaturesForCurrentAudio().then(function (features) {
      return SS.runChunkedTraceDraft(session, session.draft, features.duration_ms, examples, {
        includeWordText: includeText,
        send: function (messages) { return SS.sendAiChatAsync(messages, { jsonMode: jsonMode, timeoutMs: 300000 }); },
        isFatal: function (err) { return /blocked|connection is off|Set a base URL|valid HTTP|Failed to fetch/i.test(String(err && err.message || err)); },
        onProgress: function (i, n) {
          setStatus("AI drafting window " + i + " of " + n + " (pitch contour + word timings" + (includeText ? " + word text" : "") +
            (examples.length ? " + " + examples.length + " example(s)" : "") + "; no audio).", "info");
        }
      });
    }).then(function (r) {
      aiDraftBusy = false;
      var extra = ["ai-chunked"];
      if (r.used_word_timing) extra.push("ai-word-timing");
      if (r.word_text_sent) extra.push("ai-word-text");
      SS.applyAiTraceDraft(session, r.strokes, { model: cfg.model, examples: examples.length, extraTags: extra });
      refreshStrokeList(); draw();
      return r;
    }, function (err) { aiDraftBusy = false; throw err; });
  }
  document.getElementById("btn-ai-draft-trace").addEventListener("click", function () {
    aiDraftRun().then(function (r) {
      setStatus("AI drafted " + r.strokes.length + " stroke(s) from " + r.chunks + " window(s)" + (r.failed.length ? " (" + r.failed.length + " window(s) failed)" : "") +
        " — dashed, tagged needs_review. Play the song, correct by ear, then confirm.", r.failed.length ? "warn" : "ok");
    }).catch(function (err) {
      setStatus("AI draft failed: " + (err.message || err) + localFetchHint(), "warn");
    });
  });

  // v0.2.8 confirm AI strokes (stages 3-4 flag or exclude unconfirmed ones).
  function refreshConfirmInfo() {
    var el = document.getElementById("ai-confirm-info");
    if (!el) return;
    var total = session.strokes.filter(SS.isAiStroke).length;
    var open = SS.countUnconfirmedAi(session);
    el.textContent = total ? open + " of " + total + " AI-drafted stroke(s) unconfirmed. Unconfirmed strokes are flagged for review in steps 9–10 (or left out if you tick the option in the guided panel)."
      : "AI-drafted strokes are flagged for review in steps 9–10 until you confirm them.";
  }
  document.getElementById("btn-confirm-ai-stroke").addEventListener("click", function () {
    var id = renderer.view.selectedId;
    var s = session.strokes.find(function (x) { return x.id === id; });
    if (!s || !SS.isAiStroke(s)) { setStatus("Select an AI-drafted (dashed) stroke first: pause and click it, or pick it in the list.", "warn"); return; }
    SS.confirmAiStroke(session, id);
    refreshStrokeList(); draw();
    setStatus("Confirmed " + id + ". It now counts as reviewed in steps 9–10.", "ok");
  });
  document.getElementById("btn-confirm-all-ai").addEventListener("click", function () {
    var n = SS.confirmAllAiStrokes(session);
    refreshStrokeList(); draw();
    setStatus("Confirmed " + n + " AI-drafted stroke(s). Only do this after listening.", n ? "ok" : "info");
  });

  // v0.2.8 AI context file (memory of this tab only).
  function refreshContextInfo() {
    var el = document.getElementById("ai-context-info");
    if (!el || !SS.getAiContextInfo) return;
    var info = SS.getAiContextInfo();
    el.textContent = (info.source === "override" ? "Using your context file: " + info.label : "Using the built-in context (SONG_SHAPE_AI_CONTEXT.md)") +
      (info.version ? ", version " + info.version : "") + ", " + info.chars + " characters.";
  }
  document.getElementById("btn-ai-context-load").addEventListener("click", function () {
    document.getElementById("file-ai-context").click();
  });
  document.getElementById("file-ai-context").addEventListener("change", function (ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    if (file.size > 64000) { setStatus("The context file is larger than 64,000 bytes.", "warn"); return; }
    file.text().then(function (text) {
      SS.setAiContextOverride(text, SS.sanitizeLabel(file.name, 120));
      refreshContextInfo();
      setStatus("Loaded your AI context file for this tab. Nothing was sent.", "ok");
    }).catch(function (err) { setStatus(err.message || String(err), "warn"); });
  });
  document.getElementById("btn-ai-context-reset").addEventListener("click", function () {
    SS.clearAiContextOverride();
    refreshContextInfo();
    setStatus("Using the built-in AI context.", "info");
  });
  refreshContextInfo();

  // v0.2.8 guided four-stage panel. CPU only by default; AI where enabled.
  var guided = { pausedAt: 0, running: false };
  function gSet(n, state, text) {
    var el = document.getElementById("g-status-" + n);
    el.dataset.state = state;
    el.textContent = text;
    // v0.2.11 fix7: a visible "it ran" signal: time of the last run and a short highlight on the card.
    var when = document.getElementById("g-when-" + n), card = el.closest ? el.closest("li") : null;
    if (when) when.textContent = state === "running" ? "Running…" : state === "todo" ? "" : "Last run " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    if (card && (state === "done" || state === "review" || state === "error")) {
      card.classList.remove("g-updated"); void card.offsetWidth; card.classList.add("g-updated");
    }
  }
  function gMessage(text) { document.getElementById("g-message").textContent = text || ""; }
  function aiReady(box) {
    var cfg = SS.getAiConfig ? SS.getAiConfig() : {};
    return !!(document.getElementById(box).checked && cfg.enabled && cfg.baseUrl);
  }
  function stage1Label(words) {
    var byWord = {}, n = { hand: 0, tap: 0, aligner: 0, estimate: 0, other: 0 }, tapLines = {};
    (session.anchors || []).forEach(function (a) { byWord[a.word_id] = a; });
    var unplaced = [];
    words.forEach(function (w) {
      var a = byWord[w.id];
      if (!a) { unplaced.push(w.text); return; }
      if (!a.needs_review) n.hand += 1;
      else if (a.tap_anchored) { n.tap += 1; tapLines[a.line_id] = 1; } // v0.2.11 fix7: words anchored to your line taps
      else if (a.source === "imported_known_lyrics_alignment") n.aligner += 1;
      else if (a.source === "cpu_energy_timing_estimate") n.estimate += 1;
      else n.other += 1;
    });
    var parts = [];
    if (n.hand) parts.push(n.hand + " checked");
    if (n.tap) parts.push(n.tap + " anchored to your taps (" + Object.keys(tapLines).length + " line" + (Object.keys(tapLines).length === 1 ? "" : "s") + ", check by ear)");
    if (n.aligner) parts.push(n.aligner + " by the aligner (check by ear)");
    if (n.estimate) parts.push(n.estimate + " estimated (check by ear)");
    if (n.other) parts.push(n.other + " imported (check by ear)");
    // v0.2.11 fix6e: unplaced words may be hiding in a harmony section (Song Shape tracks the lead only).
    var hint = "";
    if (unplaced.length) {
      refreshHarmony();
      var hints = SS.unplacedHarmonyHints ? SS.unplacedHarmonyHints(session, session.detected_harmony || []) : [];
      var near = hints.filter(function (h) { return h.harmony_region; }).map(function (h) { return SS.formatMmSs(h.near_ms); });
      near = near.filter(function (t, i) { return near.indexOf(t) === i; });
      hint = near.length ? " - may be in a harmony section near " + near.slice(0, 3).join(", ") + "; check by ear" : " - may be in a harmony or backing part; check by ear";
    }
    return (words.length - unplaced.length) + " of " + words.length + " words placed" + (parts.length ? ": " + parts.join(", ") : "") +
      (unplaced.length ? "; " + unplaced.length + " left unplaced (" + unplaced.slice(0, 6).join(" ") + (unplaced.length > 6 ? " \u2026" : "") + ")" + hint : "");
  }
  // ---- v0.2.11 fix6e: harmony hints (lead singer only; stacked voices are labelled, never tracked) ----
  var stemRangeJob = null;
  var harmonyEvidence = null; // per-frame evidence from the vocal stem (in memory only)
  function lineSpansFromAnchors() {
    var byLine = {}, text = {};
    (session.lyrics && session.lyrics.lines || []).forEach(function (l) { text[l.id] = l.text; });
    (session.anchors || []).forEach(function (a) {
      if (!a.line_id || typeof a.start_ms !== "number") return;
      var s = byLine[a.line_id] || (byLine[a.line_id] = { line_id: a.line_id, start_ms: a.start_ms, end_ms: a.start_ms, text: text[a.line_id] || "" });
      s.start_ms = Math.min(s.start_ms, a.start_ms); s.end_ms = Math.max(s.end_ms, (a.end_ms || a.start_ms) + 400);
    });
    return Object.keys(byLine).map(function (k) { return byLine[k]; });
  }
  function refreshHarmony() {
    if (!SS.detectHarmony) return;
    if (!harmonyEvidence && (session.detected_harmony || []).some(function (r) { return r.source !== "words"; })) { renderHarmonyList(); return; } // kept from a loaded project
    session.detected_harmony = SS.detectHarmony(null, 0, { frames: harmonyEvidence ? harmonyEvidence.frames : [], lineSpans: lineSpansFromAnchors() });
    renderHarmonyList();
  }
  function renderHarmonyList() {
    var ul = document.getElementById("harmony-list"), count = document.getElementById("harmony-count");
    if (!ul) return;
    var regions = session.detected_harmony || [];
    var words = {}; (session.lyrics && session.lyrics.words || []).forEach(function (w) { words[w.id] = w.text; });
    var hints = SS.unplacedHarmonyHints ? SS.unplacedHarmonyHints(session, regions) : [];
    ul.innerHTML = "";
    regions.forEach(function (r) {
      var inside = (session.anchors || []).filter(function (a) { return a.start_ms >= r.start_ms && a.start_ms <= r.end_ms; })
        .sort(function (p, q) { return p.start_ms - q.start_ms; }).map(function (a) { return words[a.word_id] || ""; }).filter(Boolean);
      var miss = hints.filter(function (h) { return h.harmony_region === r.id; }).map(function (h) { return h.text; });
      var li = document.createElement("li");
      li.textContent = SS.formatMmSs(r.start_ms) + "–" + SS.formatMmSs(r.end_ms) + ": " + (r.reasons || []).join(", ") + (inside.length ? ". Words: " + inside.slice(0, 12).join(" ") + (inside.length > 12 ? " …" : "") : "") + (miss.length ? ". Possibly unplaced here: " + miss.join(" ") : "") + " ";
      var b = document.createElement("span"); b.className = "badge-harmony"; b.textContent = "harmony"; li.appendChild(b);
      ul.appendChild(li);
    });
    if (!regions.length) { var li = document.createElement("li"); li.textContent = harmonyEvidence ? "No stacked voices found in the vocal stem." : "Open a vocal stem (step 3) to look for harmony sections; overlapping placed lines are checked too."; ul.appendChild(li); }
    if (count) count.textContent = regions.length ? "— " + regions.length + " possible harmony section(s)" : (harmonyEvidence ? "— none found" : "— open a vocal stem");
  }
  function renderVocalRange() {
    var el = document.getElementById("vocal-range-label");
    if (el) {
      el.textContent = "";
      if (session.vocal_range) {
        var b = document.createElement("strong"); b.textContent = "Singer " + SS.vocalRangeLabel(session.vocal_range).replace(/^Range/, "range"); el.appendChild(b);
        el.appendChild(document.createTextNode(" — the middle line. Lead only: 2nd–98th percentiles of confident frames, harmony excluded. Register labels (low to high) are relative to this range."));
      } else el.textContent = "Singer range: open a vocal stem to measure the lead singer’s range and baseline.";
    }
    if (renderer && renderer.view) renderer.view.vocalRange = session.vocal_range || null;
  }
  function updateVocalRange(frames) {
    var r = SS.measureVocalRange(frames, { harmonyRegions: session.detected_harmony || [] });
    session.vocal_range = r;
    var box = document.getElementById("draft-baseline-hz");
    box.value = r ? String(r.baseline_hz) : ""; box.readOnly = !!r;
    renderVocalRange(); draw();
    return r;
  }
  function analyzeStemHarmony(buffer) {
    harmonyEvidence = null; session.vocal_range = null;
    document.getElementById("vocal-range-label").textContent = "Measuring the lead singer’s range…";
    var loadedSession = session;
    stemRangeJob = new Promise(function (resolve) { setTimeout(function () {
      try {
        var n = buffer.length, ch = buffer.numberOfChannels, mono = new Float32Array(n), c, i, d;
        for (c = 0; c < ch; c++) { d = buffer.getChannelData(c); for (i = 0; i < n; i++) mono[i] += d[i] / ch; }
        harmonyEvidence = SS.harmonyFrames(mono, buffer.sampleRate);
        session.detected_harmony = [];
        refreshHarmony();
        if (renderer && renderer.draw) try { renderer.draw(session, player, recorder); } catch (e) { /* next frame */ }
        // v0.2.11 fix6f: the lead singer's range; the Singer baseline is its midpoint.
        SS.analyzePitchLoudnessAsync(mono, buffer.sampleRate, { winMs: 40, hopMs: 30, silenceRms: SS.adaptiveSilenceRms(mono, buffer.sampleRate) }).then(function (frames) {
          if (session !== loadedSession || !stemAudio || stemAudio.buffer !== buffer) { resolve(); return; }
          var r = updateVocalRange(frames);
          stemStatus("done", "Stem ready: " + stemAudio.name + ". " + (r ? SS.vocalRangeLabel(r) + "." : "Not enough confident lead voice to measure a range."));
          resolve();
        }).catch(function (err) { document.getElementById("vocal-range-label").textContent = "Could not measure the range: " + (err && err.message || err); resolve(); });
      } catch (err) { harmonyEvidence = null; resolve(); }
    }, 30); });
    stemRangeJob.then(function () { stemRangeJob = null; });
  }
  function stage1Review(words) {
    var byWord = {};
    (session.anchors || []).forEach(function (a) { byWord[a.word_id] = a; });
    return words.some(function (w) { return !byWord[w.id] || byWord[w.id].needs_review; });
  }
  // v0.2.11 fix7: wait for anything still running (the rip / pipeline, a pitch measurement, the singer range)
  // before a stage reads the session, so a click at 0:00 right after loading cannot race them.
  var pipelineRunning = false;
  function whenIdle(label) {
    var waited = 0;
    return new Promise(function (resolve, reject) {
      (function check() {
        if (stemRangeJob) { setStatus(label + ": waiting for the singer range…", "info"); var again = function () { setTimeout(check, 0); }; stemRangeJob.then(again, again); return; }
        if (pipelineRunning || draftJob) {
          if (waited > 900000) { reject(new Error(label + ": the tools are still running. Wait for them to finish, then click again.")); return; }
          if (!waited) setStatus(label + ": waiting for the running tools to finish…", "info");
          waited += 250; setTimeout(check, 250); return;
        }
        resolve();
      })();
    });
  }
  function stage1() {
    return whenIdle("Place words").then(function () {
      ensureLyricsFromBox();
      if (!player.hasAudio()) throw new Error("Click Open audio and choose a song (.wav or .mp3) first.");
      if (!(player.getWaveform && player.getWaveform())) throw new Error("The song is still being decoded. Wait a moment, then click Run again.");
      var words = (session.lyrics && session.lyrics.words || []).filter(function (w) { return !w.skipped; });
      if (!words.length) throw new Error("Paste the original lyrics in step 2 first.");
      var tapped = SS.lineTaps(session).filter(function (t) { return !t.skipped; }).length;
      // With taps and a connected aligner, re-align: the helper treats each tapped line start as a hard anchor.
      var realign = !tapped ? Promise.resolve(null) : ensureHelper().then(function () {
        if (!helperInfo || !helperInfo.aligner_configured || !stemAudio) return null;
        return Promise.resolve(pipelineTools.place_words({})).then(function (r) { if (r && r.ok === false) throw new Error(r.error); return r; });
      });
      return realign.then(function () {
        var anchors = session.anchors || [];
        // v0.2.11 fix4: words the local aligner left unplaced (not heard) stay unplaced; never fill them with the
        // whole-song CPU estimate. The CPU estimate only runs when nothing came from the aligner.
        var aligned = anchors.some(function (a) { return a.source === "imported_known_lyrics_alignment"; });
        if (anchors.length < words.length && !aligned) proposeWordPositions(false);
        var t = tapped ? SS.applyTapAnchors(session, (session.audio && session.audio.duration_ms) || player.duration() * 1000) : null;
        if (t) { refreshLyricsUi(); draw(); }
        refreshHarmony();
        var text = stage1Label(words);
        if (t && t.skipped_lines.length) text += "; " + t.skipped_lines.length + " tapped line(s) had no room before the next line and were left as they were";
        return { state: stage1Review(words) ? "review" : "done", text: text };
      });
    });
  }
  function stage2() {
    if (!player.hasAudio()) return Promise.reject(new Error("Click Open audio first."));
    if (aiReady("chk-g-ai-draft")) {
      return aiDraftRun().then(function (r) {
        return { state: "review", text: "AI drafted " + r.strokes.length + " stroke(s) in " + r.chunks + " window(s)" + (r.failed.length ? ", " + r.failed.length + " failed" : "") + " — correct and confirm" };
      });
    }
    var hand = SS.humanStrokes(session).length;
    if (hand) return Promise.resolve({ state: "done", text: "Kept your " + hand + " hand stroke(s); nothing re-measured (delete them to measure the audio)" });
    // v0.2.11: Run 2 always re-measures. Earlier unlinked CPU strokes are replaced; hand strokes return above
    // and AI or word-linked strokes are kept.
    return whenIdle("Draft the shape").then(function () { return runCpuContour({ placeWords: false }); }).then(function (n) {
      var vr = session.vocal_range;
      setStatus("Draft the shape finished: " + n + " contour segment(s) measured on the " + (stemAudio ? "vocal stem" : "song mix") + (vr ? ", baseline " + vr.baseline_note + " (range " + vr.low_note + "–" + vr.high_note + ")" : "") + ". The line is drawn on the plot.", "ok");
      return { state: "review", text: "Measured " + n + " contour segment(s) on the " + (stemAudio ? "stem" : "song mix") + (vr ? ", baseline " + vr.baseline_note : "") + " — the line is on the plot (no AI)" };
    });
  }
  function stage3() {
    var mine = document.getElementById("new-lyrics").value;
    if (!mine.trim()) throw new Error("Paste your new lyrics in Map my lyrics first.");
    var r = localSheet(mine);
    var lines = r.mapped.handoff.rows.length;
    stageResult("9 · Fit your lyrics: " + lines + " of your lines fitted to the reference shape. " + (r.extend ? r.extend.notes.split("\n")[0] + " " : "") + (r.review ? r.review + " need your ear. " : "None need a timing check. ") +
      (r.untagged ? r.untagged + " have no contour yet. " : "") + "Run step 10 to write the tagged sheet.\n" + r.notes.split("\n")[0]);
    return { state: r.review ? "review" : "done", text: lines + " line(s) fitted" + (r.review ? ", " + r.review + " need your ear" : "") };
  }
  function stage4() {
    var mine = document.getElementById("new-lyrics").value;
    if (!mine.trim()) return Promise.reject(new Error("Paste your new lyrics in Map my lyrics first."));
    var out = document.getElementById("map-output");
    if (aiReady("chk-g-ai-sheet")) {
      out.value = "Sending…";
      return aiSheet(mine).then(function (res) {
        if (res.check.ok) {
          putSheet(res.text, "AI sheet");
          return { state: "done", text: "AI sheet ready. " + sheetCheckNote(res.check) };
        }
        // v0.2.11: a reply that fails the check never replaces the CPU sheet in the paste box.
        showSheet(localSheet(mine));
        var notes = document.getElementById("map-notes");
        if (notes) notes.textContent = "The AI sheet failed the check and was not used (" + sheetCheckNote(res.check) + "). The CPU sheet is shown above.\n\n" + notes.textContent;
        return { state: "review", text: "AI sheet failed the check; CPU sheet shown instead. " + sheetCheckNote(res.check) };
      }).catch(function (err) {
        showSheet(localSheet(mine));
        return { state: "review", text: "AI sheet failed (" + (err.message || err) + "); CPU sheet shown instead" };
      });
    }
    var sheet = showSheet(localSheet(mine));
    stageResult("10 · Export: the tagged lyrics are in “Lyrics for Suno” below (paste into Suno's lyrics box). The style prompt and notes are under it and are not part of the paste.");
    return Promise.resolve({ state: "done", text: "Sheet ready below (" + sheet.lines + " lines)" });
  }
  var STAGES = [null, stage1, stage2, stage3, stage4];
  function runStage(n) {
    gSet(n, "running", "Running…");
    return Promise.resolve().then(function () { return STAGES[n](); }).then(function (r) {
      gSet(n, r.state, r.text);
      refreshStrokeList(); draw();
      return r;
    }, function (err) {
      gSet(n, "error", err.message || String(err));
      throw err;
    });
  }
  function runFrom(n) {
    var cont = document.getElementById("btn-g-continue");
    cont.hidden = true;
    guided.running = true;
    function step(k) {
      if (k > 4) { guided.running = false; gMessage("Steps 7–10 finished. The tagged sheet is in Mapping output."); setStatus("Guided chain finished: steps 7–10 ran. Review the flagged items, then copy the tagged sheet from Mapping output.", "ok"); return Promise.resolve("done"); }
      return runStage(k).then(function () {
        if (k === 1 || k === 2) {
          guided.pausedAt = k; guided.running = false;
          cont.hidden = false;
          gMessage("Paused after step " + (k + 6) + ": " + (k === 1 ? "listen and correct the word positions" : "listen and correct the shape (confirm AI strokes you keep)") + ", then click Continue.");
          return "paused";
        }
        return step(k + 1);
      });
    }
    return step(n).catch(function (err) {
      guided.running = false;
      gMessage("Stopped: " + (err.message || err));
      setStatus(err.message || String(err), "warn");
      return "error";
    });
  }
  [1, 2, 3, 4].forEach(function (n) {
    document.getElementById("btn-g-run-" + n).addEventListener("click", function () {
      runStage(n).then(function (r) { setStatus("Step " + (n + 6) + ": " + r.text + ".", r.state === "done" ? "ok" : "info"); })
        .catch(function (err) { setStatus(err.message || String(err), "warn"); });
    });
  });
  document.getElementById("btn-g-run-all").addEventListener("click", function () {
    if (guided.running) return;
    [1, 2, 3, 4].forEach(function (n) { gSet(n, "todo", "Not run"); });
    runFrom(1);
  });
  document.getElementById("btn-g-continue").addEventListener("click", function () {
    if (guided.running || !guided.pausedAt) return;
    var from = guided.pausedAt + 1;
    guided.pausedAt = 0;
    runFrom(from);
  });
  renderAiExamples();

  if (SS.SUNO_LIMITATIONS) {
    var lim = document.getElementById("suno-limits");
    if (lim) lim.textContent = SS.SUNO_LIMITATIONS;
  }

  // 0.2.5: known-lyrics alignment assistance. Audio never leaves this tab.
  function proposeWordPositions(nextLineOnly) {
    ensureLyricsFromBox();
    var waveform = player.getWaveform && player.getWaveform();
    if (!waveform) throw new Error('Load a decoded local WAV or MP3 first.');
    var loop = player.getLoop && player.getLoop();
    if (nextLineOnly && !loop) throw new Error('Drag a loop over the next lyric line on the ruler before estimating that line.');
    var options = {nextLineOnly: !!nextLineOnly};
    if (nextLineOnly) {options.start_ms = loop.start * 1000;options.end_ms = loop.end * 1000;}
    var proposal = SS.estimateWordTimes(session, waveform, options);
    var applied = SS.applyProposals(session, proposal);
    refreshLyricsUi(); draw();
    var message = 'Added ' + applied.added + ' unverified word estimates (' + applied.preserved +
      ' previously anchored words preserved). These positions are NOT recognized words; check and correct them.';
    document.getElementById('alignment-feedback').textContent = message;
    setStatus(message, 'warn');
    return applied;
  }
  document.getElementById('btn-estimate-line').addEventListener('click', function () {
    try { proposeWordPositions(true); } catch (e) { setStatus(e.message, 'warn'); }
  });
  document.getElementById('btn-estimate-all').addEventListener('click', function () {
    try { proposeWordPositions(false); } catch (e) { setStatus(e.message, 'warn'); }
  });
  document.getElementById('btn-import-alignment').addEventListener('click', function () {
    document.getElementById('file-align').click();
  });
  document.getElementById('file-align').addEventListener('change', function (event) {
    var file=event.target.files && event.target.files[0];event.target.value='';
    if(!file)return;
    if(file.size>2*1024*1024){setStatus('Alignment file is larger than the 2 MB limit.', 'warn');return;}
    file.text().then(function(text) {
      ensureLyricsFromBox();
      var proposal=SS.proposeImportedAlignment(session,JSON.parse(text));
      var result=SS.applyProposals(session,proposal);
      refreshLyricsUi(); draw();
      var msg='Imported '+result.added+' word-position proposals; kept '+result.preserved+' existing anchors. '
        +'Imported alignment has not been verified by listening.';
      document.getElementById('alignment-feedback').textContent=msg;
      setStatus(msg,'warn');
    }).catch(function(error){setStatus('Alignment import rejected: '+error.message+'. Nothing else was changed.', 'warn');});
  });
  document.getElementById('btn-confirm-anchor').addEventListener('click', function () {
    var anchor=selectedAnchor();
    if(!anchor){setStatus('Select an anchored word on the timeline first.', 'warn');return;}
    anchor.needs_review=false;
    refreshLyricsUi();draw();setStatus('Confirmed selected word timing. This does not verify other auto-aligned words.', 'ok');
  });

  // Measured pitch remains separate from human-perceived expressive delivery.
  // One-click CPU proposal uses existing local audio + supplied lyric order.
  // v0.2.8: shared by the button and guided stage 2. Resolves with the number of measured segments.
  function runCpuContour(o) {
    o = o || {};
    if (stemRangeJob) return stemRangeJob.then(function () { return runCpuContour(o); });
    return new Promise(function (resolve, reject) {
      if(draftJob){reject(new Error('An audio-analysis job is already running.'));return;}
      // v0.2.11: measure the vocal stem when one is open (Stage 0); the song stays the playback track.
      var audio=(stemAudio&&stemAudio.buffer)||(player.getAudioBuffer && player.getAudioBuffer());
      if(!audio){handleNoAudioDraft();reject(new Error('Click Open audio first.'));return;}
      try {
        ensureLyricsFromBox();
        if(o.placeWords && !(session.anchors||[]).length && (session.lyrics && session.lyrics.words||[]).length) proposeWordPositions(false);
      } catch(error){reject(error);return;}
      var cancel={canceled:false};
      draftJob={cancel:cancel};setDraftRunning(true);setDraftProgress(0,'Analyzing full track…');
      var baselineText=document.getElementById('draft-baseline-hz').value.trim();
      var baseline=session.vocal_range ? null : (baselineText?Number(baselineText):null);
      if(baseline!==null && (!Number.isFinite(baseline)||baseline<40||baseline>20000)){
        finishDraftJob();reject(new Error('Reference frequency must be 40–20000 Hz.'));return;
      }
      setTimeout(function(){
        var samples;
        try {samples=new Float32Array(audio.getChannelData(0));}
        catch(error){finishDraftJob();reject(error);return;}
        SS.analyzePitchLoudnessAsync(samples,audio.sampleRate,{
          winMs:40,hopMs:30,silenceRms:SS.adaptiveSilenceRms(samples,audio.sampleRate),startMs:0,endMs:Math.floor(audio.duration*1000),cancel:cancel,
          onProgress:function(p){setDraftProgress(p.percent,'Analyzing full track…');}
        }).then(function(frames){
          if(cancel.canceled){reject(new Error('Analysis canceled.'));return;}
          // v0.2.11 fix6f: re-measure the range from this run (stem) with the current harmony regions.
          if(stemAudio && audio===stemAudio.buffer) { refreshHarmony(); updateVocalRange(frames); }
          var draft=SS.buildDraft(frames,{baselineHz:baseline,range:session.vocal_range,cleanup:true});
          session.draft=draft;
          SS.removeUnlinkedMachineDraft(session);
          SS.acceptDraft(session);
          if(!session.vocal_range) document.getElementById('draft-baseline-hz').value=draft.baseline_hz?String(Number(draft.baseline_hz.toFixed(3))):'';
          revealDraft(draft,{onlyView:false,startMs:0,endMs:audio.duration*1000});
          finishDraftJob();refreshStrokeList();draw();
          resolve(draft.strokes.length);
        }).catch(function(error){
          finishDraftJob();
          reject(cancel.canceled ? new Error('Analysis canceled.') : new Error('CPU analysis failed: '+(error.message||error)));
        });
      },0);
    });
  }
  document.getElementById('btn-auto-contour').addEventListener('click', function () {
    runCpuContour({placeWords:true}).then(function(n){
      setStatus('Added '+n+' CPU-measured vocal-frequency segment(s); '+
        (session.anchors||[]).length+' word anchors. These are proposals, not verified vocal delivery. '+
        'Use Preview visual handoff to inspect the result.','ok');
    }).catch(function(error){
      setStatus(error.message||String(error), /canceled/.test(error.message)?'info':'warn');
    });
  });

  // ---------------------------------------------------------------- v0.2.11 Stage 0: vocal stem + tools
  var stemAudio = null; // {buffer: AudioBuffer, name, bytes: ArrayBuffer, audioId}
  function stemStatus(state, text) { var el = document.getElementById("stem-status"); el.dataset.state = state; el.textContent = text; }
  function decodeStem(bytes, name) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    return ctx.decodeAudioData(bytes.slice(0)).then(function (buffer) {
      try { ctx.close(); } catch (e) {}
      var songMs = (session.audio && session.audio.duration_ms) || 0;
      var stemMs = Math.round(buffer.duration * 1000);
      stemAudio = { buffer: buffer, name: SS.sanitizeLabel(name, SS.MAX_STRING_LEN) || "vocal stem", bytes: bytes, audioId: null };
      analyzeStemHarmony(buffer);
      var mismatch = songMs && Math.abs(songMs - stemMs) > 1500;
      stemStatus(mismatch ? "review" : "done", "Measuring the stem: " + stemAudio.name + " (" + formatTime(buffer.duration) + ")" + (mismatch ? ". Its length differs from the song by " + (Math.abs(songMs - stemMs) / 1000).toFixed(1) + " s, so check it is the same recording." : ""));
      return stemAudio;
    });
  }
  document.getElementById("btn-open-stem").addEventListener("click", function () { document.getElementById("file-stem").click(); });
  document.getElementById("file-stem").addEventListener("change", function (ev) {
    var file = ev.target.files && ev.target.files[0]; ev.target.value = "";
    if (!file) return;
    if (!SS.isSupportedAudioFile(file)) { setStatus(SS.SUPPORTED_AUDIO_MESSAGE, "warn"); return; }
    file.arrayBuffer().then(function (bytes) {
      SS.validateAudio(file.name || "", bytes); // throws on anything but WAV/MP3
      return decodeStem(bytes, file.name);
    }).then(function () {
      setStatus("Vocal stem open. Step 8 and the tools now measure the stem; playback stays on the song. Run step 8 again to re-measure.", "ok");
    }).catch(function (e) { setStatus("Could not open the stem: " + (e.message || e), "warn"); });
  });
  document.getElementById("btn-clear-stem").addEventListener("click", function () {
    stemAudio = null; harmonyEvidence = null; session.detected_harmony = []; session.vocal_range = null; document.getElementById("draft-baseline-hz").readOnly = false; renderVocalRange(); refreshHarmony(); stemStatus("todo", "No stem: measuring the song mix");
    setStatus("Measuring the song mix again. Run step 8 to re-measure.", "info");
  });
  function helperCfg() { return { baseUrl: document.getElementById("helper-url").value.trim(), token: document.getElementById("helper-token").value.trim() }; }
  var helperInfo = null;
  // v0.2.11: the tools check the helper themselves when an address and token are filled in.
  function ensureHelper() {
    if (helperInfo) return Promise.resolve(helperInfo);
    var cfg = helperCfg();
    if (!cfg.baseUrl || !cfg.token) return Promise.resolve(null);
    return SS.helperHealth(cfg).then(function (h) { helperInfo = h; return h; }, function (e) { helperInfo = null; setStatus("Helper check failed: " + (e.message || e), "warn"); return null; });
  }
  ["helper-url", "helper-token"].forEach(function (id) { document.getElementById(id).addEventListener("input", function () { helperInfo = null; }); });
  document.getElementById("btn-helper-check").addEventListener("click", function () {
    SS.helperHealth(helperCfg()).then(function (h) {
      helperInfo = h;
      // v0.2.11 fix6: each tool with its path; a missing one says "not found".
      var list = document.getElementById("helper-tools"), tools = Array.isArray(h.tools) ? h.tools : [];
      if (list) {
        list.textContent = "";
        if (h.tools_home) { var home = document.createElement("li"); home.textContent = "Tools home: " + h.tools_home; list.appendChild(home); }
        tools.forEach(function (t) {
          var li = document.createElement("li");
          li.textContent = (t.found ? "found: " : "NOT FOUND: ") + t.name + " — " + (t.path || "(no path)");
          if (!t.found) li.style.color = "#b45309";
          list.appendChild(li);
        });
      }
      var missing = tools.filter(function (t) { return !t.found; });
      setStatus("Helper ready: separator " + (h.separator_configured ? "configured" : "not configured") + ", aligner " + (h.aligner_configured ? "configured" : "not configured") + "." +
        (missing.length ? " Not found: " + missing.map(function (t) { return t.name; }).join(", ") + " (paths listed under Check helper; fix SongShape_Tools\\songshape-tools.json, then restart Song Shape)." : tools.length ? " All " + tools.length + " tools found." : ""), missing.length ? "warn" : "ok");
    }).catch(function (e) { helperInfo = null; var l = document.getElementById("helper-tools"); if (l) l.textContent = ""; setStatus(e.message || String(e), "warn"); });
  });
  function logStep(name, state, result) {
    var list = document.getElementById("pipeline-log");
    var id = "pl-" + name;
    var li = document.getElementById(id);
    if (!li) { li = document.createElement("li"); li.id = id; list.appendChild(li); }
    li.dataset.state = state;
    var summary = state === "running" ? "running…" : result && result.ok === false ? (result.error || "failed") : result && result.summary ? result.summary : "done";
    li.textContent = name.replace(/_/g, " ") + ": " + summary;
  }
  function wordsForAlign() {
    var starts = SS.lineTapStarts(session);
    return (session.lyrics && session.lyrics.words || []).filter(function (w) { return !w.skipped; }).map(function (w) {
      var o = Object.assign({}, w); if (typeof starts[w.id] === "number") o.line_start_ms = starts[w.id]; return o;
    });
  }
  var pipelineTools = {
    load_song: function () {
      if (!player.hasAudio()) return { ok: false, error: "No song is open. Click Open audio." };
      ensureLyricsFromBox();
      return { ok: true, song: session.audio && session.audio.name, duration_s: Math.round(((session.audio && session.audio.duration_ms) || 0) / 100) / 10,
        stem_loaded: !!stemAudio, lyric_words: wordsForAlign().length,
        summary: (session.audio && session.audio.name) + " (" + formatTime(player.duration()) + ")" + (stemAudio ? " + stem " + stemAudio.name + " (" + formatTime(stemAudio.buffer.duration) + ")" : "") + ", " + wordsForAlign().length + " lyric words" };
    },
    separate_vocals: function () {
      if (stemAudio) return { ok: true, source: "stem_opened_by_user", summary: "using " + stemAudio.name + " (" + formatTime(stemAudio.buffer.duration) + ")" };
      return ensureHelper().then(function () {
      if (!helperInfo || !helperInfo.separator_configured) return { ok: false, error: "No vocal stem. Open one in step 3, or start the helper, paste its token and click Check helper (step 4)." };
      if (!currentAudioFile) return { ok: false, error: "Open the song with Open audio first." };
      return currentAudioFile.arrayBuffer().then(function (bytes) { return SS.helperSeparate(helperCfg(), bytes, currentAudioFile.name); })
        .then(function (r) { return decodeStem(r.bytes, "vocals (helper)").then(function (st) { st.audioId = r.audioId; return { ok: true, source: "helper_separator", summary: "stem ripped locally (" + formatTime(st.buffer.duration) + ")" }; }); });
      });
    },
    map_vocals: function () {
      return runCpuContour({ placeWords: false }).then(function (n) {
        var c = session.draft && session.draft.cleanup || {};
        return { ok: true, segments: n, measured: stemAudio ? "vocal stem" : "song mix", cleanup: c, summary: n + " contour segment(s) on the " + (stemAudio ? "stem" : "mix") + "; " + (c.spikes_removed || 0) + " spike frames removed, " + (c.octave_folded || 0) + " octave jumps folded, " + (c.frames_bridged || 0) + " gap frames bridged" };
      });
    },
    place_words: function (args) {
      ensureLyricsFromBox();
      var vowel = args && args.vowel_target === false ? false : document.getElementById("chk-vowel-target").checked;
      var words = wordsForAlign();
      if (!words.length) return { ok: false, error: "Paste the original lyrics first." };
      var buf = (stemAudio && stemAudio.buffer) || player.getAudioBuffer();
      var samples = buf ? buf.getChannelData(0) : null;
      return ensureHelper().then(function () {
      // v0.2.11: never fall back silently to the rough whole-song estimate (median error ~7 s on a real song).
      if (!helperInfo || !helperInfo.aligner_configured) return { ok: false, error: "Words were not placed: the local aligner is not connected. Start the helper, paste its token in step 4 and click Check helper, then run again. (For a rough guess without it, use Estimate remaining words; expect errors of several seconds.)" };
      if (!stemAudio) return { ok: false, error: "Words were not placed: no vocal stem. Open a vocal stem or let the helper rip one, then run again." };
      {
        var cfg = helperCfg();
        var idP = stemAudio.audioId ? Promise.resolve(stemAudio.audioId) : SS.helperUpload(cfg, stemAudio.bytes, stemAudio.name).then(function (id) { stemAudio.audioId = id; return id; });
        return idP.then(function (id) { return SS.helperAlign(cfg, id, words); }).then(function (data) {
          var proposal = SS.proposeImportedAlignment(session, data, { vowelTarget: vowel, samples: samples, sampleRate: buf ? buf.sampleRate : 0, lineTaps: SS.lineTapStarts(session) });
          // Reruns replace unconfirmed machine placements only; hand-checked placements are kept.
          session.anchors = (session.anchors || []).filter(function (a) { return !a.needs_review || !/^(imported_known_lyrics_alignment|cpu_energy_timing_estimate|cpu_tap_anchored_estimate)$/.test(a.source || ''); });
          var applied = SS.applyProposals(session, proposal);
          refreshLyricsUi(); refreshTapUi(); draw();
          var nh = proposal.not_heard || [], wl = proposal.weak_lines || [], vc = proposal.vocalise || [], sn = proposal.lines_snapped || [], sp = proposal.spread || [];
          return { ok: true, method: "local_aligner" + (vowel ? "_vowel_target" : ""), added: applied.added, kept_hand_placed: applied.preserved, not_heard: nh, weak_lines: wl, vocalise: vc, lines_snapped: sn, held: proposal.held || [], spread: sp,
            summary: applied.added + " word(s) placed by the local aligner" + (vowel ? " on the vowel" : "") + ", " + applied.preserved + " hand-placed kept" +
              (nh.length ? "; " + nh.length + " not heard in the audio, left unplaced (" + nh.slice(0, 8).join(" ") + "): check the lyrics match what is sung" : "") +
              (wl.length ? "; check by ear (weak match): " + wl.slice(0, 6).map(function (l) { return "\u201c" + l.text + "\u201d at " + formatTime(l.start_ms / 1000); }).join(", ") : "") +
              (sp.length ? "; check by ear (word spread over a long gap): " + sp.slice(0, 6).map(function (w) { return w.text + " at " + formatTime(w.start_ms / 1000); }).join(", ") : "") +
              (vc.length ? "; vocalise words placed loosely, check by ear: " + vc.slice(0, 8).join(" ") : "") +
              (sn.length ? "; " + sn.length + " line start(s) moved to the vocal onset after a pause" : "") +
              (proposal.taps_used ? "; " + proposal.taps_used + " tapped line start(s) used as anchors" : "") +
              (wl.length || sp.length ? "; tap line starts to help (step 6), then run step 7 again" : "") +
              (proposal.studio_hint ? ". For best results use the studio master recording, not a live performance." : "") };
        });
      }
      });
    },
    review: function () {
      var r = SS.reviewWords(session);
      r.summary = r.hand_placed + " hand-placed, " + r.machine_placed + " machine-placed, " + r.words_without_contour + " word(s) with no contour nearby" + (r.unplaced.length ? ", " + r.unplaced.length + " unplaced" : "");
      return r;
    }
  };
  function finishPipeline(r) {
    var ok = r && r.ok;
    setStatus(ok ? "Tools finished" + (r.driver === "ai" ? " (driven by the local AI)" : "") + ". Listen to the flagged words, then run steps 7–10 (7 re-places with any taps)." : "Pipeline stopped" + (r && r.stoppedAt ? " at " + r.stoppedAt : "") + ": " + (r && (r.error || (r.log && r.log.length && r.log[r.log.length - 1].result.error)) || "see the list"), ok ? "ok" : "warn");
    if (r && r.summary) gMessage(r.summary);
  }
  document.getElementById("btn-pipeline-cpu").addEventListener("click", function () {
    document.getElementById("pipeline-log").textContent = "";
    pipelineRunning = true;
    SS.runPipelineWithoutAi(pipelineTools, { onStep: logStep }).then(function (r) { pipelineRunning = false; finishPipeline(r); }, function (e) { pipelineRunning = false; setStatus(e.message || String(e), "warn"); });
  });
  document.getElementById("btn-pipeline-ai").addEventListener("click", function () {
    var cfg = SS.getAiConfig ? SS.getAiConfig() : {};
    if (!cfg.enabled || !cfg.baseUrl) { setStatus("Connect a local AI first (AI connection panel), then try again. Or use Run the tools.", "warn"); return; }
    document.getElementById("pipeline-log").textContent = "";
    var send = function (messages, opts) { return SS.sendAiChatAsync(messages, Object.assign({ timeoutMs: 180000 }, opts)); };
    pipelineRunning = true;
    SS.runPipelineWithAi(pipelineTools, send, { onStep: logStep }).then(function (r) { pipelineRunning = false; finishPipeline(r); }, function (e) {
      pipelineRunning = false;
      setStatus("The AI run failed (" + (e.message || e) + "). The tools that ran are kept; Run the tools works without AI.", "warn");
    });
  });

  var handoffPreviewUrl=null;
  function makeCurrentHandoff() {
    syncReferenceFromFields();ensureLyricsFromBox();
    var mine=document.getElementById('new-lyrics').value;
    if(!mine.trim())throw new Error('Paste your replacement lyrics before exporting the visual handoff.');
    var product=fullHandoff(mine);
    return Object.assign(product,{svg:SS.svgPicture(product.map,product.handoff)});
  }
  function previewCurrentHandoff() {
    var product=makeCurrentHandoff();
    if(handoffPreviewUrl)URL.revokeObjectURL(handoffPreviewUrl);
    handoffPreviewUrl=URL.createObjectURL(new Blob([product.svg],{type:'image/svg+xml'}));
    document.getElementById('visual-handoff-image').src=handoffPreviewUrl;
    document.getElementById('visual-handoff').hidden=false;
    document.getElementById('visual-handoff-review').textContent=
      product.handoff.rows.filter(r=>r.status==='needs_review').length+' line(s) flagged for review. '
      +'This visual shows estimated lyric placement, not target-audio word timing or exact musical notes.';
    document.getElementById('map-output').value=product.handoff.prompt;
    setStatus('Visual handoff ready locally. Export PNG and copy the AI request; neither contains source audio.','ok');
    return product;
  }
  document.getElementById('btn-visual-handoff').addEventListener('click',function(){
    try{previewCurrentHandoff();}catch(e){setStatus('Could not build visual handoff: '+e.message,'warn');}
  });
  document.getElementById('btn-handoff-html').addEventListener('click',function(){
    try{var x=previewCurrentHandoff();downloadBlob(new Blob([SS.htmlReport(x.map,x.handoff)],{type:'text/html;charset=utf-8'}),
      'songshape-visual-handoff.html');setStatus('Saved offline report; it embeds no audio or remote resources.','ok');}
    catch(e){setStatus(e.message,'warn');}
  });
  document.getElementById('btn-handoff-json').addEventListener('click',function(){
    try{var x=makeCurrentHandoff();downloadBlob(new Blob([JSON.stringify(x.handoff.payload,null,2)],{type:'application/json'}),
      'songshape-ai-handoff.json');setStatus('Saved private AI handoff JSON. Nothing sent.','ok');}
    catch(e){setStatus(e.message,'warn');}
  });
  document.getElementById('btn-handoff-png').addEventListener('click',function(){
    var x;try{x=previewCurrentHandoff();}catch(e){setStatus(e.message,'warn');return;}
    var img=new Image();var url=URL.createObjectURL(new Blob([x.svg],{type:'image/svg+xml'}));
    img.onload=function(){
      try{
        var canvas=document.createElement('canvas');canvas.width=Math.min(img.naturalWidth||1200,2400);
        canvas.height=Math.min(img.naturalHeight||500,20000);
        var ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,canvas.width,canvas.height);
        canvas.toBlob(function(blob){
          URL.revokeObjectURL(url);
          if(!blob){setStatus('PNG image export failed in this browser. Use the HTML report.','warn');return;}
          downloadBlob(blob,'songshape-visual-handoff.png');
          setStatus('Saved replacement-lyrics visual PNG locally. Nothing uploaded.','ok');
        },'image/png');
      }catch(e){URL.revokeObjectURL(url);setStatus('PNG export failed: '+e.message,'warn');}
    };
    img.onerror=function(){URL.revokeObjectURL(url);setStatus('PNG rasterization unsupported; use the visual HTML report.','warn');};
    img.src=url;
  });

  // Public hook for headless tests.
  window.__songshape = {
    version: SS.APP_VERSION,
    getSession: function () { return SS.sessionToJSON(session); },
    getAudioName: function () { return player.getFileName(); },
    getDuration: function () { return player.duration(); },
    hasWaveform: function () { return !!(player.getWaveform && player.getWaveform()); },
    loadAudioFile: loadAudioFile,
    importJSONFile: importJSONFile,
    isSupportedAudioFile: SS.isSupportedAudioFile,
    loadDemo: loadDemo,
    getAiPrompt: function () { return SS.aiPrompt(session); },
    setStrokeSection: function (id, label) {
      SS.setStrokeSection(session, id, label);
      refreshStrokeList();
    },
    setSectionRange: function (a, b, label) {
      SS.setSectionRange(session, a, b, label);
      refreshStrokeList();
    },
    player: player,
    seekSafely: seekSafely,
    draw: draw,
    resetTrace: performReset,
    setMode: setMode,
    handleNoAudioDraft: handleNoAudioDraft,
    syncDraftViewDefault: syncDraftViewDefault,
    previewVisualHandoff: previewCurrentHandoff,
    proposeWordPositions: proposeWordPositions,
    loadDemoMp3: loadDemoMp3,
    guided: { runStage: runStage, runAll: function () { return runFrom(1); }, cont: function () { var f = guided.pausedAt + 1; guided.pausedAt = 0; return runFrom(f); }, state: guided },
    aiDraftRun: aiDraftRun,
    getAiExamples: function () { return aiExamples.slice(); },
    placeNextWordAt: function (ms) {
      ensureLyricsFromBox();
      return SS.placeNextWord(session, { start_ms: ms, end_ms: ms });
    }
  };

  renderer.resize();
  refreshRateButtons();
  refreshStrokeList();
  setMode("place");
  refreshLyricsUi();
  syncDraftViewDefault();
  setStatus("Load a lead-vocal WAV or MP3, paste both lyric sets, then estimate word timing or import offline alignment. Use Visual handoff to share the result.", "info");
  draw();
  requestAnimationFrame(raf);

  var params = new URLSearchParams(location.search);
  if (params.get("demo") === "1") {
    loadDemo(true);
  }
})();
