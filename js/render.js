/**
 * Song Shape — canvas renderer.
 * Fixed playhead, scrolling timeline, seconds marks, optional waveform.
 * A continuous polyline is drawn *inside* a stroke only. Gaps are never joined.
 */
(function (root) {
  "use strict";

  var SS = root.SongShape;

  function createRenderer(canvas) {
    var ctx = canvas.getContext("2d");
    var view = {
      pixelsPerSecond: 120,
      playheadRatio: 0.32,
      showWaveform: true,
      showDraft: true,
      mode: "place",
      selectedId: null,
      selectedAnchorId: null,
      sensitivity: 1
    };

    function resize() {
      var parent = canvas.parentElement;
      var cssW = Math.max(320, parent.clientWidth);
      var cssH = Math.max(280, parent.clientHeight);
      var dpr = window.devicePixelRatio || 1;
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { width: cssW, height: cssH };
    }

    function layout(w, h) {
      var rulerH = 28;
      var waveH = view.showWaveform ? 44 : 0;
      var padLeft = 8;
      var padRight = 8;
      var padBottom = 8;
      var plotTop = rulerH + waveH + 8;
      return {
        width: w,
        height: h,
        ruler: { x: padLeft, y: 0, w: w - padLeft - padRight, h: rulerH },
        wave: { x: padLeft, y: rulerH, w: w - padLeft - padRight, h: waveH },
        plot: { x: padLeft, y: plotTop, w: w - padLeft - padRight, h: h - plotTop - padBottom }
      };
    }

    function playheadX(L) {
      return L.plot.x + L.plot.w * view.playheadRatio;
    }

    function timeToX(tSec, currentTime, L) {
      return playheadX(L) + (tSec - currentTime) * view.pixelsPerSecond;
    }

    function xToTime(x, currentTime, L) {
      return currentTime + (x - playheadX(L)) / view.pixelsPerSecond;
    }

    function normToY(y, plot) {
      var mid = plot.y + plot.h / 2;
      return mid - y * (plot.h / 2);
    }

    function yToNorm(yPx, plot, sensitivity) {
      var mid = plot.y + plot.h / 2;
      var half = plot.h / 2;
      var raw = (mid - yPx) / half;
      var s = sensitivity == null ? 1 : sensitivity;
      return SS.clamp(raw * s, -1, 1);
    }

    function visibleRange(currentTime, L) {
      var t0 = xToTime(L.plot.x, currentTime, L);
      var t1 = xToTime(L.plot.x + L.plot.w, currentTime, L);
      return { t0: t0, t1: t1 };
    }

    function draw(session, player, recorder) {
      var size = { width: canvas.clientWidth, height: canvas.clientHeight };
      if (!size.width || !size.height) size = resize();
      var w = canvas.clientWidth;
      var h = canvas.clientHeight;
      var L = layout(w, h);
      var currentTime = player && player.hasAudio() ? player.currentTime() : 0;
      var duration = player && player.hasAudio() ? player.duration() : ((session.audio && session.audio.duration_ms) || 0) / 1000;
      var offsetSec = (session.timing_offset_ms || 0) / 1000;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#f8fafc";
      ctx.fillRect(0, 0, w, h);

      drawRuler(L, currentTime, duration);
      if (view.showWaveform) drawWaveform(L, currentTime, player);
      drawPlotGrid(L);
      drawLoop(L, currentTime, player);
      drawGaps(L, currentTime, session, offsetSec);
      drawHarmony(L, currentTime, session, offsetSec);
      if (view.showDraft) drawDraft(L, currentTime, session, offsetSec);
      drawTraces(L, currentTime, session, recorder, offsetSec);
      drawLineTaps(L, currentTime, session, offsetSec);
      drawAnchors(L, currentTime, session, offsetSec);
      drawTapCue(L);
      drawPlayhead(L, currentTime, duration);
      drawEdgeLabels(L);
    }

    function drawRuler(L, currentTime, duration) {
      var r = L.ruler;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y + r.h - 0.5);
      ctx.lineTo(r.x + r.w, r.y + r.h - 0.5);
      ctx.stroke();

      var vis = visibleRange(currentTime, L);
      var span = vis.t1 - vis.t0;
      var step = 1;
      if (span < 4) step = 0.5;
      if (span < 2) step = 0.25;
      if (span > 16) step = 2;
      if (span > 30) step = 5;
      var tStart = Math.floor(vis.t0 / step) * step;
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#64748b";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (var t = tStart; t <= vis.t1 + step; t += step) {
        if (t < -0.001) continue;
        if (duration && t > duration + 0.05) continue;
        var x = timeToX(t, currentTime, L);
        if (x < r.x || x > r.x + r.w) continue;
        var major = Math.abs((t / step) % (step >= 1 ? 1 : (1 / step)) ) < 1e-6 || Number.isInteger(Math.round(t * 1000) / 1000) && (Math.abs(t - Math.round(t)) < 1e-6);
        var isSecond = Math.abs(t - Math.round(t)) < 0.001;
        ctx.strokeStyle = isSecond ? "#94a3b8" : "#cbd5e1";
        ctx.beginPath();
        ctx.moveTo(x + 0.5, r.y + r.h - (isSecond ? 10 : 6));
        ctx.lineTo(x + 0.5, r.y + r.h);
        ctx.stroke();
        if (isSecond || step >= 1) {
          ctx.fillText(formatTick(t), x, r.y + 4);
        }
      }
    }

    function formatTick(t) {
      if (t < 0) return "";
      var total = Math.round(t * 1000) / 1000;
      var s = Math.floor(total);
      var m = Math.floor(s / 60);
      var rem = s % 60;
      var frac = total - s;
      var mmss = m + ":" + String(rem).padStart(2, "0");
      if (frac > 0.05 && frac < 0.95) return mmss + "." + Math.round(frac * 10);
      return mmss;
    }

    function drawWaveform(L, currentTime, player) {
      var wlane = L.wave;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(wlane.x, wlane.y, wlane.w, wlane.h);
      var wf = player && player.getWaveform && player.getWaveform();
      if (!wf || !wf.peaks || !wf.peaks.length) {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText("Waveform appears after a local .mp3 or .wav is loaded.", wlane.x + 8, wlane.y + wlane.h / 2);
        return;
      }
      var mid = wlane.y + wlane.h / 2;
      var amp = (wlane.h / 2) - 3;
      var vis = visibleRange(currentTime, L);
      ctx.fillStyle = "#94a3b8";
      var dur = wf.duration || 1;
      var n = wf.peaks.length;
      for (var x = wlane.x; x < wlane.x + wlane.w; x += 1) {
        var t = xToTime(x, currentTime, L);
        if (t < 0 || t > dur) continue;
        var idx = Math.floor((t / dur) * n);
        if (idx < 0 || idx >= n) continue;
        var p = wf.peaks[idx];
        var h = Math.max(1, p * amp);
        ctx.fillRect(x, mid - h, 1, h * 2);
      }
    }

    function drawPlotGrid(L) {
      var p = L.plot;
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.w, p.h);
      ctx.clip();
      ctx.fillStyle = "#f8fafc";
      ctx.fillRect(p.x, p.y, p.w, p.h);

      var guides = [0.66, 0.33, -0.33, -0.66];
      ctx.strokeStyle = "#e2e8f0";
      ctx.setLineDash([3, 7]);
      ctx.lineWidth = 1;
      guides.forEach(function (g) {
        var y = normToY(g, p);
        ctx.beginPath();
        ctx.moveTo(p.x, y);
        ctx.lineTo(p.x + p.w, y);
        ctx.stroke();
      });

      // Singer-specific baseline
      var y0 = normToY(0, p);
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1.7;
      ctx.setLineDash([7, 7]);
      ctx.beginPath();
      ctx.moveTo(p.x, y0);
      ctx.lineTo(p.x + p.w, y0);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    function drawEdgeLabels(L) {
      var p = L.plot;
      ctx.fillStyle = "#64748b";
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("More expressive rise", p.x + 6, p.y + 6);
      ctx.textBaseline = "bottom";
      ctx.fillText("Expressive fall", p.x + 6, p.y + p.h - 6);
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#475569";
      ctx.fillText("Singer baseline" + (view.vocalRange && view.vocalRange.baseline_note ? " · " + view.vocalRange.baseline_note + " (range " + view.vocalRange.low_note + "–" + view.vocalRange.high_note + ")" : ""), p.x + 6, normToY(0, p) - 4);
    }

    function drawLoop(L, currentTime, player) {
      if (!player || !player.getLoop) return;
      var loop = player.getLoop();
      if (!loop) return;
      var p = L.plot;
      var x0 = timeToX(loop.start, currentTime, L);
      var x1 = timeToX(loop.end, currentTime, L);
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, L.ruler.y, p.w, L.plot.y + L.plot.h);
      ctx.clip();
      ctx.fillStyle = "rgba(217, 119, 6, 0.08)";
      ctx.fillRect(x0, L.ruler.y, Math.max(1, x1 - x0), L.plot.y + L.plot.h - L.ruler.y);
      ctx.strokeStyle = "rgba(217, 119, 6, 0.6)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, L.ruler.y);
      ctx.lineTo(x0, L.plot.y + L.plot.h);
      ctx.moveTo(x1, L.ruler.y);
      ctx.lineTo(x1, L.plot.y + L.plot.h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    function drawGaps(L, currentTime, session, offsetSec) {
      var p = L.plot;
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.w, p.h);
      ctx.clip();
      (session.gaps || []).forEach(function (g) {
        var x0 = timeToX(g.start_ms / 1000 - offsetSec, currentTime, L);
        var x1 = timeToX(g.end_ms / 1000 - offsetSec, currentTime, L);
        if (x1 < p.x || x0 > p.x + p.w) return;
        ctx.fillStyle = "rgba(253, 186, 116, 0.18)";
        ctx.fillRect(x0, p.y, Math.max(2, x1 - x0), p.h);
        ctx.strokeStyle = "#fdba74";
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x0, p.y + 8, Math.max(2, x1 - x0), 22);
        ctx.setLineDash([]);
        ctx.fillStyle = "#9a3412";
        ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        var label = "gap " + ((g.end_ms - g.start_ms) / 1000).toFixed(2) + "s";
        if (g.label && g.label !== "unlabeled_gap") label = g.label + " · " + label;
        var mid = (x0 + x1) / 2;
        if (x1 - x0 > 36) ctx.fillText(label, mid, p.y + 12);
      });
      ctx.restore();
    }

    function eachDrawableStroke(session, recorder, fn) {
      (session.strokes || []).forEach(fn);
      if (recorder && recorder.active) fn(recorder.active);
    }

    function drawTraces(L, currentTime, session, recorder, offsetSec) {
      var p = L.plot;
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.w, p.h);
      ctx.clip();
      eachDrawableStroke(session, recorder, function (stroke) {
        var pts = stroke.points || [];
        if (!pts.length) return;
        var selected = view.selectedId && stroke.id === view.selectedId;
        ctx.beginPath();
        for (var i = 0; i < pts.length; i += 1) {
          var x = timeToX(pts[i][0] / 1000 - offsetSec, currentTime, L);
          var y = normToY(pts[i][1], p);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        // v0.2.7: AI-drafted proposals are dashed magenta until the user redraws them.
        var aiDraft = (stroke.annotations || []).indexOf("ai_drafted_trace") >= 0;
        ctx.strokeStyle = selected ? "#d97706" : (aiDraft ? "#db2777" : "#16a34a");
        ctx.lineWidth = selected ? 4.5 : 3.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (aiDraft) ctx.setLineDash([9, 6]);
        ctx.stroke();
        ctx.setLineDash([]);

        // End caps, not connectors
        var first = pts[0];
        var last = pts[pts.length - 1];
        drawCap(timeToX(first[0] / 1000 - offsetSec, currentTime, L), normToY(first[1], p), selected);
        drawCap(timeToX(last[0] / 1000 - offsetSec, currentTime, L), normToY(last[1], p), selected);
      });
      ctx.restore();
    }

    function drawCap(x, y, selected) {
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = selected ? "#d97706" : "#16a34a";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }

    function drawPlayhead(L, currentTime, duration) {
      var x = playheadX(L);
      var top = L.ruler.y;
      var bot = L.plot.y + L.plot.h;
      ctx.strokeStyle = "#d97706";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, top + 2);
      ctx.lineTo(x, bot);
      ctx.stroke();
      ctx.fillStyle = "#d97706";
      ctx.beginPath();
      ctx.moveTo(x - 7, top + 2);
      ctx.lineTo(x + 7, top + 2);
      ctx.lineTo(x, top + 12);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, normToY(0, L.plot), 5, 0, Math.PI * 2);
      ctx.fillStyle = "#d97706";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }

    /**
     * Export a PNG of either the current view or the full annotated span.
     * Always includes time axis, baseline, and a manual-annotation caption.
     */
    function exportPNG(session, player, recorder, opts) {
      opts = opts || {};
      var full = !!opts.fullTimeline;
      var srcW = canvas.clientWidth;
      var srcH = canvas.clientHeight;
      var exportCanvas = document.createElement("canvas");
      var width = full ? 1600 : Math.max(1200, srcW);
      var height = full ? 780 : Math.max(640, srcH + 80);
      exportCanvas.width = width * 2;
      exportCanvas.height = height * 2;
      var exportCtx = exportCanvas.getContext("2d");
      exportCtx.scale(2, 2);

      var saved = {
        pixelsPerSecond: view.pixelsPerSecond,
        playheadRatio: view.playheadRatio
      };

      var off = document.createElement("canvas");
      off.width = width;
      off.height = height - 72;
      off.style.width = width + "px";
      off.style.height = (height - 72) + "px";
      var offRenderer = createRenderer(off);
      offRenderer.view.mode = view.mode;
      offRenderer.view.showWaveform = view.showWaveform;
      offRenderer.view.selectedId = null;
      offRenderer.view.sensitivity = view.sensitivity;

      var duration = player && player.hasAudio() ? player.duration() : ((session.audio && session.audio.duration_ms) || 0) / 1000;
      var tStart = 0;
      var tEnd = duration || 1;
      if (session.strokes && session.strokes.length) {
        var times = [];
        session.strokes.forEach(function (s) {
          times.push(s.start_ms / 1000, s.end_ms / 1000);
        });
        tStart = Math.max(0, Math.min.apply(null, times) - 0.4);
        tEnd = Math.max(tEnd, Math.max.apply(null, times) + 0.4);
      }
      if (full) {
        var span = Math.max(1, tEnd - tStart);
        offRenderer.view.pixelsPerSecond = (width * 0.8) / span;
        offRenderer.view.playheadRatio = 0.1;
        var fakePlayer = makeExportPlayer(player, tStart + 0.1 * span / 0.8);
        offRenderer.resize = function () { return { width: width, height: height - 72 }; };
        Object.defineProperty(off, "clientWidth", { get: function () { return width; } });
        Object.defineProperty(off, "clientHeight", { get: function () { return height - 72; } });
        offRenderer.draw(session, fakePlayer, { active: null });
      } else {
        offRenderer.view.pixelsPerSecond = view.pixelsPerSecond;
        offRenderer.view.playheadRatio = view.playheadRatio;
        offRenderer.resize = function () { return { width: width, height: height - 72 }; };
        Object.defineProperty(off, "clientWidth", { get: function () { return width; } });
        Object.defineProperty(off, "clientHeight", { get: function () { return height - 72; } });
        offRenderer.draw(session, player, recorder || { active: null });
      }

      exportCtx.fillStyle = "#ffffff";
      exportCtx.fillRect(0, 0, width, height);
      exportCtx.drawImage(off, 0, 56);
      exportCtx.fillStyle = "#0f172a";
      exportCtx.font = "bold 20px ui-sans-serif, system-ui, sans-serif";
      exportCtx.textAlign = "left";
      exportCtx.textBaseline = "top";
      exportCtx.fillText("Song Shape — Live Tracing", 20, 14);
      exportCtx.font = "12px ui-sans-serif, system-ui, sans-serif";
      exportCtx.fillStyle = "#64748b";
      exportCtx.fillText(
        "Manual listener annotation of perceived vocal delivery relative to a singer baseline. Not measured pitch. A flowing line is drawn only inside each stroke; gaps are never joined.",
        20,
        38
      );
      exportCtx.fillStyle = "#64748b";
      exportCtx.font = "11px ui-sans-serif, system-ui, sans-serif";
      var audioName = session.audio && session.audio.name ? session.audio.name : "(no audio name)";
      exportCtx.fillText(
        "Audio file not included in this image: " + audioName +
        "    Gaps are timed releases — not automatically breaths.",
        20,
        height - 18
      );

      view.pixelsPerSecond = saved.pixelsPerSecond;
      view.playheadRatio = saved.playheadRatio;
      return exportCanvas.toDataURL("image/png");
    }

    function makeExportPlayer(player, current) {
      return {
        hasAudio: function () { return !!(player && player.hasAudio && player.hasAudio()); },
        currentTime: function () { return current; },
        duration: function () { return player && player.duration ? player.duration() : 0; },
        getWaveform: function () { return player && player.getWaveform ? player.getWaveform() : null; },
        getLoop: function () { return null; }
      };
    }


    function drawDraft(L, currentTime, session, offsetSec) {
      var draft = session && session.draft;
      if (!draft || !draft.strokes || !draft.strokes.length) return;
      ctx.save();
      ctx.strokeStyle = "rgba(13, 148, 136, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      draft.strokes.forEach(function (stroke) {
        var pts = stroke.points || [];
        if (pts.length < 2) return;
        ctx.beginPath();
        pts.forEach(function (pt, i) {
          var x = timeToX(pt[0] / 1000 - offsetSec, currentTime, L);
          var y = normToY(pt[1], L.plot);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
      ctx.restore();
    }

    function wordLabel(session, wordId) {
      if (root.SongShape && root.SongShape.wordById) {
        var w = root.SongShape.wordById(session, wordId);
        if (w && w.text) return w.text;
      }
      var words = session.lyrics && session.lyrics.words ? session.lyrics.words : [];
      var i;
      for (i = 0; i < words.length; i += 1) {
        if (words[i].id === wordId) return words[i].text || "";
      }
      return "";
    }

    function drawLineTaps(L, currentTime, session, offsetSec) {
      var labels = {}; ((session.lyrics && session.lyrics.lines) || []).forEach(function (l) { labels[l.id] = l.text; });
      ctx.save(); ctx.strokeStyle = "#9333ea"; ctx.fillStyle = "#7e22ce"; ctx.font = "11px ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = "left";
      var rowEnds = [-Infinity, -Infinity, -Infinity]; // close taps stack their labels in up to three rows
      (session.line_taps || []).forEach(function (t) {
        if (t.skipped || typeof t.t_ms !== "number") return;
        var x = timeToX(t.t_ms / 1000 - (offsetSec || 0), currentTime, L);
        if (x < L.plot.x || x > L.plot.x + L.plot.w) return;
        ctx.globalAlpha = 0.8; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(x, L.plot.y); ctx.lineTo(x, L.plot.y + L.plot.h); ctx.stroke(); ctx.setLineDash([]);
        var text = "Tap: " + String(labels[t.line_id] || "").slice(0, 30), w = ctx.measureText(text).width, row = 0;
        while (row < rowEnds.length - 1 && rowEnds[row] > x) row++;
        rowEnds[row] = x + w + 8;
        ctx.globalAlpha = 1; ctx.fillText(text, x + 4, L.plot.y + 14 + row * 13);
      }); ctx.restore();
    }

    // v0.2.11 fix6e: detected harmony regions (hints): a light purple band with a "harmony?" label.
    function drawHarmony(L, currentTime, session, offsetSec) {
      var regions = (session && session.detected_harmony) || [];
      if (!regions.length) return;
      ctx.save();
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "top";
      regions.forEach(function (r) {
        var x0 = timeToX(r.start_ms / 1000 - offsetSec, currentTime, L), x1 = timeToX(r.end_ms / 1000 - offsetSec, currentTime, L);
        if (x1 < L.plot.x || x0 > L.plot.x + L.plot.w) return;
        x0 = Math.max(L.plot.x, x0); x1 = Math.min(L.plot.x + L.plot.w, x1);
        ctx.globalAlpha = 0.07; ctx.fillStyle = "#7c3aed"; ctx.fillRect(x0, L.plot.y, x1 - x0, L.plot.h);
        ctx.globalAlpha = 0.55; ctx.fillRect(x0, L.plot.y + L.plot.h - 30, x1 - x0, 3);
        ctx.globalAlpha = 1; ctx.fillStyle = "#6d28d9";
        if (x1 - x0 > 44) ctx.fillText("harmony?", x0 + 3, L.plot.y + L.plot.h - 42);
      });
      ctx.restore();
    }
    function inHarmony(session, a) {
      var regions = (session && session.detected_harmony) || [];
      for (var i = 0; i < regions.length; i++) if (a.start_ms >= regions[i].start_ms && a.start_ms <= regions[i].end_ms) return true;
      return false;
    }

    // v0.2.11 fix6e: while tapping, the line to tap next is shown just above the word lane, at the playhead.
    function drawTapCue(L) {
      if (!view.tapNext) return;
      ctx.save();
      ctx.font = "bold 12px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      var text = "Next to tap: \u201c" + String(view.tapNext).slice(0, 60) + "\u201d", w = ctx.measureText(text).width + 14, x = playheadX(L) + 8, y = L.plot.y + L.plot.h - 62;
      if (x + w > L.plot.x + L.plot.w) x = Math.max(L.plot.x + 2, playheadX(L) - w - 8);
      ctx.fillStyle = "rgba(124,58,237,0.92)"; ctx.fillRect(x, y, w, 20);
      ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(text, x + 7, y + 10);
      ctx.restore();
    }

    function drawAnchors(L, currentTime, session, offsetSec) {
      var anchors = (session && session.anchors) || [];
      if (!anchors.length) return;
      ctx.save();
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      // v0.2.11: labels that would overlap step up into up to four rows (left to right), so close words stay readable.
      var rowEnds = [-Infinity, -Infinity, -Infinity, -Infinity];
      anchors.slice().sort(function (p, q) { return p.start_ms - q.start_ms; }).forEach(function (a) {
        var x = timeToX(a.start_ms / 1000 - offsetSec, currentTime, L);
        if (x < L.plot.x - 40 || x > L.plot.x + L.plot.w + 40) return;
        var y = L.plot.y + L.plot.h - 8;
        var selected = view.selectedAnchorId === a.id;
        var fill = a.harmony ? "#7c3aed" : "#2563eb";
        if (a.needs_review) fill = "#d97706";
        ctx.beginPath();
        ctx.fillStyle = fill;
        ctx.moveTo(x, y - 9);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x, y + 9);
        ctx.lineTo(x - 6, y);
        ctx.closePath();
        ctx.globalAlpha = selected ? 1 : 0.92;
        ctx.fill();
        if (inHarmony(session, a)) { // "H" badge: this word sits in a detected harmony region
          ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = "#7c3aed"; ctx.beginPath(); ctx.arc(x + 7, y - 9, 5, 0, 2 * Math.PI); ctx.fill();
          ctx.fillStyle = "#fff"; ctx.font = "bold 8px ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("H", x + 7, y - 9); ctx.restore();
        }
        if (selected) {
          ctx.strokeStyle = "#0f172a";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.stroke();
        } else if (a.needs_review) {
          ctx.strokeStyle = "#9a3412";
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        var label = wordLabel(session, a.word_id);
        if (label) {
          ctx.fillStyle = fill;
          ctx.globalAlpha = 1;
          var half = ctx.measureText(label).width / 2 + 2;
          var row = 0;
          while (row < rowEnds.length - 1 && x - half < rowEnds[row]) row += 1;
          rowEnds[row] = Math.max(rowEnds[row], x + half);
          if (row) {
            ctx.strokeStyle = fill; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, y - 10); ctx.lineTo(x, y - 12 - row * 13 + 2); ctx.stroke(); ctx.globalAlpha = 1;
          }
          ctx.fillText(label, x, y - 12 - row * 13);
        }
      });
      ctx.restore();
    }

    function hitTestAnchor(session, player, x, y, offsetMs) {
      var w = canvas.clientWidth;
      var h = canvas.clientHeight;
      var L = layout(w, h);
      if (y < L.plot.y || y > L.plot.y + L.plot.h) return null;
      var currentTime = player && player.hasAudio() ? player.currentTime() : 0;
      var offsetSec = (offsetMs || 0) / 1000;
      var best = null;
      var bestD = 16;
      ((session && session.anchors) || []).forEach(function (a) {
        var px = timeToX(a.start_ms / 1000 - offsetSec, currentTime, L);
        var py = L.plot.y + L.plot.h - 8;
        var d = Math.hypot(px - x, py - y);
        // Also accept clicks near the word label.
        if (y < py - 4) d = Math.hypot(px - x, py - 16 - y);
        if (d < bestD) {
          bestD = d;
          best = a.id;
        }
      });
      return best;
    }

    function hitTestStroke(session, player, x, y, offsetMs) {
      var w = canvas.clientWidth;
      var h = canvas.clientHeight;
      var L = layout(w, h);
      if (y < L.plot.y || y > L.plot.y + L.plot.h) return null;
      var currentTime = player && player.hasAudio() ? player.currentTime() : 0;
      var offsetSec = (offsetMs || 0) / 1000;
      var best = null;
      var bestD = 14;
      (session.strokes || []).forEach(function (stroke) {
        (stroke.points || []).forEach(function (pt) {
          var px = timeToX(pt[0] / 1000 - offsetSec, currentTime, L);
          var py = normToY(pt[1], L.plot);
          var d = Math.hypot(px - x, py - y);
          if (d < bestD) {
            bestD = d;
            best = stroke.id;
          }
        });
      });
      return best;
    }

    function regionAt(y) {
      var L = layout(canvas.clientWidth, canvas.clientHeight);
      if (y < L.ruler.y + L.ruler.h) return "ruler";
      if (view.showWaveform && y < L.wave.y + L.wave.h) return "wave";
      if (y >= L.plot.y && y <= L.plot.y + L.plot.h) return "plot";
      return "other";
    }

    return {
      view: view,
      resize: resize,
      layout: function () { return layout(canvas.clientWidth, canvas.clientHeight); },
      draw: draw,
      timeToX: function (t, current) { return timeToX(t, current, layout(canvas.clientWidth, canvas.clientHeight)); },
      xToTime: function (x, current) { return xToTime(x, current, layout(canvas.clientWidth, canvas.clientHeight)); },
      yToNorm: function (yPx) {
        var L = layout(canvas.clientWidth, canvas.clientHeight);
        return yToNorm(yPx, L.plot, view.sensitivity);
      },
      regionAt: regionAt,
      hitTestStroke: hitTestStroke,
      hitTestAnchor: hitTestAnchor,
      exportPNG: exportPNG,
      playheadX: function () { return playheadX(layout(canvas.clientWidth, canvas.clientHeight)); },
      visibleRange: function (current) {
        var L = layout(canvas.clientWidth, canvas.clientHeight);
        return visibleRange(current == null ? 0 : current, L);
      }
    };
  }

  root.SongShape = root.SongShape || {};
  root.SongShape.createRenderer = createRenderer;
})(typeof globalThis !== "undefined" ? globalThis : this);
