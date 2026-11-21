/**
 * Song Shape — project links, defined ONCE here.
 * The official repository. If it ever moves, change REPO_URL below and the
 * same URL in README.md and NOTICE. These links are plain <a href> targets set
 * at load time; nothing is fetched from them.
 */
(function (root) {
  "use strict";
  var REPO_URL = "https://github.com/aiplayground226/song-shape";
  var api = {
    PROJECT_INFO: {
      REPO_URL: REPO_URL,
      ISSUES_URL: REPO_URL + "/issues",
      REPO_IS_PLACEHOLDER: false,
      LICENSE: "Apache-2.0",
      COPYRIGHT: "Copyright 2026 Ben Hayward and AI Playground LLC"
    }
  };
  root.SongShape = root.SongShape || {};
  Object.keys(api).forEach(function (k) { root.SongShape[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
