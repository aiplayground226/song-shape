/**
 * Song Shape v0.2 — optional "Connect your AI".
 * Off by default. No network call is made unless the user enables the
 * connection and explicitly sends a request.
 * OpenAI-compatible: base URL, model, API key kept only in memory /
 * sessionStorage — never in JSON, PNG, or text exports.
 * AI output is parsed and schema-checked. It is never executed.
 */
(function (root) {
  "use strict";

  var SS = root.SongShape || {};
  var STORAGE_KEY = "songshape.v02.ai";
  // v0.2.8 provider presets. Local presets need no key. API presets are remote:
  // they need the explicit remote opt-in and a key (browser: this tab only;
  // CLI: read from the named environment variable). Model ids for API
  // providers change often, so the user types the exact id from the provider.
  var PRESETS = {
    ollama: { name: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", remote: false, jsonMode: true, keyEnv: null },
    lmstudio: { name: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", remote: false, jsonMode: false, keyEnv: null },
    llamacpp: { name: "llama.cpp server (local)", baseUrl: "http://127.0.0.1:8080/v1", model: "local", remote: false, jsonMode: true, keyEnv: null },
    "openai-compatible": { name: "Other OpenAI-compatible endpoint", baseUrl: "", model: "", remote: null, jsonMode: false, keyEnv: "SONGSHAPE_API_KEY" },
    xai: { name: "xAI (Grok) API", baseUrl: "https://api.x.ai/v1", model: "", remote: true, jsonMode: true, keyEnv: "XAI_API_KEY" },
    openai: { name: "OpenAI API", baseUrl: "https://api.openai.com/v1", model: "", remote: true, jsonMode: true, keyEnv: "OPENAI_API_KEY" }
  };
  var MAX_OUTPUT_CHARS = 200000;
  var allowRemoteThisPage = false;

  var memory = {
    enabled: false,
    baseUrl: "",
    model: "",
    apiKey: ""
  };

  function secretKeys() {
    return ["api_key", "apiKey", "authorization", "token", "access_token", "secret", "password"];
  }

  function looksLikeSecretKey(key) {
    var k = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    var names = ["apikey", "authorization", "accesstoken", "secret", "password", "bearer"];
    return names.indexOf(k) >= 0 || k === "token";
  }

  function exportContainsSecrets(obj, path) {
    if (!obj || typeof obj !== "object") return false;
    var keys = Object.keys(obj);
    var i;
    for (i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (looksLikeSecretKey(key)) return true;
      if (obj[key] && typeof obj[key] === "object") {
        if (exportContainsSecrets(obj[key], (path || "") + "." + key)) return true;
      }
    }
    return false;
  }

  function loadConfig() {
    allowRemoteThisPage = false;
    var stored = null;
    try {
      if (typeof sessionStorage !== "undefined") {
        stored = sessionStorage.getItem(STORAGE_KEY);
      }
    } catch (e) {
      stored = null;
    }
    if (stored) {
      try {
        var parsed = JSON.parse(stored);
        if (parsed && typeof parsed === "object") {
          memory.enabled = false; // re-enable explicitly after page reload
          memory.baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl : "";
          memory.model = typeof parsed.model === "string" ? parsed.model : "";
          memory.apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : "";
        }
      } catch (e2) {}
    }
    return getConfig();
  }

  function persistConfig() {
    try {
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          enabled: memory.enabled,
          baseUrl: memory.baseUrl,
          model: memory.model,
          apiKey: memory.apiKey
        }));
      }
    } catch (e) {}
  }

  function getConfig() {
    return {
      enabled: !!memory.enabled,
      baseUrl: memory.baseUrl || "",
      model: memory.model || "",
      hasKey: !!(memory.apiKey && memory.apiKey.length)
    };
  }

  function setConfig(opts) {
    opts = opts || {};
    if (opts.enabled != null) memory.enabled = !!opts.enabled;
    if (opts.baseUrl != null) memory.baseUrl = String(opts.baseUrl).trim();
    if (opts.model != null) memory.model = String(opts.model).trim();
    if (opts.apiKey != null) memory.apiKey = String(opts.apiKey);
    persistConfig();
    return getConfig();
  }

  function presetModelValues() {
    return Object.keys(PRESETS).map(function (k) { return PRESETS[k].model; });
  }
  function applyPreset(name) {
    var p = PRESETS[name];
    if (!p) return null;
    memory.baseUrl = p.baseUrl;
    // Replace the model only when it is empty or still another preset's default.
    if (!memory.model || presetModelValues().indexOf(memory.model) >= 0) memory.model = p.model;
    persistConfig();
    var cfg = getConfig();
    cfg.name = p.name; cfg.remote = p.remote; cfg.jsonMode = p.jsonMode; cfg.keyEnv = p.keyEnv; cfg.preset = name;
    return cfg;
  }
  function getPreset(name) {
    var p = PRESETS[name];
    return p ? JSON.parse(JSON.stringify(p)) : null;
  }

  function setRemoteAllowed(allowed) {
    // Deliberately in memory only; never survives a page reload.
    allowRemoteThisPage = allowed === true;
    return allowRemoteThisPage;
  }

  function isLoopbackEndpoint(url) {
    var parsed;
    try { parsed = new URL(url); } catch (e) { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].indexOf(parsed.hostname.toLowerCase()) >= 0;
  }

  function isValidEndpoint(url) {
    var parsed;
    try { parsed = new URL(url); } catch (e) { return false; }
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  }

  function clearConfig() {
    memory.enabled = false;
    allowRemoteThisPage = false;
    memory.baseUrl = "";
    memory.model = "";
    memory.apiKey = "";
    try {
      if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    return getConfig();
  }

  function sanitizeAiText(text) {
    if (typeof text !== "string") {
      return { ok: false, error: "AI output must be plain text." };
    }
    if (text.length > MAX_OUTPUT_CHARS) {
      return { ok: false, error: "AI output is too large." };
    }
    var cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
    if (/<\s*script/i.test(cleaned) || /javascript\s*:/i.test(cleaned)) {
      return { ok: false, error: "AI output contained disallowed markup and was rejected." };
    }
    return { ok: true, text: cleaned };
  }

  /**
   * Validate a model-proposed draft layer. Never eval. Strict numbers only.
   */
  function validateAiDraft(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return { ok: false, error: "AI draft must be a JSON object." };
    }
    if (exportContainsSecrets(obj)) {
      return { ok: false, error: "AI draft contained secret-like keys and was rejected." };
    }
    try {
      if (!SS.parseSession) throw new Error("Parser is not loaded.");
      var candidate = {
        schema_version: "songshape-live-0.2",
        strokes: Array.isArray(obj.strokes) ? obj.strokes : [],
        gaps: Array.isArray(obj.gaps) ? obj.gaps : [],
        notes: typeof obj.notes === "string" ? obj.notes : undefined
      };
      if (obj.draft && obj.draft.strokes) candidate.draft = obj.draft;
      var session = SS.parseSession(candidate);
      return { ok: true, session: session };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : "AI draft failed validation." };
    }
  }

  function validateAiSheet(text) {
    var cleaned = sanitizeAiText(text);
    if (!cleaned.ok) return cleaned;
    return { ok: true, text: cleaned.text };
  }

  /**
   * Build a few-shot prompt from the user's corrected hand traces vs a draft.
   * Used only when the user explicitly sends a request.
   */
  function buildLearnPrompt(session, task, extra) {
    var lines = [];
    lines.push("You are helping with a Song Shape annotation. Return only the requested artifact.");
    lines.push("Hand traces are a listener's perceived delivery relative to a singer baseline, not measured pitch.");
    if (session && session.draft && session.draft.strokes && session.draft.strokes.length) {
      lines.push("Measured-pitch draft (distinct from the hand trace):");
      lines.push(JSON.stringify({
        baseline_hz: session.draft.baseline_hz,
        strokes: session.draft.strokes.map(function (s) {
          return { start_ms: s.start_ms, end_ms: s.end_ms, points: s.points };
        })
      }));
    }
    if (session && session.strokes && session.strokes.length) {
      lines.push("My corrected hand traces (learn my ear):");
      lines.push(JSON.stringify(session.strokes.map(function (s) {
        return {
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          points: s.points,
          annotations: s.annotations,
          section: s.section
        };
      })));
    }
    if (task === "draft") {
      lines.push("Refine the measured-pitch draft so it better matches my ear. Return JSON only: {\"strokes\":[...],\"gaps\":[...]} with finite numeric times and y values in [-1,1]. No commentary.");
    } else if (task === "sheet") {
      lines.push("Write a Suno-style lyric sheet from the anchored lyrics and my hand traces. Short section tags and short delivery cues. Keep my words and line breaks.");
    } else if (task === "map") {
      lines.push(extra || "");
    }
    return lines.join("\n");
  }

  function chatCompletionsUrl(baseUrl) {
    var base = String(baseUrl || "").replace(/\/+$/, "");
    if (!base) return "";
    if (/\/chat\/completions$/.test(base)) return base;
    if (/\/v1$/.test(base)) return base + "/chat/completions";
    return base + "/v1/chat/completions";
  }

  /**
   * Normalize a prompt into OpenAI-compatible chat messages:
   * [{ role: "system"|"user"|"assistant", content: "<text>" }, ...].
   * A plain string becomes a single user message. Returns null if invalid.
   */
  var CHAT_ROLES = ["system", "user", "assistant"];
  // v0.2.11: tool-calling turns (OpenAI-compatible). Only used when the caller passes opts.tools.
  function toToolChatMessages(input) {
    if (!Array.isArray(input) || !input.length) return null;
    var out = [];
    for (var i = 0; i < input.length; i += 1) {
      var m = input[i];
      if (!m || typeof m !== "object") return null;
      if (m.role === "tool") {
        if (typeof m.tool_call_id !== "string" || typeof m.content !== "string") return null;
        out.push({ role: "tool", tool_call_id: m.tool_call_id.slice(0, 200), content: m.content });
      } else if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        out.push({ role: "assistant", content: typeof m.content === "string" ? m.content : "", tool_calls: m.tool_calls.slice(0, 16).map(function (c) {
          return { id: String(c.id || "").slice(0, 200), type: "function", "function": { name: String(c["function"] && c["function"].name || "").slice(0, 80), arguments: String(c["function"] && c["function"].arguments || "{}").slice(0, 20000) } };
        }) });
      } else if (CHAT_ROLES.indexOf(m.role) >= 0 && typeof m.content === "string") {
        out.push({ role: m.role, content: m.content });
      } else return null;
    }
    return out;
  }
  function toChatMessages(input) {
    if (typeof input === "string") {
      return input.trim() ? [{ role: "user", content: input }] : null;
    }
    if (!Array.isArray(input) || !input.length) return null;
    var out = [];
    for (var i = 0; i < input.length; i += 1) {
      var m = input[i];
      if (!m || typeof m !== "object" || CHAT_ROLES.indexOf(m.role) < 0 || typeof m.content !== "string") return null;
      out.push({ role: m.role, content: m.content });
    }
    return out;
  }

  /**
   * POST to an OpenAI-compatible /chat/completions endpoint.
   * Only called when enabled === true and the user asked to send.
   * `messages` may be a prompt string or an array of {role, content}.
   */
  function sendChat(messages, done, opts) {
    opts = opts || {};
    var chatMessages = opts.tools ? toToolChatMessages(messages) : toChatMessages(messages);
    if (!chatMessages) {
      done(new Error("Nothing valid to send: the request must be text or a list of chat messages."));
      return;
    }
    // v0.2.8: every request carries the Song Shape AI context in its system prompt.
    var withContext = root.SongShape && root.SongShape.withAiContext;
    if (typeof withContext === "function") chatMessages = withContext(chatMessages);
    if (!memory.enabled) {
      done(new Error("AI connection is off. Enable it first."));
      return;
    }
    var url = chatCompletionsUrl(memory.baseUrl);
    if (!url) {
      done(new Error("Set a base URL first."));
      return;
    }
    if (!isValidEndpoint(url)) {
      done(new Error("Use a valid HTTP(S) endpoint without URL-embedded credentials."));
      return;
    }
    if (!isLoopbackEndpoint(url) && !allowRemoteThisPage) {
      done(new Error("Remote/LAN model endpoint blocked. Explicitly opt in for this page before sending."));
      return;
    }
    if (typeof fetch !== "function") {
      done(new Error("This browser cannot send the request."));
      return;
    }
    var headers = { "Content-Type": "application/json" };
    if (memory.apiKey) headers.Authorization = "Bearer " + memory.apiKey;
    var payload = {
      model: memory.model || "local-model",
      messages: chatMessages,
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.3,
      stream: false
    };
    // Optional: Ollama and llama.cpp accept {"type":"json_object"}; some servers
    // (e.g. LM Studio) reject it, so it is opt-in.
    if (opts.jsonMode) payload.response_format = { type: "json_object" };
    if (Array.isArray(opts.tools) && opts.tools.length) { payload.tools = opts.tools; payload.tool_choice = "auto"; }
    var body = JSON.stringify(payload);
    var controller = null, timer = null;
    if (opts.timeoutMs > 0 && typeof AbortController === "function") {
      controller = new AbortController();
      timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs);
    }
    var finished = false;
    var realDone = done;
    done = function (err, text, extra) {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (err && err.name === "AbortError") err = new Error("The AI request timed out after " + Math.round(opts.timeoutMs / 1000) + " s.");
      realDone(err, text, extra);
    };
    // redirect: "error" keeps the loopback/remote opt-in check meaningful:
    // a local endpoint cannot silently bounce the request elsewhere.
    var init = { method: "POST", headers: headers, body: body, redirect: "error" };
    if (controller) init.signal = controller.signal;
    fetch(url, init)
      .then(function (res) {
        return res.text().then(function (text) {
          return { ok: res.ok, status: res.status, text: text };
        });
      })
      .then(function (res) {
        if (!res.ok) {
          done(new Error("The AI endpoint returned HTTP " + res.status + "."));
          return;
        }
        var parsed;
        try { parsed = JSON.parse(res.text); } catch (e) {
          done(new Error("The AI endpoint did not return JSON."));
          return;
        }
        var message = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message;
        var content = message ? message.content : null;
        if (opts.tools && message && Array.isArray(message.tool_calls) && message.tool_calls.length) {
          var calls = message.tool_calls.slice(0, 16).filter(function (c) { return c && c["function"] && typeof c["function"].name === "string"; });
          var note = typeof content === "string" ? sanitizeAiText(content) : { ok: true, text: "" };
          done(null, note.ok ? note.text : "", { tool_calls: calls });
          return;
        }
        if (typeof content !== "string") {
          done(new Error("The AI response had no text content."));
          return;
        }
        var clean = sanitizeAiText(content);
        if (!clean.ok) {
          done(new Error(clean.error));
          return;
        }
        done(null, clean.text);
      })
      .catch(function (err) {
        done(err || new Error("The request failed. On file:// some browsers block local endpoints."));
      });
  }

  var api = {
    AI_PRESETS: PRESETS,
    getAiPreset: getPreset,
    loadAiConfig: loadConfig,
    getAiConfig: getConfig,
    setAiConfig: setConfig,
    applyAiPreset: applyPreset,
    clearAiConfig: clearConfig,
    setAiRemoteAllowed: setRemoteAllowed,
    isAiLoopbackEndpoint: isLoopbackEndpoint,
    exportContainsSecrets: exportContainsSecrets,
    validateAiDraft: validateAiDraft,
    validateAiSheet: validateAiSheet,
    sanitizeAiText: sanitizeAiText,
    buildLearnPrompt: buildLearnPrompt,
    sendAiChat: sendChat,
    toChatMessages: toChatMessages,
    secretKeyNames: secretKeys
  };

  root.SongShape = root.SongShape || {};
  Object.keys(api).forEach(function (k) { root.SongShape[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) {
    var base;
    try {
      base = require("./map-lyrics.js");
      require("./draft.js");
    } catch (e) { base = root.SongShape; }
    Object.keys(api).forEach(function (k) { base[k] = api[k]; });
    // Point the local SS alias at the composed API so Node sees parseSession
    // the same way the browser does after the classic script tags load.
    SS = base;
    root.SongShape = base;
    module.exports = base;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
