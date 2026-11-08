"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanLog, failureExcerpt } = require("./ci-logs");
const { fakeGitHub } = require("./fake-github");

test("cleanLog drops timestamps, colours and group markers and keeps the tail", () => {
  const raw = [
    "2026-11-08T10:00:00.1234567Z ##[group]Run pnpm lint",
    "2026-11-08T10:00:01.0000000Z \u001b[31merror\u001b[0m  'x' is unused",
    "2026-11-08T10:00:02.0000000Z ##[endgroup]",
    "2026-11-08T10:00:03.0000000Z ##[error]Process completed with exit code 1.",
    "",
  ].join("\r\n");
  assert.equal(cleanLog(raw), "error  'x' is unused\n##[error]Process completed with exit code 1.");
  assert.equal(cleanLog("a\nb\nc", 2), "b\nc");
});

test("failureExcerpt has a section per failed job", async () => {
  const github = fakeGitHub({
    jobs: {
      7: [
        { id: 1, name: "Code Quality / Lint & Typecheck", conclusion: "failure", steps: [{ name: "Run Lint", conclusion: "failure" }] },
        { id: 2, name: "Build", conclusion: "skipped", steps: [] },
        { id: 3, name: "Other", conclusion: "failure", steps: [] },
      ],
    },
    logs: { 1: "2026-11-08T10:00:00Z lint failed\n```\nnot a fence" },
  });
  const excerpt = await failureExcerpt({ github, owner: "o", repo: "r", runId: 7 });
  assert.match(excerpt, /## Code Quality \/ Lint & Typecheck\nFailed steps: Run Lint\n\n````text\nlint failed/);
  assert.match(excerpt, /## Other\n\n````text\n\(log not available\)/);
  assert.doesNotMatch(excerpt, /## Build/);
});

test("failureExcerpt is null when nothing failed", async () => {
  const github = fakeGitHub({ jobs: { 7: [{ id: 1, name: "A", conclusion: "success" }] } });
  assert.equal(await failureExcerpt({ github, owner: "o", repo: "r", runId: 7 }), null);
});
