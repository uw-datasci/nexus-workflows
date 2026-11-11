"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The workflows check this repo out to `.nexus-workflows/` inside the caller's workspace, so a
// caller whose package.json says "type": "module" must not turn these scripts into ES modules.
test("scripts load with require() inside an ESM caller repo", (t) => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "esm-host-"));
  t.after(() => fs.rmSync(host, { recursive: true, force: true }));
  fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ type: "module" }));

  const scripts = path.join(host, ".nexus-workflows", "scripts");
  fs.cpSync(path.join(__dirname, ".."), scripts, { recursive: true });

  const entries = ["notify", "triage", "fix", "mention", "agent-run", "secrets"];
  const probe = entries
    .map((name) => `require(${JSON.stringify(path.join(scripts, "feedback", `${name}.js`))});`)
    .join("");
  // Run from the host repo, the way actions/github-script runs from GITHUB_WORKSPACE.
  execFileSync(process.execPath, ["-e", probe], { cwd: host, stdio: "pipe" });
  assert.ok(true);
});
