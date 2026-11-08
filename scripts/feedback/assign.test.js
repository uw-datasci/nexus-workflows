"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pickAssignee } = require("./assign");
const { parseConfig } = require("./config");
const { fakeGitHub } = require("./fake-github");

const config = (extra = {}) => parseConfig({ app: "cxc", lead: "lead", dev_team: "cxc-dev", ...extra });
const pick = (github, options) =>
  pickAssignee({ github, owner: "o", repo: "r", issueNumber: 1, config: config(), route: "dev", ...options });

const team = { "cxc-dev": ["alice", "bob", "carol"] };

test("route:agent goes to the lead", async () => {
  const result = await pick(fakeGitHub({ teams: team }), { route: "agent" });
  assert.equal(result.login, "lead");
});

test("a devs override for the area wins", async () => {
  const github = fakeGitHub({ teams: team, commits: { "app/page.tsx": [["alice", "2026-11-01T00:00:00Z"]] } });
  const result = await pick(github, {
    area: "landing",
    likelyFiles: ["app/page.tsx"],
    config: config({ devs: [{ github: "dave", areas: ["landing"] }] }),
  });
  assert.deepEqual(result, { login: "dave", reason: "owns `area:landing`" });
});

test("picks the team member who changed the likely files most recently", async () => {
  const github = fakeGitHub({
    teams: team,
    commits: {
      "app/page.tsx": [["alice", "2026-10-01T00:00:00Z"], ["outsider", "2026-11-05T00:00:00Z"]],
      "components/home/Footer.tsx": [["bob", "2026-10-20T00:00:00Z"], [null, "2026-11-06T00:00:00Z"]],
    },
  });
  const result = await pick(github, { likelyFiles: ["app/page.tsx", "components/home/Footer.tsx"] });
  assert.equal(result.login, "bob");
  assert.match(result.reason, /Footer\.tsx/);
});

test("skips anyone with 3 or more open feedback issues", async () => {
  const busy = [2, 3, 4].map((number) => ({ number, labels: ["feedback"], assignees: [{ login: "bob" }] }));
  const github = fakeGitHub({
    issues: [{ number: 1, labels: ["feedback"] }, ...busy],
    teams: team,
    commits: { "a.ts": [["bob", "2026-11-02T00:00:00Z"], ["alice", "2026-11-01T00:00:00Z"]] },
  });
  assert.equal((await pick(github, { likelyFiles: ["a.ts"] })).login, "alice");
});

test("falls back to the lead", async () => {
  const github = fakeGitHub({ teams: team, commits: { "a.ts": [["outsider", "2026-11-02T00:00:00Z"]] } });
  assert.equal((await pick(github, { likelyFiles: ["a.ts"] })).login, "lead");
  assert.equal((await pick(github, { likelyFiles: [] })).login, "lead");
  assert.equal((await pick(github, { config: config({ dev_team: "" }), likelyFiles: ["a.ts"] })).login, "lead");
  assert.equal((await pick(fakeGitHub({ teams: {} }), { likelyFiles: ["a.ts"] })).login, "lead", "unreadable team");
});
