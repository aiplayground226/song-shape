/**
 * Song Shape v0.2.8 — shared AI chain helpers (browser + CLI).
 *
 *  - AI context: SONG_SHAPE_AI_CONTEXT.md is placed in the system prompt of
 *    EVERY AI request (sendAiChat calls withAiContext). Users may override it.
 *  - Stage 2: chunked AI trace drafting from placed word/line timings,
 *    syllable counts (word text only with opt-in) and the measured pitch grid,
 *    then stitching the chunks into one trace.
 *  - Stage 1-4 review: confirm AI strokes; unconfirmed ones are flagged or
 *    excluded in the performance map.
 *  - Stage 4: one send-and-check path for the tagged lyric sheet, used by the
 *    app's Send button, the guided panel and the CLI (ai-sheet, batch).
 *
 * Nothing here opens a connection by itself; requests go through the
 * injected send function / SongShape.sendAiChat, which keeps the safety rules.
 */
(function (root) {
  "use strict";

  function S() { return root.SongShape || {}; }
  var AI_TAG = "ai_drafted_trace";
  var REVIEW_TAG = "needs_review";
  var CONFIRMED_TAG = "ai_confirmed";
  var MAX_CONTEXT_CHARS = 64000;
  var MAX_CHUNKS = 300;

  function finite(v) { return typeof v === "number" && Number.isFinite(v); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function r2(v) { return Math.round(v * 100) / 100; }

  // ------------------------------------------------------------ AI context
  var contextOverride = null; // {text, label}

  function cleanContext(text) {
    if (typeof text !== "string") throw new Error("The AI context must be text.");
    var t = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    if (!t.trim()) throw new Error("The AI context file is empty.");
    if (t.length > MAX_CONTEXT_CHARS) throw new Error("The AI context file is larger than " + MAX_CONTEXT_CHARS + " characters.");
    return t;
  }
  function setAiContextOverride(text, label) {
    contextOverride = { text: cleanContext(text), label: String(label || "custom context").slice(0, 200) };
    return getAiContextInfo();
  }
  function clearAiContextOverride() { contextOverride = null; return getAiContextInfo(); }
  function getAiContext() {
    return contextOverride ? contextOverride.text : (S().AI_CONTEXT_DEFAULT_TEXT || "");
  }
  function getAiContextInfo() {
    var text = getAiContext();
    var m = /context_version:\s*([^\s]+)/.exec(text);
    return {
      source: contextOverride ? "override" : "default",
      label: contextOverride ? contextOverride.label : "SONG_SHAPE_AI_CONTEXT.md",
      version: m ? m[1] : null,
      chars: text.length
    };
  }
  /** Put the context at the start of the system prompt (idempotent). */
  function withAiContext(messages) {
    var ctx = getAiContext();
    if (!ctx || !Array.isArray(messages)) return messages;
    var out = messages.map(function (m) { return Object.assign({}, m); }); // v0.2.11: keep tool_call fields
    if (out.length && out[0].role === "system") {
      if (out[0].content.indexOf(ctx) !== 0) out[0].content = ctx + "\n\n---\nTASK\n" + out[0].content;
    } else {
      out.unshift({ role: "system", content: ctx });
    }
    return out;
  }

  // ------------------------------------------------------------ AI stroke review
  function tagsOf(s) { return (s && s.annotations) || []; }
  function isAiStroke(s) { return tagsOf(s).indexOf(AI_TAG) >= 0; }
  function isUnconfirmedAiStroke(s) { return isAiStroke(s) && tagsOf(s).indexOf(CONFIRMED_TAG) < 0; }
  function confirmStroke(s) {
    if (!isAiStroke(s)) return false;
    var changed = isUnconfirmedAiStroke(s);
    s.annotations = tagsOf(s).filter(function (t) { return t !== REVIEW_TAG; });
    if (s.annotations.indexOf(CONFIRMED_TAG) < 0) s.annotations.push(CONFIRMED_TAG);
    return changed;
  }
  function confirmAiStroke(session, id) {
    var s = ((session && session.strokes) || []).find(function (x) { return x.id === id; });
    if (!s) throw new Error("No stroke with id " + id + ".");
    if (!isAiStroke(s)) throw new Error("Stroke " + id + " is not an AI-drafted stroke.");
    return confirmStroke(s);
  }
  function confirmAllAiStrokes(session) {
    var n = 0;
    ((session && session.strokes) || []).forEach(function (s) { if (confirmStroke(s)) n += 1; });
    return n;
  }
  function countUnconfirmedAi(session) {
    return ((session && session.strokes) || []).filter(isUnconfirmedAiStroke).length;
  }

  // ------------------------------------------------------------ Stage 2 chunks
  function syllablesOf(text) {
    var fn = S().syllables;
    return typeof fn === "function" ? fn(text) : Math.max(1, (String(text).match(/[aeiouy]+/gi) || []).length);
  }

  function lineWindows(session, durationMs) {
    var lyrics = (session && session.lyrics) || {};
    var words = lyrics.words || [];
    var anchors = (session && session.anchors) || [];
    var wins = [];
    (lyrics.lines || []).forEach(function (line) {
      if (line.kind !== "lyric") return;
      var list = anchors.filter(function (a) { return a.line_id === line.id && finite(a.start_ms); })
        .sort(function (a, b) { return a.start_ms - b.start_ms; });
      if (!list.length) return;
      var ws = list.map(function (a) {
        var w = words.find(function (x) { return x.id === a.word_id; });
        var text = w ? w.text : "";
        return { t: Math.round(a.start_ms), syl: syllablesOf(text), text: text, review: !!a.needs_review };
      });
      var lastEnd = Math.max.apply(null, list.map(function (a) { return finite(a.end_ms) ? a.end_ms : a.start_ms; }));
      wins.push({ line_id: line.id, start_ms: Math.round(list[0].start_ms), last_ms: Math.round(lastEnd), words: ws,
        word_count: (line.word_ids || []).length, placed: ws.length });
    });
    wins.sort(function (a, b) { return a.start_ms - b.start_ms; });
    wins.forEach(function (w, i) {
      var next = wins[i + 1];
      var tail = Math.min(durationMs, w.last_ms + 4000);
      w.end_ms = Math.round(next ? Math.max(w.last_ms + 50, next.start_ms) : Math.max(w.last_ms + 50, tail));
      w.end_ms = Math.min(w.end_ms, durationMs);
      if (w.end_ms <= w.start_ms) w.end_ms = Math.min(durationMs, w.start_ms + 500);
    });
    return wins.filter(function (w) { return w.end_ms > w.start_ms; });
  }

  function gridFor(draftStrokes, start, end, framesPerChunk) {
    var span = end - start;
    var step = Math.max(50, Math.ceil(span / framesPerChunk / 10) * 10);
    var frames = [];
    var sample = S().sampleStrokesAt;
    for (var t = 0; t <= span; t += step) {
      var y = sample(draftStrokes, start + t);
      frames.push([t, y == null ? null : r2(clamp(y, -1, 1))]);
    }
    return { step_ms: step, frames: frames, duration_ms: span };
  }

  /**
   * Split a song into AI drafting chunks. With placed words: consecutive lyric
   * lines grouped up to chunkMs. Without: fixed windows. Grids are relative to
   * the chunk start (0 = window start).
   */
  function buildDraftChunks(session, draft, durationMs, opts) {
    opts = opts || {};
    var dur = finite(durationMs) && durationMs > 0 ? durationMs : 0;
    var chunkMs = opts.chunkMs || 12000;
    var fpc = opts.framesPerChunk || 48;
    var strokes = (draft && draft.strokes) || [];
    if (!dur) strokes.forEach(function (s) { dur = Math.max(dur, s.end_ms || 0); });
    var wins = lineWindows(session, dur);
    var chunks = [];
    if (wins.length) {
      var cur = null;
      wins.forEach(function (w) {
        if (cur && (w.end_ms - cur.start_ms) <= chunkMs) { cur.end_ms = w.end_ms; cur.lines.push(w); }
        else { cur = { start_ms: w.start_ms, end_ms: w.end_ms, lines: [w] }; chunks.push(cur); }
      });
    } else {
      for (var t = 0; t < dur; t += chunkMs) chunks.push({ start_ms: t, end_ms: Math.min(dur, t + chunkMs), lines: [] });
    }
    return chunks.slice(0, MAX_CHUNKS).map(function (c, i) {
      var g = gridFor(strokes, c.start_ms, c.end_ms, fpc);
      return { index: i, start_ms: c.start_ms, end_ms: c.end_ms, lines: c.lines, features: g,
        voiced_ratio: g.frames.length ? r2(g.frames.filter(function (f) { return f[1] !== null; }).length / g.frames.length) : 0 };
    });
  }

  /** Example chunks (pitch grid + the listener's own hand trace) from a finished project. */
  function exampleChunksFromSession(session, max) {
    var hand = S().humanStrokes(session);
    if (!hand.length || !session.draft || !session.draft.strokes || !session.draft.strokes.length) return [];
    var dur = (session.audio && session.audio.duration_ms) || 0;
    var chunks = buildDraftChunks(session, session.draft, dur, {});
    var sample = S().sampleStrokesAt;
    return chunks.map(function (c) {
      var trace = c.features.frames.map(function (f) {
        var y = sample(hand, c.start_ms + f[0]);
        return [f[0], y == null ? null : r2(clamp(y, -1, 1))];
      });
      return { start_ms: c.start_ms, features: c.features, trace: trace, lines: c.lines };
    }).filter(function (c) { return c.trace.some(function (f) { return f[1] !== null; }); }).slice(0, max || 3);
  }

  function gridText(frames) {
    return frames.map(function (f) { return f[0] + ":" + (f[1] === null ? "-" : f[1]); }).join(" ");
  }
  function lineText(w, start, includeText) {
    var onsets = w.words.map(function (x) {
      return (x.t - start) + (includeText && x.text ? ' "' + String(x.text).replace(/["\\\n]/g, "") + '"' : "") + "(" + x.syl + ")";
    }).join(" ");
    var syl = w.words.reduce(function (a, x) { return a + x.syl; }, 0);
    return "- line " + w.line_id.replace("line-", "") + ": " + (w.start_ms - start) + "-" + (w.end_ms - start) + " ms, " +
      w.placed + " placed word(s), " + syl + " syllable(s); word onsets ms(syllables): " + onsets;
  }

  var CHUNK_TASK = [
    "Task: draft the listener's hand trace for ONE window of the song.",
    "All times in this request and in your reply are milliseconds from the start of the window (0 = window start).",
    "Reply with JSON only: {\"strokes\":[{\"start_ms\":0,\"end_ms\":1800,\"points\":[[0,-0.3],[600,0.1],[1800,0.4]]}]}.",
    "Keep points inside the window, in time order, y between -1 and 1. Lift the pen (start a new stroke) where the pitch grid shows '-' for two or more frames.",
    "Words are sung near their onsets: shape each line's rises and falls around those onsets and the measured contour."
  ].join(" ");

  function buildChunkMessages(chunk, examples, opts) {
    opts = opts || {};
    var includeText = !!opts.includeWordText;
    var parts = [];
    var exChunks = [];
    (examples || []).forEach(function (e) { (e.chunks || []).forEach(function (c) { exChunks.push(c); }); });
    exChunks = exChunks.slice(0, opts.maxExampleChunks == null ? 2 : opts.maxExampleChunks);
    if (exChunks.length) {
      parts.push("Examples from this listener (window-relative times):");
      exChunks.forEach(function (c, i) {
        parts.push("Example " + (i + 1) + " (" + c.features.duration_ms + " ms, grid " + c.features.step_ms + " ms):");
        (c.lines || []).forEach(function (w) { parts.push(lineText(w, c.start_ms || 0, false).replace(/^- /, "  ")); });
        parts.push("  pitch: " + gridText(c.features.frames));
        parts.push("  listener trace: " + gridText(c.trace));
      });
    } else if ((examples || []).length) {
      parts.push("The listener's example projects have no line-level data; draft from the evidence below.");
    } else {
      parts.push("No examples: draft from the evidence below.");
    }
    var span = chunk.end_ms - chunk.start_ms;
    parts.push("Window " + (chunk.index + 1) + ": " + span + " ms long (song " + chunk.start_ms + "-" + chunk.end_ms + " ms), grid " +
      chunk.features.step_ms + " ms, voiced " + Math.round(chunk.voiced_ratio * 100) + "%.");
    if (chunk.lines.length) {
      parts.push("Lyric lines in this window" + (includeText ? "" : " (word text withheld)") + ":");
      chunk.lines.forEach(function (w) { parts.push(lineText(w, chunk.start_ms, includeText)); });
    } else {
      parts.push("No placed words in this window.");
    }
    parts.push("Measured pitch contour: " + gridText(chunk.features.frames));
    parts.push("Return the JSON object only.");
    return [{ role: "system", content: CHUNK_TASK }, { role: "user", content: parts.join("\n") }];
  }

  /** Validate one chunk reply. Accepts window-relative (asked) or absolute song times. */
  function gridStep(chunk) {
    var f = chunk && chunk.features && chunk.features.frames;
    var step = f && f.length > 1 ? f[1][0] - f[0][0] : 0;
    return step > 0 ? step : 100;
  }
  /** Linear resample of a time-sorted point list at `step` ms, keeping the original points. */
  function densify(pts, step) {
    if (pts.length < 2 || !(step > 0)) return pts;
    var out = [];
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      out.push(a);
      var n = Math.floor((b[0] - a[0]) / step);
      for (var k = 1; k <= n && out.length < 4000; k++) {
        var t = a[0] + k * step;
        if (t >= b[0]) break;
        out.push([Math.round(t), r2(a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]))]);
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function parseChunkReply(text, chunk) {
    var SS = S();
    var obj;
    try { obj = SS.parseTraceJson(text); } catch (e) { throw new Error("Could not read the model reply as JSON: " + e.message); }
    var list = Array.isArray(obj) ? obj : (obj && (obj.strokes || obj.trace || obj.traces));
    if (!Array.isArray(list)) throw new Error("The model reply had no \"strokes\" list.");
    var span = chunk.end_ms - chunk.start_ms;
    var raw = [];
    list.slice(0, 200).forEach(function (s) {
      var pts = Array.isArray(s) ? s : (s && s.points);
      if (!Array.isArray(pts)) return;
      var clean = [];
      pts.slice(0, 2000).forEach(function (p) {
        var t = Number(Array.isArray(p) ? p[0] : p && (p.t_ms != null ? p.t_ms : p.t));
        var y = Number(Array.isArray(p) ? p[1] : p && p.y);
        if (finite(t) && finite(y)) clean.push([t, clamp(y, -1, 1)]);
      });
      if (clean.length) raw.push(clean);
    });
    var all = [].concat.apply([], raw);
    if (!all.length) throw new Error("The model reply had no usable points.");
    var minT = Math.min.apply(null, all.map(function (p) { return p[0]; }));
    var maxT = Math.max.apply(null, all.map(function (p) { return p[0]; }));
    var absolute = chunk.start_ms > span && minT >= chunk.start_ms - 50 && maxT <= chunk.end_ms + 50;
    var ranges = SS.silentRanges(chunk.features, 2);
    var out = [];
    raw.forEach(function (pts) {
      var rel = pts.map(function (p) { return [Math.round(absolute ? p[0] - chunk.start_ms : p[0]), r2(p[1])]; })
        .filter(function (p) { return p[0] >= 0 && p[0] <= span; })
        .sort(function (a, b) { return a[0] - b[0]; });
      var dedup = [];
      rel.forEach(function (p) { if (!dedup.length || p[0] > dedup[dedup.length - 1][0]) dedup.push(p); });
      // Small models often reply with a few coarse points that land inside silences.
      // Resample onto the window grid first so splitting at silences keeps the voiced shape.
      SS.splitAtSilence(densify(dedup, gridStep(chunk)), ranges).forEach(function (piece) {
        if (piece.length >= 2) out.push(piece.map(function (p) { return [p[0] + chunk.start_ms, p[1]]; }));
      });
    });
    if (!out.length) throw new Error("The model reply had no usable strokes inside the window.");
    return { strokes: out, time_base: absolute ? "absolute" : "window" };
  }

  /** Join chunk strokes: sort, trim overlaps, drop strokes with < 2 points. */
  function stitchStrokes(pointLists) {
    var sorted = pointLists.filter(function (p) { return p && p.length; }).sort(function (a, b) { return a[0][0] - b[0][0]; });
    var out = [];
    sorted.forEach(function (pts) {
      var prevEnd = out.length ? out[out.length - 1].end_ms : -1;
      var kept = pts.filter(function (p) { return p[0] > prevEnd; });
      if (kept.length < 2) return;
      out.push({ start_ms: kept[0][0], end_ms: kept[kept.length - 1][0], points: kept });
    });
    return out;
  }

  /**
   * Run the chunked stage-2 draft. opts.send(messages) must return a Promise of
   * the reply text (the caller routes it through sendAiChat). Sequential; one
   * retry per chunk; failed chunks are reported, not fatal unless all fail.
   */
  function runChunkedTraceDraft(session, draft, durationMs, examples, opts) {
    opts = opts || {};
    var chunks = buildDraftChunks(session, draft, durationMs, opts);
    if (!chunks.length) return Promise.reject(new Error("Nothing to draft: the song has no duration."));
    var pieces = [], failed = [], timeBases = {};
    var retries = opts.retries == null ? 1 : opts.retries;
    var i = 0;
    function attempt(chunk, left) {
      var messages = buildChunkMessages(chunk, examples, opts);
      return Promise.resolve(opts.send(messages, chunk)).then(function (text) {
        var parsed = parseChunkReply(text, chunk);
        timeBases[parsed.time_base] = (timeBases[parsed.time_base] || 0) + 1;
        parsed.strokes.forEach(function (p) { pieces.push(p); });
      }).catch(function (err) {
        if (opts.isFatal && opts.isFatal(err)) throw err;
        if (left > 0) return attempt(chunk, left - 1);
        failed.push({ index: chunk.index, start_ms: chunk.start_ms, end_ms: chunk.end_ms, error: String(err && err.message || err).slice(0, 300) });
      });
    }
    function next() {
      if (i >= chunks.length) return Promise.resolve();
      var c = chunks[i++];
      if (opts.onProgress) opts.onProgress(i, chunks.length, c);
      return attempt(c, retries).then(next);
    }
    return next().then(function () {
      var strokes = stitchStrokes(pieces);
      if (!strokes.length) {
        throw new Error("The AI draft failed for every window" + (failed.length ? ": " + failed[0].error : "."));
      }
      return { strokes: strokes, chunks: chunks.length, failed: failed, time_bases: timeBases,
        used_word_timing: chunks.some(function (c) { return c.lines.length; }), word_text_sent: !!opts.includeWordText };
    });
  }

  // ------------------------------------------------------------ Stage 4 sheet
  var SHEET_TASK = [
    "Task: write the final tagged lyric sheet for a song generator from the Song Shape handoff in the user message.",
    "Return exactly three blocks in this order: [Tagged lyrics], [Style prompt], [Uncertainties].",
    "[Tagged lyrics] must contain every line of the new lyrics, unchanged and in order, with the section tags kept,",
    "one [Global Vocal Direction: ...] line at the top (copy the handoff's text in full) and at most one short [Delivery: ...] tag before a lyric line.",
    "Section tags such as [Verse] stay on their own line; never merge them into the [Delivery: ...] tag.",
    "Use the Song Shape delivery vocabulary and start from each line's cpu_tags; lines with the same contour get the same tags (a repeated chorus repeats its tags); change tags only where the contour differs.",
    "When the handoff lists sections, keep each section's tag and its [Vocal style: ...] line right under it, as given; new sections keep the style they inherit."
  ].join(" ");

  function buildSheetMessages(handoffPrompt) {
    return [{ role: "system", content: SHEET_TASK }, { role: "user", content: String(handoffPrompt || "") }];
  }

  function normLine(s) { return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
  /** Which new-lyric lines are missing from the model's sheet (a warning, not a rejection). */
  function checkSheetAgainstLyrics(text, newLyrics) {
    if (S().cleanLyricInput) newLyrics = S().cleanLyricInput(String(newLyrics || "")).text;
    var have = String(text || "").split(/\n/).map(normLine);
    var haveAll = " " + have.join(" ") + " ";
    var lines = String(newLyrics || "").split(/\n/).map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !/^\[.*\]$/.test(l); });
    var missing = lines.filter(function (l) { var n = normLine(l); return n && have.indexOf(n) < 0 && haveAll.indexOf(" " + n + " ") < 0; });
    var blocks = ["[Tagged lyrics]", "[Style prompt]", "[Uncertainties]"].filter(function (b) {
      return String(text || "").toLowerCase().indexOf(b.toLowerCase().replace(/[\[\]]/g, "")) < 0;
    });
    var raw = String(text || "");
    var warnings = [];
    if (!/\[Global Vocal Direction:/i.test(raw)) warnings.push("no [Global Vocal Direction: ...] tag");
    if (/^\s*\[[^\]:]+:\s*Delivery:/im.test(raw)) warnings.push("section and [Delivery: ...] merged into one tag; Song Shape puts them on separate lines");
    var inline = raw.split(/\n/).filter(function (l) { return /^\s*\[Delivery:[^\]]*\]\s*\S/i.test(l); }).length;
    if (inline) warnings.push(inline + " [Delivery: ...] tag(s) share a line with lyrics; Song Shape puts each tag on its own line");
    var tooMany = (raw.match(/\[Delivery:[^\]]*\]/gi) || []).filter(function (t) { return t.split(";").length > 8; }).length;
    if (tooMany) warnings.push(tooMany + " [Delivery: ...] tag(s) with more than 8 cues");
    return { ok: !missing.length, missing_lines: missing, missing_blocks: blocks, lyric_lines: lines.length, format_warnings: warnings };
  }

  /**
   * The single send-and-check path for stage 4. send(messages) -> Promise<text>.
   * Resolves {text, check}; rejects on transport errors or a rejected reply.
   */
  function sendAndCheckSheet(handoffPrompt, newLyrics, send) {
    var SS = S();
    var messages = buildSheetMessages(handoffPrompt);
    return Promise.resolve(send(messages)).then(function (reply) {
      var checked = SS.validateAiSheet(reply);
      if (!checked.ok) throw new Error("The model's reply was rejected: " + checked.error);
      return { text: checked.text, check: checkSheetAgainstLyrics(checked.text, newLyrics) };
    });
  }

  /** Promise wrapper around sendAiChat (context is added inside sendAiChat). */
  function sendAiChatAsync(messages, opts) {
    return new Promise(function (resolve, reject) {
      // v0.2.11: with opts.tools the reply is {text, tool_calls} (OpenAI-compatible tool calling).
      S().sendAiChat(messages, function (err, text, extra) { if (err) reject(err); else resolve(opts && opts.tools ? { text: text, tool_calls: extra && extra.tool_calls } : text); }, opts);
    });
  }

  var api = {
    AI_CONFIRMED_TAG: CONFIRMED_TAG,
    setAiContextOverride: setAiContextOverride,
    clearAiContextOverride: clearAiContextOverride,
    getAiContext: getAiContext,
    getAiContextInfo: getAiContextInfo,
    withAiContext: withAiContext,
    isAiStroke: isAiStroke,
    isUnconfirmedAiStroke: isUnconfirmedAiStroke,
    confirmAiStroke: confirmAiStroke,
    confirmAllAiStrokes: confirmAllAiStrokes,
    countUnconfirmedAi: countUnconfirmedAi,
    lineWindows: lineWindows,
    buildDraftChunks: buildDraftChunks,
    exampleChunksFromSession: exampleChunksFromSession,
    buildChunkMessages: buildChunkMessages,
    parseChunkReply: parseChunkReply,
    stitchStrokes: stitchStrokes,
    runChunkedTraceDraft: runChunkedTraceDraft,
    SHEET_TASK: SHEET_TASK,
    CHUNK_TASK: CHUNK_TASK,
    buildSheetMessages: buildSheetMessages,
    checkSheetAgainstLyrics: checkSheetAgainstLyrics,
    sendAndCheckSheet: sendAndCheckSheet,
    sendAiChatAsync: sendAiChatAsync
  };

  root.SongShape = root.SongShape || {};
  Object.keys(api).forEach(function (k) { root.SongShape[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) {
    var base;
    try { base = require("./ai-learn.js"); require("./ai-context.js"); } catch (e) { base = root.SongShape; }
    Object.keys(api).forEach(function (k) { base[k] = api[k]; });
    module.exports = base;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
