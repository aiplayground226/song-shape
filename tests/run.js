#!/usr/bin/env node
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");
const tests = ["test_strokes.js", "test_v02.js", "test_v024.js", "test_v025.js", "test_v026.js", "test_v027.js", "test_v028.js", "test_v029.js"];
let failed = 0;
tests.forEach((file) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit" });
  if (r.status !== 0) failed += 1;
});
if (failed) {
  console.error("\n" + failed + " test file(s) failed");
  process.exit(1);
}
console.log("\nAll test files passed");
