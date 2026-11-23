/**
 * Song Shape v0.2 — lyric parsing and sequential word anchors.
 * Primary mode: paste lyrics, then each click pins the next word in order.
 * Line breaks are preserved for sheet export. Bracket segments [like this]
 * are cues, never placeable words. Parentheses are backing vocals / ad-libs
 * and are not placed unless the user turns on “Place (parenthesis) words.”
 * Works in the browser and in Node.
 */
(function (root) {
  "use strict";

  var SS = root.SongShape || {};
  var MAX_LYRICS_CHARS = 100000;
  var MAX_WORDS = 20000;
  var MAX_LINES = 10000;
  var MAX_ANCHORS = 20000;

  function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  function clampTime(v) {
    var t = isFiniteNumber(v) ? v : 0;
    if (t < 0) t = 0;
    if (t > SS.MAX_TIME_MS) t = SS.MAX_TIME_MS;
    return t;
  }

  function cleanLyricsText(text) {
    var raw = text == null ? "" : String(text);
    raw = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    raw = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
    if (raw.length > MAX_LYRICS_CHARS) raw = raw.slice(0, MAX_LYRICS_CHARS);
    return raw;
  }

  function isTagLine(line) {
    return /^\s*\[[^\]\n]+\]\s*$/.test(line);
  }

  var BRACKET_CUE_RE = /\[[^\]\n]*\]/g;
  var PAREN_GROUP_RE = /\([^)\n]*\)/g;

  function lyricOptions(session, opts) {
    if (opts && opts.placeParentheses != null) {
      return { placeParentheses: !!opts.placeParentheses };
    }
    if (session && session.place_parentheses != null) {
      return { placeParentheses: !!session.place_parentheses };
    }
    return { placeParentheses: false };
  }

  /**
   * Words that can be placed on the timeline for a single line.
   * Any [...] segment is a cue and is never a token. Parenthetical
   * groups are omitted unless placeParentheses is on, in which case
   * the inner words are tokenized (the surrounding ( ) are not).
   * The original line text is not modified.
   */
  function placeableTokens(lineText, opts) {
    var work = String(lineText == null ? "" : lineText);
    work = work.replace(BRACKET_CUE_RE, " ");
    if (opts && opts.placeParentheses) {
      work = work.replace(PAREN_GROUP_RE, function (m) {
        return " " + m.slice(1, -1) + " ";
      });
    } else {
      work = work.replace(PAREN_GROUP_RE, " ");
    }
    // v0.2.11 fix4: an ellipsis is a pause, not a word. "for...honor" splits after the ellipsis; a standalone
    // "..." or "\u2026" joins the word before it (so it still marks a pause there) and is never a word itself.
    work = work.replace(/(\.{2,}|\u2026)(?=[^\s.\u2026])/g, "$1 ");
    var out = [];
    work.trim().split(/\s+/).filter(Boolean).forEach(function (t) {
      if (/^(\.{2,}|\u2026)+$/.test(t)) { if (out.length && !/(\.{2,}|\u2026)$/.test(out[out.length - 1])) out[out.length - 1] += t; return; }
      out.push(t);
    });
    return out;
  }

  function emptyLyrics() {
    return { text: "", lines: [], words: [] };
  }

  /**
   * Split pasted lyrics into lines and words. The original line text,
   * including inline [cues] and (ad-libs), is kept so sheet export can
   * restore it in place. Bracket cues are never placeable words.
   * A line with no placeable words (a section tag, a cue-only line, or
   * a parentheses-only line with the toggle off) is kind "tag".
   */
  function parseLyrics(text, opts) {
    var cleaned = cleanLyricsText(text);
    var options = lyricOptions(null, opts);
    var rawLines = cleaned.split("\n");
    if (rawLines.length > MAX_LINES) rawLines = rawLines.slice(0, MAX_LINES);
    var lines = [];
    var words = [];
    var i;
    for (i = 0; i < rawLines.length; i += 1) {
      var raw = rawLines[i];
      var lineId = "line-" + (i + 1);
      var tokens = placeableTokens(raw, options);
      var kind;
      if (/^\s*$/.test(raw)) kind = "blank";
      else if (isTagLine(raw) || tokens.length === 0) kind = "tag";
      else kind = "lyric";
      var line = {
        id: lineId,
        index: i,
        text: SS.sanitizeLabel ? SS.sanitizeLabel(raw, 2000) : raw,
        kind: kind,
        word_ids: []
      };
      if (kind === "lyric") {
        var w;
        for (w = 0; w < tokens.length; w += 1) {
          if (!tokens[w] || words.length >= MAX_WORDS) continue;
          var wordId = "word-" + (words.length + 1);
          words.push({
            id: wordId,
            line_id: lineId,
            index: words.length,
            text: SS.sanitizeLabel ? SS.sanitizeLabel(tokens[w], SS.MAX_STRING_LEN || 200) : tokens[w],
            skipped: false
          });
          line.word_ids.push(wordId);
        }
      }
      lines.push(line);
    }
    return { text: cleaned, lines: lines, words: words };
  }

  function ensureLyrics(session) {
    if (!session.lyrics || !Array.isArray(session.lyrics.words)) {
      session.lyrics = emptyLyrics();
    }
    if (!Array.isArray(session.anchors)) session.anchors = [];
    return session.lyrics;
  }

  function wordById(session, id) {
    var words = (session.lyrics && session.lyrics.words) || [];
    var i;
    for (i = 0; i < words.length; i += 1) {
      if (words[i].id === id) return words[i];
    }
    return null;
  }

  function lineById(session, id) {
    var lines = (session.lyrics && session.lyrics.lines) || [];
    var i;
    for (i = 0; i < lines.length; i += 1) {
      if (lines[i].id === id) return lines[i];
    }
    return null;
  }

  function placedWordIds(session) {
    var used = {};
    (session.anchors || []).forEach(function (a) {
      if (a.word_id) used[a.word_id] = true;
      (a.word_ids || []).forEach(function (id) { used[id] = true; });
    });
    return used;
  }

  function nextWord(session) {
    ensureLyrics(session);
    var used = placedWordIds(session);
    var words = session.lyrics.words;
    var i;
    for (i = 0; i < words.length; i += 1) {
      if (!used[words[i].id] && !words[i].skipped) return words[i];
    }
    return null;
  }

  function nextLine(session) {
    var word = nextWord(session);
    if (!word) return null;
    return lineById(session, word.line_id);
  }

  function nextGroupId(session) {
    var n = 1;
    (session.anchors || []).forEach(function (a) {
      var g = a.group_id && String(a.group_id).replace(/^group-/, "");
      var num = Number(g);
      if (isFiniteNumber(num) && num >= n) n = num + 1;
    });
    return "group-" + n;
  }

  function nextAnchorId(session) {
    return SS.nextId ? SS.nextId("anchor-", session.anchors || []) : "anchor-" + ((session.anchors || []).length + 1);
  }

  function setLyrics(session, text, opts) {
    var options = lyricOptions(session, opts);
    session.place_parentheses = options.placeParentheses;
    session.lyrics = parseLyrics(text, options);
    session.anchors = [];
    session.line_taps = []; // line ids change with the text
    session.active_word_id = null;
    return session.lyrics;
  }

  /**
   * Toggle whether words inside (parentheses) are placeable. Re-parses
   * the current lyric text and clears anchors, because the token list changed.
   */
  function setPlaceParentheses(session, on) {
    var text = session && session.lyrics && session.lyrics.text != null ? session.lyrics.text : "";
    return setLyrics(session, text, { placeParentheses: !!on });
  }

  function makeAnchor(session, word, opts, groupId) {
    var start = clampTime(opts && opts.start_ms);
    var end = opts && opts.end_ms != null ? clampTime(opts.end_ms) : start;
    if (end < start) end = start;
    var strokeIds = [];
    if (opts && opts.stroke_id) strokeIds.push(opts.stroke_id);
    if (opts && Array.isArray(opts.stroke_ids)) {
      opts.stroke_ids.forEach(function (id) {
        if (id && strokeIds.indexOf(id) < 0) strokeIds.push(id);
      });
    }
    return {
      id: nextAnchorId(session),
      word_id: word.id,
      line_id: word.line_id,
      word_ids: [word.id],
      kind: (opts && opts.kind) || "word",
      start_ms: start,
      end_ms: end,
      anchor_ms: start,
      stroke_id: strokeIds[0] || null,
      stroke_ids: strokeIds,
      needs_review: false,
      harmony: !!(opts && opts.harmony),
      source: (opts && opts.source) || "next_word",
      group_id: groupId || nextGroupId(session)
    };
  }

  /**
   * Pin the next unplaced, unskipped word at a time range or stroke.
   */
  function placeNextWord(session, opts) {
    ensureLyrics(session);
    if ((session.anchors || []).length >= MAX_ANCHORS) return null;
    var word = nextWord(session);
    if (!word) return null;
    var anchor = makeAnchor(session, word, opts || {}, nextGroupId(session));
    session.anchors.push(anchor);
    session.active_word_id = word.id;
    return anchor;
  }

  /**
   * Attach every remaining word in the current line, splitting the
   * time range evenly across those words.
   */
  function placeNextLine(session, opts) {
    ensureLyrics(session);
    var first = nextWord(session);
    if (!first) return [];
    var line = lineById(session, first.line_id);
    if (!line) return [];
    var used = placedWordIds(session);
    var pending = [];
    var i;
    for (i = 0; i < line.word_ids.length; i += 1) {
      var w = wordById(session, line.word_ids[i]);
      if (w && !used[w.id] && !w.skipped) pending.push(w);
    }
    if (!pending.length) return [];
    var start = clampTime(opts && opts.start_ms);
    var end = opts && opts.end_ms != null ? clampTime(opts.end_ms) : start;
    if (end < start) end = start;
    var span = Math.max(0, end - start);
    var groupId = nextGroupId(session);
    var placed = [];
    for (i = 0; i < pending.length; i += 1) {
      if ((session.anchors || []).length >= MAX_ANCHORS) break;
      var a = start;
      var b = start;
      if (pending.length === 1) {
        b = end;
      } else {
        a = start + Math.round((span * i) / pending.length);
        b = start + Math.round((span * (i + 1)) / pending.length);
      }
      var anchor = makeAnchor(session, pending[i], {
        start_ms: a,
        end_ms: b,
        stroke_id: opts && opts.stroke_id,
        source: "line",
        kind: "line"
      }, groupId);
      session.anchors.push(anchor);
      placed.push(anchor);
    }
    if (placed.length) session.active_word_id = placed[placed.length - 1].word_id;
    return placed;
  }

  function skipNextWord(session) {
    var word = nextWord(session);
    if (!word) return null;
    word.skipped = true;
    return word;
  }

  function unskipWord(session, wordId) {
    var word = wordById(session, wordId);
    if (!word) return null;
    word.skipped = false;
    return word;
  }

  /**
   * Step back one placement. If the last action attached a whole line
   * (shared group_id), every word in that group is unpinned together.
   */
  function undoLastAnchor(session) {
    ensureLyrics(session);
    if (!session.anchors.length) return null;
    var last = session.anchors[session.anchors.length - 1];
    var group = last.group_id;
    var removed = [];
    if (group) {
      while (session.anchors.length) {
        var a = session.anchors[session.anchors.length - 1];
        if (a.group_id !== group) break;
        removed.push(session.anchors.pop());
      }
    } else {
      removed.push(session.anchors.pop());
    }
    removed.reverse();
    removed.forEach(function (anchor) {
      detachAnchorStrokes(session, anchor, false);
    });
    if (session.anchors.length) {
      session.active_word_id = session.anchors[session.anchors.length - 1].word_id;
    } else {
      session.active_word_id = null;
    }
    return removed;
  }

  function anchorForWord(session, wordId) {
    var i;
    for (i = 0; i < (session.anchors || []).length; i += 1) {
      var a = session.anchors[i];
      if (a.word_id === wordId) return a;
      if ((a.word_ids || []).indexOf(wordId) >= 0) return a;
    }
    return null;
  }

  /**
   * Associate an already-drawn stroke with a word. This never places a
   * new lyric token. Strokes may also stay unassigned (word_id = null).
   */
  function assignStrokeToWord(session, strokeId, wordId) {
    if (!strokeId || !wordId) return null;
    var stroke = null;
    (session.strokes || []).forEach(function (s) {
      if (s.id === strokeId) stroke = s;
    });
    if (stroke && stroke.word_id && stroke.word_id !== wordId) {
      var prev = anchorForWord(session, stroke.word_id);
      if (prev && prev.stroke_ids) {
        prev.stroke_ids = prev.stroke_ids.filter(function (id) { return id !== strokeId; });
      }
    }
    if (stroke) stroke.word_id = wordId;
    var anchor = anchorForWord(session, wordId);
    if (!anchor) return stroke;
    anchor.stroke_ids = anchor.stroke_ids || [];
    if (anchor.stroke_ids.indexOf(strokeId) < 0) anchor.stroke_ids.push(strokeId);
    anchor.stroke_id = anchor.stroke_ids[0] || null;
    if (stroke && isFiniteNumber(stroke.end_ms) && stroke.end_ms > anchor.end_ms) {
      anchor.end_ms = stroke.end_ms;
    }
    return anchor;
  }

  function unassignStroke(session, strokeId) {
    var wordId = null;
    (session.strokes || []).forEach(function (s) {
      if (s.id === strokeId) {
        wordId = s.word_id;
        s.word_id = null;
      }
    });
    (session.anchors || []).forEach(function (a) {
      if (!a.stroke_ids) return;
      a.stroke_ids = a.stroke_ids.filter(function (id) { return id !== strokeId; });
      a.stroke_id = a.stroke_ids[0] || null;
    });
    return wordId;
  }

  function detachAnchorStrokes(session, anchor, deleteStrokes) {
    var ids = (anchor && anchor.stroke_ids) ? anchor.stroke_ids.slice() : [];
    ids.forEach(function (id) {
      (session.strokes || []).forEach(function (s) {
        if (s.id === id) s.word_id = null;
      });
    });
    if (anchor) {
      anchor.stroke_ids = [];
      anchor.stroke_id = null;
    }
    return ids;
  }

  function moveAnchor(session, id, startMs, endMs) {
    var i;
    for (i = 0; i < (session.anchors || []).length; i += 1) {
      var a = session.anchors[i];
      if (a.id !== id) continue;
      var dur = isFiniteNumber(a.end_ms - a.start_ms) ? Math.max(0, a.end_ms - a.start_ms) : 0;
      var start = clampTime(startMs);
      var end = endMs != null ? clampTime(endMs) : start + dur;
      if (end < start) end = start;
      a.start_ms = start;
      a.end_ms = end;
      a.anchor_ms = start;
      a.needs_review = false;
      (a.stroke_ids || []).forEach(function (sid) {
        (session.strokes || []).forEach(function (s) {
          if (s.id !== sid) return;
          var overlaps = s.end_ms >= start && s.start_ms <= end;
          if (!overlaps) {
            a.needs_review = true;
            s.needs_review = true;
          }
        });
      });
      return a;
    }
    return null;
  }

  function setHarmonyOnAnchor(session, anchorId, on) {
    var a = (session.anchors || []).filter(function (x) { return x.id === anchorId; })[0];
    if (!a) return null;
    a.harmony = !!on;
    return a;
  }

  function setHarmonyOnWord(session, wordId, on) {
    var a = anchorForWord(session, wordId);
    if (!a) return null;
    a.harmony = !!on;
    return a;
  }

  function setHarmonyOnLine(session, lineId, on) {
    var changed = [];
    (session.anchors || []).forEach(function (a) {
      if (a.line_id === lineId) {
        a.harmony = !!on;
        changed.push(a);
      }
    });
    return changed;
  }

  function setHarmonyRange(session, startMs, endMs, on) {
    session.harmony_ranges = session.harmony_ranges || [];
    var start = clampTime(startMs);
    var end = clampTime(endMs);
    if (end < start) { var tmp = start; start = end; end = tmp; }
    if (!on) {
      session.harmony_ranges = session.harmony_ranges.filter(function (r) {
        return !(r.start_ms === start && r.end_ms === end);
      });
      return session.harmony_ranges;
    }
    var existing = session.harmony_ranges.filter(function (r) {
      return r.start_ms === start && r.end_ms === end;
    })[0];
    if (existing) return existing;
    var range = {
      id: SS.nextId ? SS.nextId("harmony-", session.harmony_ranges) : "harmony-" + (session.harmony_ranges.length + 1),
      start_ms: start,
      end_ms: end
    };
    session.harmony_ranges.push(range);
    (session.anchors || []).forEach(function (a) {
      if (a.start_ms < end && a.end_ms > start) a.harmony = true;
    });
    return range;
  }

  function lineHasHarmony(session, lineId) {
    var yes = false;
    (session.anchors || []).forEach(function (a) {
      if (a.line_id === lineId && a.harmony) yes = true;
    });
    if (yes) return true;
    var lineAnchors = (session.anchors || []).filter(function (a) { return a.line_id === lineId; });
    if (!lineAnchors.length) return false;
    var start = Math.min.apply(null, lineAnchors.map(function (a) { return a.start_ms; }));
    var end = Math.max.apply(null, lineAnchors.map(function (a) { return a.end_ms; }));
    return rangeHasHarmony(session, start, end);
  }

  function rangeHasHarmony(session, startMs, endMs) {
    var i;
    for (i = 0; i < (session.harmony_ranges || []).length; i += 1) {
      var r = session.harmony_ranges[i];
      if (r.start_ms < endMs && r.end_ms > startMs) return true;
    }
    return false;
  }

  /**
   * Cue for a marked harmony region. Lead stays locked; harmony is support.
   * Off unless the user marked the word, line, or range.
   */
  function harmonyCue(session) {
    var identity = session && session.performer && session.performer.identity
      ? String(session.performer.identity)
      : "";
    var lead = "same lead singer";
    if (/\btenor\b/i.test(identity)) lead = "same lead tenor";
    else if (/\bsoprano\b/i.test(identity)) lead = "same lead soprano";
    else if (/\balto\b/i.test(identity)) lead = "same lead alto";
    else if (/\bbaritone\b/i.test(identity)) lead = "same lead baritone";
    var under = /\b(him|her|them)\b/i.test(" " + identity) || /\b(male|tenor|baritone)\b/i.test(identity)
      ? "under him"
      : "under the lead";
    if (/\bfemale\b|\bsoprano\b|\balto\b/i.test(identity) && !/\bmale\b/i.test(identity)) under = "under her";
    return "[" + lead + ", backing harmony joins " + under + "]";
  }

  function defaultPerformerIdentity() {
    return "One consistent lead singer for all sung passages; same vocal timbre, character, and diction throughout. Intensity, register, sustain, dynamics, and expression may vary naturally. No unexpected additional singer, duet, choir handoff, or voice-character change.";
  }

  function clearAnchors(session) {
    ensureLyrics(session);
    (session.anchors || []).forEach(function (a) { detachAnchorStrokes(session, a, false); });
    session.anchors = [];
    session.active_word_id = null;
    session.harmony_ranges = [];
    (session.lyrics.words || []).forEach(function (w) { w.skipped = false; });
    return session;
  }

  function anchorHitTest(session, timeMs, toleranceMs) {
    var tol = isFiniteNumber(toleranceMs) ? toleranceMs : 80;
    var t = clampTime(timeMs);
    var best = null;
    var bestDist = Infinity;
    (session.anchors || []).forEach(function (a) {
      var mid = (a.start_ms + a.end_ms) / 2;
      var dist;
      if (t >= a.start_ms - tol && t <= a.end_ms + tol) dist = 0;
      else dist = Math.min(Math.abs(t - a.start_ms), Math.abs(t - a.end_ms), Math.abs(t - mid));
      if (dist < bestDist && dist <= tol) {
        best = a;
        bestDist = dist;
      }
    });
    return best;
  }

  function lyricsProgress(session) {
    ensureLyrics(session);
    var total = session.lyrics.words.length;
    var used = placedWordIds(session);
    var placed = 0;
    var skipped = 0;
    session.lyrics.words.forEach(function (w) {
      if (used[w.id]) placed += 1;
      else if (w.skipped) skipped += 1;
    });
    return { total: total, placed: placed, skipped: skipped, remaining: total - placed - skipped };
  }


  /*
   * v0.2.11 fix5: tap-to-mark line anchors. While the song plays the user taps at the start of each lyric
   * line, in order. A tap belongs to the next line after the last tapped or skipped line. Taps are stored in
   * session.line_taps as {line_id, t_ms, raw_ms} (t_ms = raw tap time + latency correction, audio time) or
   * {line_id, skipped: true}. The aligner treats tapped line starts as hard anchors; other lines align as usual.
   */
  var TAP_LATENCY_DEFAULT_MS = -120;
  function tapLines(session) {
    var words = (session.lyrics && session.lyrics.words) || [];
    var placeable = {};
    words.forEach(function (w) { if (!w.skipped) placeable[w.line_id] = true; });
    return ((session.lyrics && session.lyrics.lines) || []).filter(function (l) { return l.kind === "lyric" && placeable[l.id]; });
  }
  function lineTaps(session) {
    if (!Array.isArray(session.line_taps)) session.line_taps = [];
    return session.line_taps;
  }
  function nextTapLine(session) {
    var lines = tapLines(session), taps = lineTaps(session);
    if (!taps.length) return lines[0] || null;
    var last = taps[taps.length - 1].line_id, i;
    for (i = 0; i < lines.length; i += 1) if (lines[i].id === last) return lines[i + 1] || null;
    return null;
  }
  function addLineTap(session, rawMs, latencyMs) {
    var line = nextTapLine(session);
    if (!line || !isFiniteNumber(rawMs)) return null;
    var lat = isFiniteNumber(latencyMs) ? Math.max(-1000, Math.min(1000, latencyMs)) : TAP_LATENCY_DEFAULT_MS;
    var t = Math.max(0, Math.round(rawMs + lat));
    var taps = lineTaps(session), i;
    for (i = taps.length - 1; i >= 0; i -= 1) if (!taps[i].skipped) { if (t <= taps[i].t_ms) t = taps[i].t_ms + 1; break; }
    var tap = { line_id: line.id, t_ms: t, raw_ms: Math.round(rawMs) };
    taps.push(tap);
    return tap;
  }
  function skipLineTap(session) {
    var line = nextTapLine(session);
    if (!line) return null;
    var tap = { line_id: line.id, skipped: true };
    lineTaps(session).push(tap);
    return tap;
  }
  function undoLineTap(session) { return lineTaps(session).pop() || null; }
  function clearLineTaps(session) { var n = lineTaps(session).length; session.line_taps = []; return n; }
  /** First word id of each tapped line -> tapped start (ms). */
  function lineTapStarts(session) {
    var out = {}, first = {};
    ((session.lyrics && session.lyrics.words) || []).forEach(function (w) { if (!w.skipped && !first[w.line_id]) first[w.line_id] = w.id; });
    lineTaps(session).forEach(function (t) { if (!t.skipped && first[t.line_id] && isFiniteNumber(t.t_ms)) out[first[t.line_id]] = t.t_ms; });
    return out;
  }

  var api = {
    MAX_LYRICS_CHARS: MAX_LYRICS_CHARS,
    MAX_WORDS: MAX_WORDS,
    MAX_ANCHORS: MAX_ANCHORS,
    emptyLyrics: emptyLyrics,
    parseLyrics: parseLyrics,
    cleanLyricsText: cleanLyricsText,
    placeableTokens: placeableTokens,
    setLyrics: setLyrics,
    setPlaceParentheses: setPlaceParentheses,
    nextWord: nextWord,
    nextLine: nextLine,
    placeNextWord: placeNextWord,
    placeNextLine: placeNextLine,
    skipNextWord: skipNextWord,
    unskipWord: unskipWord,
    undoLastAnchor: undoLastAnchor,
    moveAnchor: moveAnchor,
    clearAnchors: clearAnchors,
    assignStrokeToWord: assignStrokeToWord,
    unassignStroke: unassignStroke,
    anchorForWord: anchorForWord,
    setHarmonyOnAnchor: setHarmonyOnAnchor,
    setHarmonyOnWord: setHarmonyOnWord,
    setHarmonyOnLine: setHarmonyOnLine,
    setHarmonyRange: setHarmonyRange,
    lineHasHarmony: lineHasHarmony,
    rangeHasHarmony: rangeHasHarmony,
    harmonyCue: harmonyCue,
    defaultPerformerIdentity: defaultPerformerIdentity,
    wordById: wordById,
    lineById: lineById,
    placedWordIds: placedWordIds,
    anchorHitTest: anchorHitTest,
    lyricsProgress: lyricsProgress,
    TAP_LATENCY_DEFAULT_MS: TAP_LATENCY_DEFAULT_MS, tapLines: tapLines, lineTaps: lineTaps, nextTapLine: nextTapLine, addLineTap: addLineTap,
    skipLineTap: skipLineTap, undoLineTap: undoLineTap, clearLineTaps: clearLineTaps, lineTapStarts: lineTapStarts
  };

  root.SongShape = root.SongShape || {};
  Object.keys(api).forEach(function (k) { root.SongShape[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) {
    var base = require("./strokes.js");
    Object.keys(api).forEach(function (k) { base[k] = api[k]; });
    module.exports = base;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
