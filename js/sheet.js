/**
 * Song Shape v0.2 — rule-based Suno lyric-sheet export.
 * Works WITHOUT an AI connection. Uses anchored words, remembered line
 * breaks, and the shape of the (hand) trace to insert short delivery cues
 * in a line-directed style: one global vocal direction, section
 * tags, and short per-line cues (start softly, rise, hold, break here,
 * plunge, step down).
 *
 * The trace maps the LEAD singer only. Per-line cues never imply a
 * vocalist swap, duet, or choir handoff. Harmony is optional backing and
 * is written only on lines the user marked.
 *
 * Line text is always kept intact (never split into loose words).
 */
(function (root) {
  "use strict";

  var SS = root.SongShape || {};

  function wordText(session, wordId) {
    var w = SS.wordById ? SS.wordById(session, wordId) : null;
    return w && w.text ? w.text : "";
  }

  function strokeAt(session, strokeId, timeMs) {
    var strokes = session.strokes || [];
    var i;
    if (strokeId) {
      for (i = 0; i < strokes.length; i += 1) {
        if (strokes[i].id === strokeId) return strokes[i];
      }
    }
    if (timeMs == null) return null;
    for (i = 0; i < strokes.length; i += 1) {
      var s = strokes[i];
      if (timeMs >= s.start_ms && timeMs <= s.end_ms) return s;
    }
    return null;
  }

  function primaryStrokeId(anchor) {
    if (!anchor) return null;
    if (anchor.stroke_ids && anchor.stroke_ids.length) return anchor.stroke_ids[0];
    return anchor.stroke_id || null;
  }

  function gapBefore(session, timeMs) {
    var gaps = session.gaps || [];
    var i;
    var best = null;
    for (i = 0; i < gaps.length; i += 1) {
      var g = gaps[i];
      if (g.end_ms <= timeMs + 1 && timeMs - g.end_ms < 80) {
        if (!best || g.duration_ms > best.duration_ms) best = g;
      }
    }
    return best;
  }

  function cueForStroke(session, stroke, gap) {
    if (!stroke) return [];
    var cues = [];
    var dir = SS.describeDirection ? SS.describeDirection(stroke) : "";
    var h = SS.strokeHeights ? SS.strokeHeights(stroke) : null;
    if (h && h.start <= -0.2 && (dir === "up" || dir === "up, then down")) {
      cues.push("start softly");
    }
    if (dir === "up") cues.push("rise");
    else if (dir === "up, then down") cues.push("rise");
    else if (dir === "held") cues.push("hold");
    else if (dir === "down") cues.push("plunge");
    else if (dir === "down, then up") cues.push("step down");
    if (dir === "up, then down") cues.push("drop");
    if (gap && gap.duration_ms >= 250) cues.push("break here");
    return cues;
  }

  function lineTagForCue(cue) {
    if (cue === "rise") return "[Rising pitch]";
    if (cue === "drop" || cue === "plunge") return "[Pitch drop]";
    return null;
  }

  function performerIdentity(session) {
    if (session && session.performer && session.performer.identity) {
      return String(session.performer.identity).replace(/\s+/g, " ").trim();
    }
    if (SS.defaultPerformerIdentity) return SS.defaultPerformerIdentity();
    return "One consistent lead singer for all sung passages; same vocal timbre, character, and diction throughout. Intensity, register, sustain, dynamics, and expression may vary naturally. No unexpected additional singer, duet, choir handoff, or voice-character change.";
  }

  function globalVocalDirectionLine(session) {
    return "[Global Vocal Direction: " + performerIdentity(session) + "]";
  }

  function lineAnchors(session, lineId) {
    var list = [];
    (session.anchors || []).forEach(function (a) {
      if (a.line_id === lineId) list.push(a);
    });
    list.sort(function (a, b) { return a.start_ms - b.start_ms; });
    return list;
  }

  function lineIsHarmonized(session, line) {
    if (SS.lineHasHarmony && SS.lineHasHarmony(session, line.id)) return true;
    var anchors = lineAnchors(session, line.id);
    var i;
    for (i = 0; i < anchors.length; i += 1) {
      if (anchors[i].harmony) return true;
    }
    if (!anchors.length) return false;
    var start = anchors[0].start_ms;
    var end = anchors[anchors.length - 1].end_ms;
    return !!(SS.rangeHasHarmony && SS.rangeHasHarmony(session, start, end));
  }

  /**
   * Build a tagged lyric sheet from the session's lyrics, anchors, and traces.
   * Line breaks from the pasted lyrics are always kept. The lead identity is
   * written once at the top, not repeated on every line.
   */
  function buildLyricSheet(session, opts) {
    opts = opts || {};
    var linesOut = [];
    var lyrics = session && session.lyrics;
    if (!lyrics || !lyrics.lines || !lyrics.lines.length) {
      return {
        text: "",
        warning: "No lyrics have been pasted yet."
      };
    }

    if (opts.title) linesOut.push("# " + String(opts.title));
    linesOut.push(globalVocalDirectionLine(session));
    linesOut.push("");

    var usedCues = {};
    var i;
    for (i = 0; i < lyrics.lines.length; i += 1) {
      var line = lyrics.lines[i];
      if (line.kind === "blank") {
        linesOut.push("");
        continue;
      }
      if (line.kind === "tag") {
        linesOut.push(line.text.trim());
        continue;
      }

      var wordAnchors = lineAnchors(session, line.id);
      var firstAnchor = wordAnchors[0] || null;

      var section = null;
      if (firstAnchor) {
        var st = strokeAt(session, primaryStrokeId(firstAnchor), firstAnchor.start_ms);
        if (st && SS.strokeSectionLabel) section = SS.strokeSectionLabel(session, st);
      }
      if (section && !usedCues["section:" + section]) {
        linesOut.push("[" + section + "]");
        usedCues["section:" + section] = true;
      }

      var stroke = firstAnchor ? strokeAt(session, primaryStrokeId(firstAnchor), firstAnchor.start_ms) : null;
      var gap = firstAnchor ? gapBefore(session, firstAnchor.start_ms) : null;
      var cues = cueForStroke(session, stroke, gap);
      var c;
      for (c = 0; c < cues.length; c += 1) {
        var tag = lineTagForCue(cues[c]);
        if (tag && !usedCues[tag + i]) {
          linesOut.push(tag);
          usedCues[tag + i] = true;
        } else if (!tag) {
          linesOut.push("(" + cues[c] + ")");
        }
      }

      if (lineIsHarmonized(session, line) && SS.harmonyCue) {
        linesOut.push(SS.harmonyCue(session));
      }

      // Always restore the original line (word order + punctuation).
      // A descent cue describes the line; it must not split the line into words.
      linesOut.push(line.text.replace(/\s+$/, ""));
    }

    return { text: linesOut.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, ""), warning: null };
  }

  var SUNO_LIMITATIONS =
    "Suno (and similar generators) do not guarantee that bracketed cues will be followed. " +
    "Tags and parenthetical directions are suggestions, not promised control over pitch, " +
    "harmony, timing, or who sings. The same lead identity is written once; harmony cues " +
    "are added only where you marked backing harmony under that lead.";

  var api = {
    buildLyricSheet: buildLyricSheet,
    cueForStroke: cueForStroke,
    globalVocalDirectionLine: globalVocalDirectionLine,
    performerIdentity: performerIdentity,
    SUNO_LIMITATIONS: SUNO_LIMITATIONS
  };

  root.SongShape = root.SongShape || {};
  Object.keys(api).forEach(function (k) { root.SongShape[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) {
    var base;
    try { base = require("./lyrics.js"); } catch (e) { base = root.SongShape; }
    Object.keys(api).forEach(function (k) { base[k] = api[k]; });
    module.exports = base;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
