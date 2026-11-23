/**
 * Song Shape v0.2.11 — client for the OPTIONAL local helper (tools/helper/songshape_helper.py).
 * The helper runs on the user's own machine at http://127.0.0.1:<port>, needs the token it
 * prints at start-up, and runs only the separator/aligner commands the user put in its config.
 * Nothing here talks to any other host. Audio goes only to that loopback helper, only on click.
 */
(function (root) {
  "use strict";
  var SS = root.SongShape || {};
  function helperUrl(base, path) {
    var u = String(base || "").trim().replace(/\/+$/, "");
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(u)) throw new Error("The helper address must be http://127.0.0.1:<port> on this computer.");
    return u + path;
  }
  function helperFetch(cfg, path, init) {
    if (!cfg || !cfg.token) return Promise.reject(new Error("Paste the helper token (printed when the helper starts)."));
    init = Object.assign({ method: "GET", redirect: "error" }, init || {});
    init.headers = Object.assign({ "X-SongShape-Token": cfg.token }, init.headers || {});
    var url;
    try { url = helperUrl(cfg.baseUrl, path); } catch (e) { return Promise.reject(e); }
    return fetch(url, init).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error("Helper " + path + " returned HTTP " + res.status + (t ? ": " + t.slice(0, 200) : "")); });
      return res;
    });
  }
  function helperHealth(cfg) { return helperFetch(cfg, "/health").then(function (r) { return r.json(); }); }
  /** Send the open song's bytes; resolves with {bytes: ArrayBuffer (WAV vocals), audioId}. */
  function helperSeparate(cfg, bytes, name) {
    return helperFetch(cfg, "/separate", { method: "POST", body: bytes, headers: { "Content-Type": "application/octet-stream", "X-Filename": String(name || "song").replace(/[^\w.\- ]/g, "_").slice(0, 120) } })
      .then(function (r) { var id = r.headers.get("X-Audio-Id"); return r.arrayBuffer().then(function (b) { return { bytes: b, audioId: id }; }); });
  }
  /** Upload a user-chosen stem so the aligner can use it; resolves with the audio id. */
  function helperUpload(cfg, bytes, name) {
    return helperFetch(cfg, "/upload", { method: "POST", body: bytes, headers: { "Content-Type": "application/octet-stream", "X-Filename": String(name || "stem").replace(/[^\w.\- ]/g, "_").slice(0, 120) } })
      .then(function (r) { return r.json(); }).then(function (j) { return j.audio_id; });
  }
  /** Known-lyrics alignment on a helper-held audio id; resolves with {words:[...chars]} for SS.proposeImportedAlignment. */
  function helperAlign(cfg, audioId, words) {
    return helperFetch(cfg, "/align", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_id: audioId, words: words.map(function (w) { var o = { id: w.id, text: w.text, line_id: w.line_id, pause_after: /(\.{2,}|\u2026)$/.test(String(w.text || '')) }; if (typeof w.line_start_ms === 'number' && isFinite(w.line_start_ms)) o.line_start = w.line_start_ms / 1000; return o; }) }) }).then(function (r) { return r.json(); });
  }
  var api = { helperUrl: helperUrl, helperHealth: helperHealth, helperSeparate: helperSeparate, helperUpload: helperUpload, helperAlign: helperAlign };
  if (typeof module !== "undefined" && module.exports) module.exports = Object.assign(SS, api);
  root.SongShape = Object.assign(SS, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
