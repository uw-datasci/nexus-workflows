"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The agent runs the app's lint and typecheck from the workspace root. With the feedback scripts
// still in .nexus-workflows/, an app whose lint checks every file reports errors in them.
for (const [file, agentStep] of [
  ["feedback-fix.yml", "Fix agent"],
  ["claude-mention.yml", "Claude"],
]) {
  test(`${file}: the scripts are out of the workspace while the agent runs`, () => {
    const yaml = fs.readFileSync(path.join(__dirname, "../../.github/workflows", file), "utf8");
    const steps = [...yaml.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1].trim());
    const agent = steps.indexOf(agentStep);
    assert.ok(agent > 0, `no "${agentStep}" step`);
    assert.equal(steps[agent - 1], "Move feedback scripts out of the workspace");
    assert.equal(steps[agent + 1], "Put feedback scripts back");

    const restore = yaml.slice(yaml.indexOf("- name: Put feedback scripts back"));
    assert.match(restore.split("- name:")[1], /if: always\(\)/);
  });
}
