"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeRepo } = require("./test-git");
const { applyAndPush, makePatch, excludeAgentFiles, limitReason, botIdentity } = require("./agent-run");
const { parseConfig } = require("./config");
const { fakeGitHub } = require("./fake-github");

const config = (agent = {}) => parseConfig({ app: "cxc", lead: "lead", agent: { never_touch: ["proxy.ts"], ...agent } });
const IDENTITY = { name: "nexus-feedback[bot]", email: "1+nexus-feedback[bot]@users.noreply.github.com" };
const push = (repo, patchFile, extra = {}) =>
  applyAndPush({ cwd: repo.clone, base: "dev", branch: "feedback/1-x", patchFile, config: config(), identity: IDENTITY, pushToken: "", message: ["Title", "Body"], ...extra });

test("applyAndPush commits as the App and pushes", () => {
  const repo = makeRepo({ "a.ts": "a\n" });
  const result = push(repo, repo.patch({ "a.ts": "b\n" }));
  assert.deepEqual(result.files, ["a.ts"]);
  assert.match(result.sha, /^[0-9a-f]{40}$/);
  assert.equal(repo.show("feedback/1-x", "a.ts"), "b\n");
  assert.equal(repo.git("log", "-1", "--format=%an|%s|%b", result.sha).trim(), "nexus-feedback[bot]|Title|Body");
});

test("applyAndPush refuses a guardrail violation and an empty patch, without pushing", () => {
  const repo = makeRepo({ "a.ts": "a\n", "proxy.ts": "p\n" });
  assert.match(push(repo, repo.patch({ "proxy.ts": "changed\n" })).violations[0], /proxy\.ts/);
  const empty = path.join(repo.root, "empty.patch");
  fs.writeFileSync(empty, "");
  assert.match(push(repo, empty).error, /without changing any files/);
  assert.ok(!repo.branches().includes("feedback/1-x"));
});

test("makePatch includes new files but not excluded ones", () => {
  const repo = makeRepo({ "a.ts": "a\n" });
  const start = repo.head();
  excludeAgentFiles(repo.clone);
  repo.write({ "b.ts": "b\n", ".feedback/request.json": "{}", ".nexus-workflows/x.js": "x" });
  const patch = makePatch({ cwd: repo.clone, startSha: start, outFile: path.join(repo.root, "out", "p.patch") });
  assert.match(patch, /b\/b\.ts/);
  assert.doesNotMatch(patch, /\.feedback|\.nexus-workflows/);
  assert.equal(fs.readFileSync(path.join(repo.root, "out", "p.patch"), "utf8"), patch);
});

test("limitReason tells the turn limit from other failures", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nf-")), "out.json");
  fs.writeFileSync(file, JSON.stringify([{ type: "result", subtype: "error_max_turns" }]));
  assert.match(limitReason({ executionFile: file, maxTurns: 30 }), /30-turn limit/);
  assert.match(limitReason({ executionFile: "/missing", timeoutMinutes: 15 }), /15-minute limit/);
});

test("botIdentity uses the bot user's ID for the noreply email", async () => {
  assert.deepEqual(await botIdentity(fakeGitHub({ users: { "nexus-feedback[bot]": 42 } }), "nexus-feedback"), {
    name: "nexus-feedback[bot]",
    email: "42+nexus-feedback[bot]@users.noreply.github.com",
  });
  assert.equal((await botIdentity(fakeGitHub(), "nexus-feedback")).email, "nexus-feedback[bot]@users.noreply.github.com");
});
