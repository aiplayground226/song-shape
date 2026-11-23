/* Song Shape v0.2.9-v0.2.10: lyric input rules. Users paste lyrics; nothing is fetched.
   Incoming [bracket] tags and clear (parenthetical) performance cues are stripped and
   ignored. Song Shape writes its own section tags from the structure (blank lines),
   and its own delivery tags from the measured contour. No network, no dependencies. */
(function (root) {
  "use strict";

  // Words that make a parenthetical a performance cue, not sung text.
  var CUE_WORDS = [
    "whisper", "whispered", "whispering", "whispers", "spoken", "speaking", "speak", "said", "talking", "narration", "narrator",
    "soft", "softly", "softer", "quiet", "quietly", "quieter", "loud", "louder", "loudly", "shout", "shouted", "shouting", "yell", "yelled",
    "scream", "screamed", "screaming", "growl", "growled", "belt", "belted", "belting", "falsetto", "head", "voice", "chest", "vibrato",
    "echo", "echoes", "echoing", "reverb", "ad", "lib", "ad-lib", "adlib", "adlibs", "ad-libs", "harmony", "harmonies", "harmonized",
    "backing", "vocals", "vocal", "choir", "chorus", "crowd", "chant", "chanted", "chanting", "gang", "unison",
    "repeat", "repeats", "x2", "x3", "x4", "2x", "3x", "4x", "twice", "instrumental", "solo", "guitar", "piano", "drums", "beat", "drop",
    "break", "breakdown", "pause", "breath", "breathe", "breathing", "inhale", "exhale", "sigh", "sighs", "gasp", "laugh", "laughs",
    "laughing", "cry", "crying", "sob", "hum", "humming", "hummed", "fade", "fades", "fading", "out", "in", "slow", "slowly", "slower",
    "fast", "faster", "building", "build", "rising", "staccato", "legato", "sustained", "sustain", "hold", "held", "rap", "rapped",
    "sung", "singing", "male", "female", "lead", "all", "both", "together", "intro", "outro", "verse", "bridge", "hook", "pre-chorus",
    "refrain", "end", "ending", "stop", "silence", "applause", "cheering", "music", "intensity", "pitch", "higher", "lower", "high", "low"
  ];
  var LINKERS = ["and", "with", "a", "the", "very", "more", "less", "then", "to", "of", "on", "up", "down", "&", "+", "-"];
  var CUE = {}; CUE_WORDS.forEach(function (w) { CUE[w] = true; });
  var LINK = {}; LINKERS.forEach(function (w) { LINK[w] = true; });

  function tokens(s) { return String(s).toLowerCase().replace(/[^a-z0-9&+\-]+/g, " ").trim().split(/\s+/).filter(Boolean); }
  /** "cue" (strip), "ambiguous" (keep, flag) or "lyric" (keep: backing vocals / sung text). */
  function classifyParenthetical(inner) {
    var t = tokens(inner);
    if (!t.length) return "cue";
    var cue = t.filter(function (w) { return CUE[w]; }).length;
    var link = t.filter(function (w) { return LINK[w]; }).length;
    var other = t.length - cue - link;
    if (cue && !other && t.length <= 6) return "cue";
    if (cue) return "ambiguous";
    return "lyric";
  }
  // v0.2.10: a dash standing alone between spaces (-, –, —, or a run such as --) is not a word and
  // breaks word timing. Song Shape does not guess: it asks the user to remove it. Hyphenated words stay.
  var DASH_ONLY = /^[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]+$/;
  var STANDALONE_DASH_HINT = "Leave out standalone dashes (-, \u2013, \u2014): they break word timing. Hyphenated words such as well-known are fine.";
  /** Lines (1-based) that contain a standalone dash, ignoring [bracket] tags. [{line, text}] */
  function findStandaloneDashes(input) {
    var out = [];
    String(input == null ? "" : input).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").forEach(function (raw, idx) {
      var line = raw.replace(/\[[^\]]*\]/g, " ").replace(/\[[^\]]*$/, " ");
      var toks = line.split(/\s+/).filter(Boolean);
      if (toks.some(function (t) { return DASH_ONLY.test(t); })) out.push({ line: idx + 1, text: raw.trim().slice(0, 80) });
    });
    return out;
  }
  function standaloneDashError(found, label) {
    var lines = found.map(function (f) { return f.line; });
    var e = new Error((label ? label + ": " : "") + "Remove the standalone dash" + (lines.length > 1 ? "es" : "") + " on line" + (lines.length > 1 ? "s " : " ") +
      lines.slice(0, 8).join(", ") + (lines.length > 8 ? ", \u2026" : "") + " (for example: \"" + found[0].text + "\"). " + STANDALONE_DASH_HINT);
    e.code = "SONG_SHAPE_STANDALONE_DASH"; e.lines = lines;
    return e;
  }
  function normLine(s) { return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }

  /**
   * Clean pasted lyrics. Returns {text, ignored_tags, stripped_cues, ambiguous, sections}.
   * text: plain lyric lines, Song Shape section tags ([Verse] / [Chorus]) at each section start,
   * one blank line between sections. Idempotent: cleaning the output gives the same text.
   */
  function cleanLyricInput(input) {
    if (input == null) input = "";
    if (typeof input !== "string") throw new Error("Lyrics must be text.");
    if (input.length > 100000) throw new Error("Lyrics must be at most 100,000 characters.");
    var dashes = findStandaloneDashes(input);
    if (dashes.length) throw standaloneDashError(dashes);
    var src = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    var ignored = [], stripped = [], ambiguous = [];
    var blocks = [], cur = [], headers = [], pendingHeader = null, curHeader = null;
    // v0.2.11 fix6: the whole-line [tag] just before a block is kept as that block's header (for Extend marks
    // such as [New Verse]); it is never written to the output.
    function flush() { if (cur.length) { blocks.push(cur); headers.push(curHeader); } cur = []; curHeader = null; }
    src.split("\n").forEach(function (raw, idx) {
      var line = raw;
      var wholeTag = /^\s*\[[^\]]*\]\s*$/.test(line);
      line = line.replace(/\[[^\]]*\]/g, function (m) { ignored.push(m.slice(0, 120)); return " "; });
      // An unclosed "[" starts an ignored tag to the end of the line.
      line = line.replace(/\[[^\]]*$/, function (m) { ignored.push(m.slice(0, 120)); return " "; });
      line = line.replace(/\(([^()]*)\)/g, function (m, inner) {
        var kind = classifyParenthetical(inner);
        if (kind === "cue") { stripped.push(m.slice(0, 120)); return " "; }
        if (kind === "ambiguous") ambiguous.push({ line: idx + 1, text: m.slice(0, 120) });
        return m;
      });
      line = line.replace(/\s+/g, " ").trim();
      if (wholeTag || !line) { if (wholeTag || !raw.trim()) flush(); if (wholeTag) pendingHeader = raw.trim().slice(0, 120); return; }
      if (!cur.length) { curHeader = pendingHeader; pendingHeader = null; }
      cur.push(line);
    });
    flush();
    // Section names come from structure only: a block that repeats elsewhere is the chorus.
    // v0.2.11: "repeats" ignores punctuation, ellipses and sung hyphens ("ho-nor" = "honor") and line breaks
    // inside the block; a block also counts when at least half of its lines appear in another block.
    var loose = function (l) { return normLine(String(l).replace(/(\w)-(\w)/g, "$1$2").replace(/(.)\1{2,}/g, "$1$1")).replace(/\s+/g, " ").trim(); };
    var keys = blocks.map(function (b) { return b.map(normLine).join("\n"); });
    var joined = blocks.map(function (b) { return b.map(loose).join(" "); });
    var lineSets = blocks.map(function (b) { return b.map(loose); });
    var count = {}; keys.forEach(function (k) { count[k] = (count[k] || 0) + 1; });
    function repeats(i) {
      if (count[keys[i]] > 1) return true;
      for (var j = 0; j < blocks.length; j += 1) {
        if (j === i) continue;
        if (joined[i] && joined[i] === joined[j]) return true;
        var shared = lineSets[i].filter(function (l) { return l && lineSets[j].indexOf(l) >= 0; }).length;
        if (lineSets[i].length >= 2 && shared * 2 >= lineSets[i].length) return true;
      }
      return false;
    }
    var sections = blocks.map(function (b, i) {
      var rep = repeats(i);
      return { name: rep ? "Chorus" : "Verse", lines: b.length, repeat_key: rep ? keys[i] : null, header: headers[i] || null, texts: b.slice() };
    });
    var out = [];
    blocks.forEach(function (b, i) {
      if (i) out.push("");
      out.push("[" + sections[i].name + "]");
      b.forEach(function (l) { out.push(l); });
    });
    return { text: out.join("\n"), ignored_tags: ignored, stripped_cues: stripped, ambiguous: ambiguous, sections: sections };
  }

  /** One short sentence for status lines and logs. */
  function lyricInputNote(res) {
    if (!res) return "";
    var parts = [];
    if (res.ignored_tags.length) parts.push(res.ignored_tags.length + " [bracket] tag(s) ignored");
    if (res.stripped_cues.length) parts.push(res.stripped_cues.length + " (performance cue)(s) ignored");
    if (res.ambiguous.length) parts.push(res.ambiguous.length + " unclear (parenthetical)(s) kept as sung text — check: " +
      res.ambiguous.slice(0, 3).map(function (a) { return a.text; }).join(" "));
    return parts.length ? parts.join("; ") + ". Song Shape writes its own tags." : "";
  }

  var api = {
    LYRIC_INPUT_RULES: "Paste plain lyric lines. Blank line between sections. [Bracket] tags and (performance cues) are ignored; Song Shape writes its own tags. Leave out standalone dashes (-, \u2013, \u2014). Lyrics are never fetched from the internet.",
    STANDALONE_DASH_HINT: STANDALONE_DASH_HINT,
    findStandaloneDashes: findStandaloneDashes,
    classifyParenthetical: classifyParenthetical,
    cleanLyricInput: cleanLyricInput,
    lyricInputNote: lyricInputNote
  };
  root.SongShape = Object.assign(root.SongShape || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
