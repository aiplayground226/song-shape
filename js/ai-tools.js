/**
 * Song Shape v0.2.11 — AI-first pipeline: a local tool-using model runs the steps,
 * deterministic tools do the measuring.
 *
 *   load_song -> separate_vocals -> map_vocals -> place_words -> review -> (stage 3/4 sheet)
 *
 * The model (LM Studio, Ollama, llama.cpp server or any OpenAI-compatible endpoint with
 * tool calling) only chooses and checks steps; it never invents times or pitches. Every
 * request goes through SS.sendAiChat (context + loopback rules apply). Without AI, the
 * same tools run in the fixed order (CPU fallback). The tools themselves are supplied by
 * the page (or a test), so this file has no DOM or network code of its own.
 */
(function (root) {
  "use strict";
  var SS = root.SongShape || {};
  var PIPELINE_ORDER = ["load_song", "separate_vocals", "map_vocals", "place_words", "review"];
  var TOOL_SPECS = [
    { name: "load_song", description: "Report which song audio is open (name, duration, whether a vocal stem is loaded). No arguments.", parameters: { type: "object", properties: {}, additionalProperties: false } },
    { name: "separate_vocals", description: "Make or use the isolated lead-vocal stem. Uses a loaded stem, else the local helper's separator. Returns the stem status.", parameters: { type: "object", properties: {}, additionalProperties: false } },
    { name: "map_vocals", description: "Measure the pitch contour on the vocal stem (YIN + octave/spike cleanup + short-gap bridging). Returns stroke counts and cleanup statistics.", parameters: { type: "object", properties: {}, additionalProperties: false } },
    { name: "place_words", description: "Place the pasted lyrics: find each word's first sound (signal), then set the word start on its first vowel, or the 2nd vowel of a double vowel. Uses the local aligner when available, else the CPU estimate. Keeps hand-placed words.", parameters: { type: "object", properties: { vowel_target: { type: "boolean", description: "true = vowel rule (default)" } }, additionalProperties: false } },
    { name: "review", description: "Summarize what needs a human ear: low-confidence words, words without contour, long unvoiced gaps over words.", parameters: { type: "object", properties: {}, additionalProperties: false } }
  ];
  var SYSTEM_PROMPT = "You run Song Shape's local tools for the user. Call the tools in this order: load_song, separate_vocals, map_vocals, place_words, review. " +
    "Call one tool at a time and read its JSON result before the next call. If a result has ok=false, stop and explain the next step for the user in one or two plain sentences. " +
    "Never make up timings, pitches or lyrics; only the tools measure. When review is done, reply with a short plain summary of what the user should check by ear.";

  function openAiTools() {
    return TOOL_SPECS.map(function (t) { return { type: "function", "function": { name: t.name, description: t.description, parameters: t.parameters } }; });
  }
  function safeJson(text) { try { return JSON.parse(text || "{}"); } catch (e) { return null; } }
  function callTool(tools, name, args) {
    if (PIPELINE_ORDER.indexOf(name) < 0 || typeof tools[name] !== "function") return Promise.resolve({ ok: false, error: "Unknown tool: " + String(name).slice(0, 60) });
    return Promise.resolve().then(function () { return tools[name](args || {}); }).then(function (r) { return r || { ok: true }; }, function (e) { return { ok: false, error: String(e && e.message || e).slice(0, 400) }; });
  }

  /** CPU fallback / "Run all without AI": the same tools in fixed order. Stops at the first ok=false. */
  function runPipelineWithoutAi(tools, opts) {
    opts = opts || {};
    var log = [];
    var order = opts.order || PIPELINE_ORDER;
    function step(i) {
      if (i >= order.length) return Promise.resolve({ ok: true, log: log, driver: "cpu_fixed_order" });
      if (opts.onStep) opts.onStep(order[i], "running");
      return callTool(tools, order[i], {}).then(function (r) {
        log.push({ tool: order[i], result: r });
        if (opts.onStep) opts.onStep(order[i], r.ok === false ? "error" : "done", r);
        if (r.ok === false) return { ok: false, log: log, stoppedAt: order[i], driver: "cpu_fixed_order" };
        return step(i + 1);
      });
    }
    return step(0);
  }

  /**
   * AI driver. send(messages, opts) -> Promise<{text, tool_calls}>; the page passes a wrapper
   * around SS.sendAiChat. The model may only call the five tools; at most maxSteps turns.
   */
  function runPipelineWithAi(tools, send, opts) {
    opts = opts || {};
    var maxSteps = opts.maxSteps || 12;
    var messages = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: opts.userMessage || "Map the open song: rip the vocals, map them and place my lyrics." }];
    var log = [], called = [];
    function turn(n) {
      if (n >= maxSteps) return Promise.resolve({ ok: false, log: log, error: "The AI used too many steps; the tools that ran are kept.", driver: "ai" });
      return send(messages, { tools: openAiTools(), temperature: 0 }).then(function (reply) {
        reply = reply || {};
        var calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
        if (!calls.length) {
          var missing = PIPELINE_ORDER.filter(function (t) { return called.indexOf(t) < 0; });
          return { ok: !missing.length, log: log, summary: String(reply.text || "").slice(0, 4000), missing: missing, driver: "ai" };
        }
        messages.push({ role: "assistant", content: reply.text || "", tool_calls: calls });
        var chain = Promise.resolve();
        calls.forEach(function (c, k) {
          chain = chain.then(function () {
            var name = c["function"] && c["function"].name;
            var args = safeJson(c["function"] && c["function"].arguments);
            if (opts.onStep) opts.onStep(name, "running");
            return callTool(tools, name, args || {}).then(function (r) {
              called.push(name);
              log.push({ tool: name, args: args, result: r });
              if (opts.onStep) opts.onStep(name, r.ok === false ? "error" : "done", r);
              messages.push({ role: "tool", tool_call_id: String(c.id || ("call-" + n + "-" + k)), content: JSON.stringify(r).slice(0, 8000) });
            });
          });
        });
        return chain.then(function () { return turn(n + 1); });
      });
    }
    return turn(0);
  }

  /** Words that need an ear: a deterministic review used by the review tool. */
  function reviewWords(session, opts) {
    opts = opts || {};
    var strokes = session.strokes || [];
    var words = (session.lyrics && session.lyrics.words || []).filter(function (w) { return !w.skipped; });
    var anchors = session.anchors || [];
    var byWord = {};
    anchors.forEach(function (a) { byWord[a.word_id] = a; });
    var unplaced = words.filter(function (w) { return !byWord[w.id]; }).map(function (w) { return w.text; });
    var noContour = [], machine = 0, hand = 0;
    anchors.forEach(function (a) {
      if (a.source === "next_word") hand += 1; else machine += 1;
      var t = a.start_ms;
      if (!strokes.some(function (s) { return s.start_ms <= t + 400 && s.end_ms >= t; })) {
        var w = words.filter(function (x) { return x.id === a.word_id; })[0];
        if (w) noContour.push(w.text);
      }
    });
    return { ok: true, words: words.length, hand_placed: hand, machine_placed: machine, unplaced: unplaced.slice(0, 40),
      words_without_contour: noContour.length, examples_without_contour: noContour.slice(0, 12) };
  }

  var api = { AI_PIPELINE_ORDER: PIPELINE_ORDER, AI_TOOL_SPECS: TOOL_SPECS, AI_PIPELINE_SYSTEM_PROMPT: SYSTEM_PROMPT, aiPipelineTools: openAiTools,
    runPipelineWithoutAi: runPipelineWithoutAi, runPipelineWithAi: runPipelineWithAi, reviewWords: reviewWords };
  if (typeof module !== "undefined" && module.exports) module.exports = Object.assign(SS, api);
  root.SongShape = Object.assign(SS, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
