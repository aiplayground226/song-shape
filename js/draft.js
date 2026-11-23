/**
 * Song Shape v0.2 — convert measured pitch + RMS frames into an editable
 * DRAFT layer. This layer is measured pitch, not a hand trace of perceived
 * delivery, and must stay visually and semantically distinct.
 */
(function (root) {
  "use strict";

  var SS = root.SongShape || {};
  if (typeof module !== "undefined" && module.exports) Object.assign(SS, require("./contour-clean.js"));

  function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function median(values) {
    if (SS.median) return SS.median(values);
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function smoothSeries(frames, field, radius) {
    var r = radius == null ? 2 : radius;
    var out = frames.map(function (f) { return f[field]; });
    var i, j, sum, n;
    var smoothed = out.slice();
    for (i = 0; i < frames.length; i += 1) {
      if (!frames[i].voiced) continue;
      sum = 0;
      n = 0;
      for (j = i - r; j <= i + r; j += 1) {
        if (j < 0 || j >= frames.length) continue;
        if (!frames[j].voiced || !isFiniteNumber(frames[j][field]) || frames[j][field] <= 0) continue;
        sum += frames[j][field];
        n += 1;
      }
      if (n) smoothed[i] = sum / n;
    }
    return smoothed;
  }

  /**
   * Build a draft object from analysis frames.
   * y = clamp(log2(f0 / baselineHz), -1, +1) so ±1 is about one octave
   * around the median voiced pitch (the measured baseline).
   * Gaps are inserted at unvoiced / silent runs.
   */
  function buildDraft(frames, opts) {
    opts = opts || {};
    var cleanup = SS.cleanPitchFrames && opts.cleanup === true ? SS.cleanPitchFrames(frames, opts.cleanupOptions) : null;
    if (cleanup) frames = cleanup.frames;
    var minGapMs = opts.minGapMs == null ? 120 : opts.minGapMs;
    var pointStep = opts.pointStep == null ? 20 : opts.pointStep;
    var voicedHz = [];
    var i;
    for (i = 0; i < (frames || []).length; i += 1) {
      if (frames[i].voiced && frames[i].f0 > 0) voicedHz.push(frames[i].f0);
    }
    // v0.2.11 fix6f: with a measured vocal range the baseline is the range midpoint (log pitch).
    var fixed = !(opts.baselineHz == null || opts.baselineHz === 0);
    var range = opts.range && isFiniteNumber(opts.range.baseline_hz) && opts.range.baseline_hz > 0 ? opts.range : null;
    var baselineHz = fixed ? opts.baselineHz : range ? range.baseline_hz : (median(voicedHz) || 220);
    var baselineFrom = fixed ? "fixed" : range ? "vocal_range_midpoint" : "median_f0";
    if (!isFiniteNumber(baselineHz) || baselineHz <= 0 || baselineHz > 20000) {
      throw new Error("Fixed measured-pitch baseline must be between 0 and 20000 Hz.");
    }
    var smoothF0 = smoothSeries(frames || [], "f0", 2);
    var strokes = [];
    var gaps = [];
    var current = null;
    var lastVoicedEnd = null;
    var lastPointT = -Infinity;

    function yFor(f0) {
      if (!f0 || !baselineHz) return 0;
      return clamp(Math.log(f0 / baselineHz) / Math.log(2), -1, 1);
    }

    function closeStroke(endMs) {
      if (!current) return;
      current.end_ms = endMs;
      if (current.points.length) {
        current.end_ms = current.points[current.points.length - 1][0];
        strokes.push(current);
      }
      current = null;
    }

    for (i = 0; i < (frames || []).length; i += 1) {
      var f = frames[i];
      var t = f.t_ms;
      if (f.voiced && f.f0 > 0) {
        if (lastVoicedEnd != null && !current && t - lastVoicedEnd >= minGapMs) {
          gaps.push({
            start_ms: lastVoicedEnd,
            end_ms: t,
            duration_ms: t - lastVoicedEnd,
            label: "unvoiced_interval_unknown_cause",
            breath: "unknown"
          });
        }
        if (!current) {
          current = {
            id: "draft-" + (strokes.length + 1),
            phrase_id: null,
            start_ms: t,
            end_ms: t,
            points: [[t, yFor(smoothF0[i] || f.f0)]],
            annotations: ["measured_pitch_draft"],
            section: null,
            layer: "draft"
          };
          lastPointT = t;
        } else if (t - lastPointT >= pointStep) {
          current.points.push([t, yFor(smoothF0[i] || f.f0)]);
          current.end_ms = t;
          lastPointT = t;
        }
        lastVoicedEnd = t;
      } else if (current) {
        closeStroke(t);
      }
    }
    closeStroke(lastVoicedEnd != null ? lastVoicedEnd : 0);

    return {
      method: "measured_pitch_and_rms",
      y_semantics: "measured_pitch_relative_to_estimated_baseline",
      y_units: "normalized_octaves_around_median_f0",
      baseline_hz: baselineHz,
      baseline_from: baselineFrom,
      strokes: strokes,
      gaps: gaps,
      accepted: false,
      cleanup: cleanup ? cleanup.stats : null
    };
  }

  var NO_AUDIO_DRAFT_MESSAGE =
    "Open audio (.wav or .mp3) first, then build a draft from the decoded audio.";

  /**
   * Decide whether "Draft only the current view / selection" should
   * default to on: a loop is set, or the visible window is zoomed in
   * relative to the full file.
   */
  function shouldDefaultDraftOnlyView(opts) {
    opts = opts || {};
    var durationMs = opts.durationMs || 0;
    if (opts.loop && isFiniteNumber(opts.loop.startMs) && isFiniteNumber(opts.loop.endMs) &&
        opts.loop.endMs > opts.loop.startMs) {
      return true;
    }
    if (durationMs <= 0 || !opts.view) return false;
    var span = opts.view.endMs - opts.view.startMs;
    return span < durationMs * 0.85 && span < durationMs - 500;
  }

  /**
   * Plan a draft job. If no audio is loaded, returns the no-audio
   * message and a flag to highlight the Open .wav control.
   */
  function planDraftJob(opts) {
    opts = opts || {};
    if (!opts.hasAudio) {
      return {
        ok: false,
        message: NO_AUDIO_DRAFT_MESSAGE,
        highlightOpen: true
      };
    }
    var durationMs = isFiniteNumber(opts.durationMs) ? opts.durationMs : 0;
    var startMs = 0;
    var endMs = durationMs;
    var onlyView = !!opts.onlyView;
    if (onlyView) {
      if (opts.loop && isFiniteNumber(opts.loop.startMs) && isFiniteNumber(opts.loop.endMs) &&
          opts.loop.endMs > opts.loop.startMs) {
        startMs = opts.loop.startMs;
        endMs = opts.loop.endMs;
      } else if (opts.view && isFiniteNumber(opts.view.startMs) && isFiniteNumber(opts.view.endMs)) {
        startMs = opts.view.startMs;
        endMs = opts.view.endMs;
      }
    }
    if (startMs < 0) startMs = 0;
    if (durationMs && endMs > durationMs) endMs = durationMs;
    if (endMs < startMs) endMs = startMs;
    return {
      ok: true,
      startMs: startMs,
      endMs: endMs,
      onlyView: onlyView,
      durationMs: durationMs
    };
  }

  function emptyDraft() {
    return {
      method: "measured_pitch_and_rms",
      y_semantics: "measured_pitch_relative_to_estimated_baseline",
      y_units: "normalized_octaves_around_median_f0",
      baseline_hz: 0,
      strokes: [],
      gaps: [],
      accepted: false
    };
  }

  // Stable fingerprint of original draft geometry. Exported stroke annotations
  // preserve this provenance even after save/reload without schema migration.
  function draftFingerprint(s) {
    var text = JSON.stringify([s.start_ms, s.end_ms, s.points || []]);
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return ("00000000" + hash.toString(16)).slice(-8);
  }

  /**
   * Accept the measured draft non-destructively; never erase hand strokes.
   * Accepted points are a starting hypothesis, not a human-drawn trace.
   * Repeated acceptance and repeated identical measurements do not duplicate.
   */
  function acceptDraft(session) {
    if (!session || !session.draft || !Array.isArray(session.draft.strokes)) return session;
    if (session.draft.accepted) return session;
    session.strokes = session.strokes || [];
    session.draft.strokes.forEach(function (s) {
      var marker = "machine-draft-fingerprint:" + draftFingerprint(s);
      if (session.strokes.some(function (old) {
        return Array.isArray(old.annotations) && old.annotations.indexOf(marker) >= 0;
      })) return;
      var copy = {
        id: SS.nextId ? SS.nextId("stroke-", session.strokes) : "stroke-" + (session.strokes.length + 1),
        phrase_id: null,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        points: (s.points || []).map(function (p) { return [p[0], p[1]]; }),
        annotations: ["machine_measured_pitch_draft", marker],
        section: null,
        word_id: null
      };
      session.strokes.push(copy);
    });
    // Recomputed adjacency can split/remove an interval when machine data is added.
    // Preserve user-supplied gap labels as annotations; their meaning remains human-provided,
    // not an assertion of audio silence (or a machine-inferred breath).
    var labeledIntervals = (session.gaps || []).filter(function(g) {
      return (g.label && g.label !== 'unlabeled_gap' && g.label !== 'unknown') ||
        (g.breath && g.breath !== 'unknown');
    }).map(function(g) { return Object.assign({}, g); });
    if (SS.recomputeGaps) SS.recomputeGaps(session);
    labeledIntervals.forEach(function(g) {
      if (!(session.gaps || []).some(function(x) {return x.start_ms === g.start_ms && x.end_ms === g.end_ms;})) session.gaps.push(g);
    });
    session.gaps.sort(function(a,b){return a.start_ms-b.start_ms;});
    session.draft.accepted = true;
    return session;
  }

  /** v0.2.11: drop earlier unlinked CPU-measured strokes before a re-measure. Hand, AI and word-linked strokes stay. */
  function removeUnlinkedMachineDraft(session) {
    if (!session || !Array.isArray(session.strokes)) return 0;
    var linked = {};
    (session.anchors || []).forEach(function (a) {
      if (a.stroke_id) linked[a.stroke_id] = true;
      (a.stroke_ids || []).forEach(function (id) { linked[id] = true; });
    });
    var before = session.strokes.length;
    session.strokes = session.strokes.filter(function (s) {
      var machine = Array.isArray(s.annotations) && s.annotations.indexOf("machine_measured_pitch_draft") >= 0;
      return !machine || s.word_id || linked[s.id];
    });
    return before - session.strokes.length;
  }

  var api = {
    removeUnlinkedMachineDraft: removeUnlinkedMachineDraft,
    buildDraft: buildDraft,
    emptyDraft: emptyDraft,
    acceptDraft: acceptDraft,
    planDraftJob: planDraftJob,
    shouldDefaultDraftOnlyView: shouldDefaultDraftOnlyView,
    NO_AUDIO_DRAFT_MESSAGE: NO_AUDIO_DRAFT_MESSAGE
  };

  root.SongShape = root.SongShape || {};
  Object.keys(api).forEach(function (k) { root.SongShape[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) {
    var base;
    try { base = require("./pitch.js"); } catch (e) { base = root.SongShape; }
    Object.keys(api).forEach(function (k) { base[k] = api[k]; });
    module.exports = base;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
