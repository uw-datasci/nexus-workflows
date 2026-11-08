"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractImageUrls, gate, buildPrompt, envLabel } = require("./context");
const { fakeGitHub } = require("./fake-github");

test("extracts markdown and HTML images in order, without duplicates", () => {
  const body = [
    "The button is off:",
    "![screenshot](https://github.com/user-attachments/assets/aaa)",
    '<img width="400" alt="x" src="https://example.blob.vercel-storage.com/b.png" />',
    '![again](https://github.com/user-attachments/assets/aaa "title")',
    "![local](./not-a-url.png)",
    "[a link](https://example.com/not-an-image)",
  ].join("\n");
  assert.deepEqual(extractImageUrls(body), [
    "https://github.com/user-attachments/assets/aaa",
    "https://example.blob.vercel-storage.com/b.png",
  ]);
});

test("caps the number of screenshots", () => {
  const body = Array.from({ length: 15 }, (_, i) => `![s](https://x.test/${i}.png)`).join("\n");
  assert.equal(extractImageUrls(body).length, 10);
  assert.deepEqual(extractImageUrls(null), []);
});

test("finds the environment label", () => {
  assert.equal(envLabel({ labels: [{ name: "feedback" }, { name: "env:staging" }] }), "env:staging");
  assert.equal(envLabel({ labels: ["feedback"] }), null);
});

const ctx = (action, label) => ({ eventName: "issues", payload: { action, label: label ? { name: label } : undefined } });
const run = (github, context, retriage = false) =>
  gate({ github, context, owner: "o", repo: "r", issueNumber: 1, retriage });

test("gate: runs when the feedback label is added", async () => {
  const github = fakeGitHub({ issues: [{ number: 1, labels: ["feedback"] }] });
  assert.equal((await run(github, ctx("labeled", "feedback"))).run, true);
});

test("gate: skips opened (the labeled event covers it) and other labels", async () => {
  const github = fakeGitHub({ issues: [{ number: 1, labels: ["feedback", "env:prod"] }] });
  assert.equal((await run(github, ctx("opened"))).run, false);
  assert.equal((await run(github, ctx("labeled", "env:prod"))).run, false);
});

test("gate: skips issues that are already triaged, closed or not feedback", async () => {
  const triaged = fakeGitHub({ issues: [{ number: 1, labels: ["feedback", "route:dev"] }] });
  assert.equal((await run(triaged, ctx("labeled", "feedback"))).run, false);
  assert.equal((await run(triaged, ctx("labeled", "feedback"), true)).run, true, "retriage ignores the route label");

  const closed = fakeGitHub({ issues: [{ number: 1, labels: ["feedback"], state: "closed" }] });
  assert.equal((await run(closed, ctx("labeled", "feedback"))).run, false);

  const plain = fakeGitHub({ issues: [{ number: 1, labels: ["bug"] }] });
  assert.equal((await run(plain, { eventName: "workflow_dispatch", payload: {} })).run, false);
});

test("gate: non-issue events run for feedback issues", async () => {
  const github = fakeGitHub({ issues: [{ number: 1, labels: ["feedback"] }] });
  assert.equal((await run(github, { eventName: "workflow_dispatch", payload: {} })).run, true);
});

test("buildPrompt fills known placeholders and leaves the rest", () => {
  assert.equal(buildPrompt("{{A}} and {{B}} and {{lower}}", { A: 1 }), "1 and {{B}} and {{lower}}");
});

test("gate: adding `retriage` runs triage again, even on a triaged issue", async () => {
  const triaged = fakeGitHub({ issues: [{ number: 1, labels: ["feedback", "route:agent", "retriage"] }] });
  const result = await run(triaged, ctx("labeled", "retriage"));
  assert.equal(result.run, true);
  assert.equal(result.retriage, true);
  assert.equal((await run(triaged, ctx("unlabeled", "retriage"))).run, false);

  const closed = fakeGitHub({ issues: [{ number: 1, labels: ["feedback", "retriage"], state: "closed" }] });
  assert.equal((await run(closed, ctx("labeled", "retriage"))).run, false, "reopen it first");
});

test("collectContext writes people's comments, without the workflows' own", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { collectContext } = require("./context");
  const issue = { number: 1, title: "t", body: "", labels: [{ name: "feedback" }], user: { login: "nexus-feedback[bot]" } };
  const github = fakeGitHub({
    issues: [issue],
    issueComments: {
      1: [
        { body: "<!-- nexus-feedback-triage -->\n**Triage: needs more information.**", user: { login: "nexus-feedback[bot]" } },
        { body: "**Answer from Sam** in Discord:\n\n> the apply page", user: { login: "nexus-feedback[bot]" }, created_at: "2026-11-08T17:00:00Z" },
        { body: "<!-- nexus-feedback-fix -->\nOpened #34", user: { login: "nexus-feedback[bot]" } },
        { body: "x".repeat(3000), user: { login: "dev" } },
      ],
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-"));
  const collected = await collectContext({ github, owner: "o", repo: "r", issue, dir });
  const written = JSON.parse(fs.readFileSync(path.join(dir, "comments.json"), "utf8"));
  assert.deepEqual(written, collected.comments);
  assert.equal(written.length, 2);
  assert.deepEqual(written[0], {
    author: "nexus-feedback[bot]",
    created_at: "2026-11-08T17:00:00Z",
    body: "**Answer from Sam** in Discord:\n\n> the apply page",
  });
  assert.equal(written[1].body.length, 2000);
});
