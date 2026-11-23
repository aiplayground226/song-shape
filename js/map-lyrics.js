/**
 * Song Shape v0.2 — "Map my lyrics" (headline workflow).
 *
 * Inputs:
 *   1. A reference trace with original lyrics pinned to the performance
 *      (public song X sung by artist Y — the user pasted and anchored those words).
 *   2. The user's NEW lyrics, in a second box.
 *
 * Outputs:
 *   (a) A ready-to-paste AI request. It includes a summary of the reference
 *       performance and asks the model to map the new lyrics into a Suno-style
 *       sheet and to suggest a style prompt that DESCRIBES THE SOUND and
 *       does not name the artist.
 *   (b) A rule-based, no-AI mapping: new sections/lines are aligned to
 *       reference phrases by count/length, peaks, drops, and gaps.
 *   (c) If an AI connection is enabled, the same request can be sent and
 *       the returned text is validated before it is shown (never executed).
 */
(function (root) {
  "use strict";

  var SS = root.SongShape || {};

  function sanitizePlain(text, maxLen) {
    var s = text == null ? "" : String(text);
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
    if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
    return s;
  }

  function splitNewLyrics(text, opts) {
    var cleaned = SS.cleanLyricsText ? SS.cleanLyricsText(text) : sanitizePlain(text, 100000);
    var tokenOpts = { placeParentheses: !!(opts && opts.placeParentheses) };
    var raw = cleaned.split("\n");
    var sections = [];
    var current = { tag: null, lines: [] };
    function flush() {
      if (current.tag || current.lines.length) {
        sections.push(current);
        current = { tag: null, lines: [] };
      }
    }
    var i;
    for (i = 0; i < raw.length; i += 1) {
      var line = raw[i];
      if (/^\s*\[[^\]\n]+\]\s*$/.test(line)) {
        flush();
        current = { tag: line.trim(), lines: [] };
      } else if (/^\s*$/.test(line)) {
        flush();
      } else {
        current.lines.push({
          text: line.replace(/\s+$/, ""),
          wordCount: (SS.placeableTokens ? SS.placeableTokens(line, tokenOpts) : line.trim().split(/\s+/).filter(Boolean)).length,
          charCount: line.trim().length
        });
      }
    }
    flush();
    if (!sections.length) {
      sections.push({ tag: null, lines: [] });
    }
    return { text: cleaned, sections: sections };
  }

  function referencePhrases(session) {
    var strokes = (session && session.strokes) || [];
    var phrases = [];
    var i;
    for (i = 0; i < strokes.length; i += 1) {
      var s = strokes[i];
      var words = [];
      var phraseAnchors = [];
      (session.anchors || []).forEach(function (a) {
        var tied = a.stroke_id === s.id || (a.stroke_ids && a.stroke_ids.indexOf(s.id) >= 0);
        if (!tied && a.start_ms >= s.start_ms && a.start_ms <= s.end_ms) tied = true;
        if (!tied) return;
        phraseAnchors.push(a);
        var w = SS.wordById ? SS.wordById(session, a.word_id) : null;
        if (w) words.push({ text: w.text, start_ms: a.start_ms, end_ms: a.end_ms, harmony: !!a.harmony });
      });
      words.sort(function (a, b) { return a.start_ms - b.start_ms; });
      var dir = SS.describeDirection ? SS.describeDirection(s) : "held";
      var heights = SS.strokeHeights ? SS.strokeHeights(s) : { start: 0, peak: 0, end: 0 };
      var gap = null;
      (session.gaps || []).forEach(function (g) {
        if (g.start_ms === s.end_ms) gap = g;
      });
      phrases.push({
        index: i,
        stroke_id: s.id,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        duration_ms: s.end_ms - s.start_ms,
        direction: dir,
        heights: heights,
        section: SS.strokeSectionLabel ? SS.strokeSectionLabel(session, s) : (s.section || null),
        words: words,
        anchors: phraseAnchors,
        wordCount: words.length,
        text: words.map(function (w) { return w.text; }).join(" "),
        gapAfterMs: gap ? gap.duration_ms : 0
      });
    }
    return phrases;
  }

  function cuesFromPhrase(phrase) {
    var cues = [];
    var honor = [];
    var h = phrase.heights || {};
    var dir = phrase.direction;
    if (h.start <= -0.2 && (dir === "up" || dir === "up, then down")) cues.push("start softly");
    if (dir === "up" || dir === "up, then down") {
      cues.push("rise");
      honor.push("[Rising pitch]");
    }
    if (dir === "held") cues.push("hold");
    if (dir === "down") {
      cues.push("plunge");
      honor.push("[Pitch drop]");
    }
    if (dir === "down, then up") cues.push("step down");
    if (dir === "up, then down") honor.push("[Pitch drop]");
    if (phrase.gapAfterMs >= 250) cues.push("break here");
    return { cues: cues, honor: honor };
  }

  /**
   * Align new lyric lines to reference phrases by count and length.
   * If counts differ, lines are distributed proportionally by word count
   * (and character count as a tie-breaker).
   */
  function alignLinesToPhrases(newSections, phrases) {
    var newLines = [];
    newSections.forEach(function (sec, si) {
      sec.lines.forEach(function (line, li) {
        newLines.push({
          sectionIndex: si,
          tag: sec.tag,
          isFirstInSection: li === 0,
          text: line.text,
          wordCount: line.wordCount,
          charCount: line.charCount
        });
      });
    });
    if (!newLines.length) return [];
    if (!phrases.length) {
      return newLines.map(function (line) {
        return { line: line, phrase: null, cues: [], honor: [] };
      });
    }
    var totalNew = 0;
    var totalRef = 0;
    newLines.forEach(function (l) { totalNew += Math.max(1, l.wordCount); });
    phrases.forEach(function (p) { totalRef += Math.max(1, p.wordCount || 1); });
    var assignments = [];
    var pIndex = 0;
    var consumedRef = 0;
    var consumedNew = 0;
    var i;
    for (i = 0; i < newLines.length; i += 1) {
      var line = newLines[i];
      var target = ((consumedNew + Math.max(1, line.wordCount) / 2) / totalNew) * totalRef;
      while (pIndex < phrases.length - 1 && consumedRef + Math.max(1, phrases[pIndex].wordCount || 1) < target) {
        consumedRef += Math.max(1, phrases[pIndex].wordCount || 1);
        pIndex += 1;
      }
      var phrase = phrases[pIndex];
      var cues = cuesFromPhrase(phrase);
      assignments.push({ line: line, phrase: phrase, cues: cues.cues, honor: cues.honor });
      consumedNew += Math.max(1, line.wordCount);
    }
    return assignments;
  }

  function phraseHasHarmony(session, phrase) {
    if (!phrase) return false;
    var i;
    for (i = 0; i < (phrase.anchors || []).length; i += 1) {
      if (phrase.anchors[i].harmony) return true;
    }
    if (SS.rangeHasHarmony && phrase.start_ms != null && phrase.end_ms != null) {
      return SS.rangeHasHarmony(session, phrase.start_ms, phrase.end_ms);
    }
    return false;
  }

  function buildMappedSheet(session, newLyricsText, opts) {
    opts = opts || {};
    var parsed = splitNewLyrics(newLyricsText, {
      placeParentheses: opts.placeParentheses != null ? !!opts.placeParentheses : !!(session && session.place_parentheses)
    });
    var phrases = referencePhrases(session);
    var aligned = alignLinesToPhrases(parsed.sections, phrases);
    var out = [];
    if (SS.globalVocalDirectionLine) out.push(SS.globalVocalDirectionLine(session));
    else if (session && session.performer && session.performer.identity) {
      out.push("[Global Vocal Direction: " + String(session.performer.identity).replace(/\s+/g, " ").trim() + "]");
    }
    out.push("");
    var lastSectionKey = null;
    var lastHonor = {};
    aligned.forEach(function (row) {
      var sectionLabel = row.line.tag || (row.phrase && row.phrase.section ? "[" + row.phrase.section + "]" : null);
      if (row.line.isFirstInSection && sectionLabel && sectionLabel !== lastSectionKey) {
        out.push(sectionLabel);
        lastSectionKey = sectionLabel;
      }
      row.honor.forEach(function (tag) {
        if (!lastHonor[tag + sectionLabel]) {
          out.push(tag);
          lastHonor[tag + sectionLabel] = true;
        }
      });
      row.cues.forEach(function (cue) {
        if (cue !== "rise" && cue !== "plunge") out.push("(" + cue + ")");
      });
      if (phraseHasHarmony(session, row.phrase) && SS.harmonyCue) {
        out.push(SS.harmonyCue(session));
      }
      // Always keep the new lyric line intact. Descent cues describe the
      // line; they must not split it into loose words.
      out.push(row.line.text);
      if (row.cues.indexOf("break here") >= 0) out.push("");
    });
    var text = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "");
    return {
      text: text,
      stylePrompt: buildStylePrompt(session, phrases, opts),
      assignments: aligned,
      phrases: phrases
    };
  }

  function describeReferenceSound(phrases) {
    if (!phrases.length) {
      return "a vocal performance whose delivery shape is not yet traced";
    }
    var starts = phrases.map(function (p) { return p.heights.start; });
    var peaks = phrases.map(function (p) { return p.heights.peak; });
    var durs = phrases.map(function (p) { return p.duration_ms; });
    var gaps = phrases.map(function (p) { return p.gapAfterMs; });
    function avg(arr) {
      return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : 0;
    }
    var parts = [];
    var startAvg = avg(starts);
    if (startAvg < -0.15) parts.push("often starts on a softer, lower delivery");
    else if (startAvg > 0.2) parts.push("often starts already lifted above the baseline");
    else parts.push("often starts near a steady mid-range baseline");
    var peakAvg = avg(peaks);
    if (peakAvg > 0.55) parts.push("rises to clear peaks");
    var downs = phrases.filter(function (p) { return p.direction === "down" || p.direction === "up, then down"; }).length;
    if (downs >= Math.max(1, phrases.length / 3)) parts.push("lets phrases fall or plunge after a rise");
    var holds = phrases.filter(function (p) { return p.direction === "held"; }).length;
    if (holds >= Math.max(1, phrases.length / 3)) parts.push("holds some lines fairly level");
    var meanDur = avg(durs);
    if (meanDur >= 2500) parts.push("gives words a measured, unhurried pace");
    else if (meanDur && meanDur < 900) parts.push("moves quickly from phrase to phrase");
    var longGaps = gaps.filter(function (g) { return g >= 400; }).length;
    if (longGaps >= 1) parts.push("leaves audible breaks between some phrases");
    else parts.push("tends to connect phrases tightly");
    return parts.join("; ");
  }

  /**
   * A style-prompt TEMPLATE. It describes the sound of the reference
   * performance and tells the reader not to name the artist.
   */
  function buildStylePrompt(session, phrases, opts) {
    opts = opts || {};
    var sound = describeReferenceSound(phrases || referencePhrases(session));
    var lines = [];
    lines.push("Style prompt template (describe the sound; do not name the artist):");
    lines.push("");
    lines.push(
      "A vocal performance that " + sound +
      ". Keep the words intelligible. Follow the tagged dynamics and pauses in the lyric sheet. " +
      "Do not name a specific artist or recording in the style prompt."
    );
    if (opts.extra) {
      lines.push("");
      lines.push(String(opts.extra));
    }
    return lines.join("\n");
  }

  function summarizeReference(session, opts) {
    opts = opts || {};
    var phrases = referencePhrases(session);
    var lines = [];
    var title = sanitizePlain(opts.title || (session.reference && session.reference.title) || "", 200);
    var artist = sanitizePlain(opts.artist || (session.reference && session.reference.artist) || "", 200);
    if (title || artist) {
      lines.push("Reference: public song" + (title ? " “" + title + "”" : "") + (artist ? " sung by " + artist : "") + ".");
    } else {
      lines.push("Reference: a public song the listener traced and anchored (title and artist not filled in).");
    }
    lines.push("This is a manual Song Shape trace of perceived vocal delivery relative to that singer's baseline, with the original lyrics pinned to the performance. Height is not measured pitch.");
    lines.push("");
    if (!phrases.length) {
      lines.push("No strokes have been recorded yet.");
    }
    phrases.forEach(function (p, i) {
      var label = p.section ? " [" + p.section + "]" : "";
      var wordBit = p.text ? " Words: “" + p.text + "”." : " (no words pinned on this phrase yet).";
      var gapBit = p.gapAfterMs >= 250 ? " Gap after: " + p.gapAfterMs + " ms." : "";
      lines.push(
        "Phrase " + (i + 1) + label + ": " +
        (p.start_ms / 1000).toFixed(2) + "–" + (p.end_ms / 1000).toFixed(2) + " s, " +
        "direction " + p.direction +
        ", start y=" + p.heights.start.toFixed(2) +
        ", peak y=" + p.heights.peak.toFixed(2) +
        ", end y=" + p.heights.end.toFixed(2) +
        "." + wordBit + gapBit
      );
    });
    return lines.join("\n");
  }

  /**
   * Ready-to-paste AI request. Never includes audio or an API key.
   * Instructs the model to describe the sound and not name the artist
   * in the style prompt.
   */
  function buildMapRequest(session, newLyricsText, opts) {
    opts = opts || {};
    var title = sanitizePlain(opts.title || (session.reference && session.reference.title) || "", 200);
    var artist = sanitizePlain(opts.artist || (session.reference && session.reference.artist) || "", 200);
    var songBit = title ? "public song “" + title + "”" : "a public song";
    var artistBit = artist ? " sung by " + artist : "";
    var lines = [];
    lines.push("Here is an example of " + songBit + artistBit + ".");
    lines.push("");
    lines.push(summarizeReference(session, { title: title, artist: artist }));
    lines.push("");
    lines.push("These are my lyrics:");
    lines.push("");
    lines.push(sanitizePlain(newLyricsText, 100000).trim() || "(no new lyrics pasted yet)");
    lines.push("");
    lines.push("Map my lyrics into a performance a Suno-style generator can use. Keep my words. Preserve my line breaks. Add short section tags and short delivery cues (such as start softly, rise, hold, break here, plunge, step down) that follow the example performance's rises, holds, drops, and gaps.");
    lines.push("");
    lines.push("The reference trace maps the lead singer only. Keep one consistent lead throughout. Do not imply a vocalist swap, duet, or choir handoff. If a reference phrase was marked as harmony with the lead, write a short backing-harmony cue under that same lead; otherwise leave the line as solo lead. Do not repeat the lead identity on every line — write it once as a global vocal direction.");
    lines.push("");
    lines.push("Also suggest a style prompt that gets a sound like this recording. Describe the sound (voice, arrangement, energy, dynamics). Do not name the artist.");
    return lines.join("\n");
  }

  var api = {
    splitNewLyrics: splitNewLyrics,
    referencePhrases: referencePhrases,
    alignLinesToPhrases: alignLinesToPhrases,
    cuesFromPhrase: cuesFromPhrase,
    buildMappedSheet: buildMappedSheet,
    buildStylePrompt: buildStylePrompt,
    summarizeReference: summarizeReference,
    buildMapRequest: buildMapRequest,
    describeReferenceSound: describeReferenceSound
  };

  root.SongShape = root.SongShape || {};
  Object.keys(api).forEach(function (k) { root.SongShape[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) {
    var base;
    try { base = require("./sheet.js"); } catch (e) { base = root.SongShape; }
    Object.keys(api).forEach(function (k) { base[k] = api[k]; });
    module.exports = base;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
