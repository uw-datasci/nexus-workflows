"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { olderActiveRuns, waitForTurn, workflowFileFromRef, parseWorkflowList } = require("./queue");
const { fakeGitHub } = require("./fake-github");

const run = (id, status = "in_progress") => ({ id, status, html_url: `https://github.test/runs/${id}` });
const ask = (github, extra = {}) => ({ github, owner: "o", repo: "r", workflows: ["fix.yml", "claude.yml"], runId: 50, ...extra });

test("reads the workflow file from GITHUB_WORKFLOW_REF", () => {
  assert.equal(workflowFileFromRef("uw-datasci/cxc/.github/workflows/feedback.yml@refs/heads/main"), "feedback.yml");
  assert.equal(workflowFileFromRef(""), null);
  assert.deepEqual(parseWorkflowList(" claude.yml, .github/workflows/other.yml\nthird.yml "), ["claude.yml", "other.yml", "third.yml"]);
});

test("only older, unfinished runs of the queue workflows block", async () => {
  const github = fakeGitHub({
    runs: {
      "fix.yml": [run(60), run(50), run(40, "completed"), run(30, "queued")],
      "claude.yml": [run(45, "waiting"), run(10, "completed")],
    },
  });
  const older = await olderActiveRuns(ask(github));
  assert.deepEqual(older.map((r) => r.id), [30, 45]);
});

test("a queue workflow that doesn't exist yet is ignored", async () => {
  const github = fakeGitHub({ runs: { "fix.yml": [run(50)] } });
  assert.deepEqual(await olderActiveRuns(ask(github)), []);
});

test("waits until earlier runs finish", async () => {
  const runs = { "fix.yml": [run(50), run(30)] };
  const github = fakeGitHub({ runs });
  let clock = 0;
  let polls = 0;
  const result = await waitForTurn({
    ...ask(github),
    timeoutMs: 10 * 60_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      polls += 1;
      if (polls === 2) runs["fix.yml"][1].status = "completed";
    },
  });
  assert.equal(result.ready, true);
  assert.equal(polls, 2);
  assert.equal(result.waitedMs, 60_000);
});

test("gives up after the timeout", async () => {
  const github = fakeGitHub({ runs: { "fix.yml": [run(50), run(30)] } });
  let clock = 0;
  const result = await waitForTurn({
    ...ask(github),
    timeoutMs: 90_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blocking.map((r) => r.id), [30]);
});
