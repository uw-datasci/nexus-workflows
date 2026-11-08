"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeRepo } = require("./test-git");
const {
  MENTION,
  MENTION_MARKER,
  MENTION_SCHEMA,
  commentFrom,
  isAllowedBot,
  gateMention,
  mentionOutcome,
  renderReply,
  resetRetries,
  publishMention,
  acknowledge,
} = require("./mention");
const { retriesFrom } = require("./fix");
const { parseConfig } = require("./config");
const { fakeGitHub } = require("./fake-github");

const config = (agent = {}) =>
  parseConfig({ app: "cxc", lead: "lead", agent: { never_touch: ["proxy.ts", "lib/auth/**"], max_files: 3, ...agent } });

const person = (login = "alice") => ({ login, type: "User" });
const appBot = { login: "nexus-feedback[bot]", type: "Bot" };
const FEEDBACK_PR = { number: 5, state: "open", head: { ref: "feedback/1-footer", sha: "s", repo: { full_name: "o/r" } }, base: { ref: "dev" } };

const issueComment = (body, user = person(), extra = {}) => ({
  eventName: "issue_comment",
  payload: { action: "created", issue: { number: 5, pull_request: {} }, comment: { id: 11, body, user, html_url: "https://github.test/c/11" }, ...extra },
});
const reviewComment = (body, user = person()) => ({
  eventName: "pull_request_review_comment",
  payload: {
    action: "created",
    pull_request: { number: 5 },
    comment: { id: 12, body, user, path: "components/footer.ts", line: 3, diff_hunk: "@@ -1 +1 @@", html_url: "https://github.test/c/12" },
  },
});
const review = (body, user = person()) => ({
  eventName: "pull_request_review",
  payload: { action: "submitted", pull_request: { number: 5 }, review: { id: 13, body, user, html_url: "https://github.test/r/13" } },
});

const github = (extra = {}) =>
  fakeGitHub({ pulls: [FEEDBACK_PR], permissions: { alice: "write", rob: "read", admin: "admin" }, ...extra });
const gate = (gh, context, cfg = config()) =>
  gateMention({ github: gh, context, owner: "o", repo: "r", getConfig: () => cfg, allowedBots: "nexus-feedback[bot]" });

// ─── Gate ────────────────────────────────────────────────────────────────────

test("@claude has to be a whole word, and our own replies never count", () => {
  for (const text of ["@claude fix it", "Hey @Claude, please", "(@claude)", "thanks\n@claude: also"]) assert.match(text, MENTION, text);
  for (const text of ["@claude-bot fix", "x@claude", "@claudette", "@​claude"]) assert.doesNotMatch(text, MENTION, text);
});

test("a write user's @claude on a feedback PR runs, from all three events", async () => {
  for (const context of [issueComment("@claude make the year bold"), reviewComment("@claude use a constant"), review("@claude tidy this up")]) {
    const result = await gate(github(), context);
    assert.equal(result.mode, "run", context.eventName);
    assert.equal(result.prNumber, 5);
    assert.equal(result.branch, "feedback/1-footer");
    assert.equal(result.base, "dev");
    assert.equal(result.issueNumber, 1);
  }
  assert.equal((await gate(github(), issueComment("@claude go", person("admin")))).mode, "run");
});

test("comments that don't count are skipped", async () => {
  const cases = [
    [issueComment("looks good"), /doesn't mention/],
    [issueComment(`@claude ${MENTION_MARKER}`), /own reply/],
    [issueComment("@claude go", person("rob")), /doesn't have write access/],
    [issueComment("@claude go", person("stranger")), /isn't a collaborator/],
    [issueComment("@claude go", { login: "dependabot[bot]", type: "Bot" }), /allowed-bots/],
    [review(""), /doesn't mention/],
    [{ ...issueComment("@claude go"), payload: { ...issueComment("@claude go").payload, issue: { number: 5 } } }, /isn't a new comment on a PR/],
    [{ ...issueComment("@claude go"), payload: { ...issueComment("@claude go").payload, action: "edited" } }, /isn't a new comment/],
  ];
  for (const [context, reason] of cases) {
    const result = await gate(github(), context);
    assert.equal(result.mode, "skip");
    assert.match(result.reason, reason);
  }
});

test("the nexus-feedback App's comment runs", async () => {
  assert.equal((await gate(github(), issueComment("Still not right. @claude the year is still 2025", appBot))).mode, "run");
  assert.equal(isAllowedBot("Nexus-Feedback", "nexus-feedback[bot]"), true);
  assert.equal(isAllowedBot("other[bot]", "*"), true);
  assert.equal(isAllowedBot("other[bot]", ""), false);
});

test("only open, same-repo feedback PRs", async () => {
  const cases = [
    [{ ...FEEDBACK_PR, head: { ...FEEDBACK_PR.head, ref: "feature/x" } }, /isn't a feedback branch/],
    [{ ...FEEDBACK_PR, state: "closed" }, /isn't open/],
    [{ ...FEEDBACK_PR, head: { ...FEEDBACK_PR.head, repo: { full_name: "fork/r" } } }, /fork/],
  ];
  for (const [pr, reason] of cases) {
    const result = await gate(github({ pulls: [pr] }), issueComment("@claude go"));
    assert.equal(result.mode, "skip");
    assert.match(result.reason, reason);
  }
});

test("agent.enabled: false only replies", async () => {
  const result = await gate(github(), issueComment("@claude go"), config({ enabled: false }));
  assert.equal(result.mode, "refuse");
  assert.match(result.reason, /turned off/);
});

test("the review comment carries its file and line", () => {
  const comment = commentFrom(reviewComment("@claude rename"));
  assert.deepEqual([comment.kind, comment.path, comment.line, comment.diffHunk], ["review_comment", "components/footer.ts", 3, "@@ -1 +1 @@"]);
});

// ─── Outcome and reply ───────────────────────────────────────────────────────

test("the schema can be passed inside single quotes", () => {
  assert.doesNotMatch(JSON.stringify(MENTION_SCHEMA), /'/);
});

test("mentionOutcome decides whether to push", () => {
  const verdict = (status) => JSON.stringify({ status, changes: [], reply: "ok" });
  assert.deepEqual(
    [mentionOutcome({ outcome: "success", structuredOutput: verdict("changed"), hasPatch: true }).push, mentionOutcome({ outcome: "success", structuredOutput: verdict("no_change"), hasPatch: false }).push],
    [true, false]
  );
  assert.equal(mentionOutcome({ outcome: "success", structuredOutput: verdict("gave_up"), hasPatch: true }).push, false);
  assert.match(mentionOutcome({ outcome: "success", structuredOutput: verdict("changed"), hasPatch: false }).problem, /nothing changed/);
  assert.match(mentionOutcome({ outcome: "failure", executionFile: "/missing", timeoutMinutes: 15 }).problem, /15-minute/);
});

test("replies can't ping anyone or start another run", () => {
  const body = renderReply({
    comment: commentFrom(issueComment("@claude go")),
    verdict: { status: "changed", changes: ["Bold year"], reply: "Done, @claude and @lead <!-- hide -->" },
    pushed: { sha: "abcdef1234567890" },
    repoUrl: "https://github.com/o/r",
    runUrl: "https://github.test/run",
  });
  assert.doesNotMatch(body, MENTION);
  assert.doesNotMatch(body, /@lead/);
  assert.match(body, /\*\*Pushed\*\* \[`abcdef1`\]\(https:\/\/github\.com\/o\/r\/commit\/abcdef1234567890\):\n- Bold year/);
  assert.match(body, /Re: \[this comment\]\(https:\/\/github\.test\/c\/11\)/);
  assert.ok(body.endsWith(MENTION_MARKER));
  assert.equal(body.split("<!--").length, 2, "only the marker comment");
});

test("resetRetries puts the fix workflow's retry back to 0", () => {
  assert.equal(retriesFrom(resetRetries("x\n<!-- nexus-feedback-fix retries=1 -->")), 0);
  assert.equal(resetRetries("no marker"), "no marker");
});

// ─── Publishing ──────────────────────────────────────────────────────────────

const IDENTITY = { name: "nexus-feedback[bot]", email: "1+nexus-feedback[bot]@users.noreply.github.com" };

function onFeedbackBranch() {
  const repo = makeRepo({ "components/footer.ts": "2025\n", "proxy.ts": "p\n", "a.ts": "a\n" });
  repo.git("checkout", "--quiet", "-b", "feedback/1-footer");
  repo.write({ "components/footer.ts": "2026\n" });
  repo.git("commit", "--quiet", "-am", "first fix");
  repo.git("push", "--quiet", "origin", "feedback/1-footer");
  return repo;
}

const publishWith = (gh, repo, extra = {}) =>
  publishMention({
    github: gh,
    owner: "o",
    repo: "r",
    cwd: repo.clone,
    plan: { prNumber: 5, base: "dev", branch: "feedback/1-footer" },
    comment: commentFrom(issueComment("@claude make it bold")),
    mode: "run",
    verdict: { status: "changed", changes: ["Bold year"], reply: "Made the year bold." },
    push: true,
    config: config(),
    identity: IDENTITY,
    pushToken: "",
    runUrl: "https://github.test/run",
    ...extra,
  });

test("a requested change is pushed onto the PR branch and the reply says so", async () => {
  const repo = onFeedbackBranch();
  const patchFile = repo.patch({ "components/footer.ts": "**2026**\n" });
  const gh = github({ pulls: [{ ...FEEDBACK_PR, body: "text\n<!-- nexus-feedback-fix retries=1 -->" }] });

  const result = await publishWith(gh, repo, { patchFile });

  assert.equal(repo.show("feedback/1-footer", "components/footer.ts"), "**2026**\n");
  assert.equal(repo.git("ls-remote", "origin", "feedback/1-footer").split("\t")[0], result.pushed.sha);
  assert.equal(retriesFrom(gh.prs[0].body), 0, "the retry budget is reset");
  const [reply] = gh.comments.get(5);
  assert.match(reply.body, /Made the year bold\.\n\n\*\*Pushed\*\*/);
});

test("a change that breaks the rules is not pushed, and the reply lists why", async () => {
  const repo = onFeedbackBranch();
  const before = repo.git("ls-remote", "origin", "feedback/1-footer");
  const patchFile = repo.patch({ "proxy.ts": "changed\n" });
  const gh = github();

  const result = await publishWith(gh, repo, { patchFile });

  assert.equal(result.pushed, null);
  assert.equal(repo.git("ls-remote", "origin", "feedback/1-footer"), before);
  assert.match(gh.comments.get(5)[0].body, /\*\*Nothing was pushed\*\*, because the change breaks the agent's rules:\n- `proxy\.ts` matches `never_touch`/);
});

test("max_files counts the files the branch already changes", async () => {
  const repo = onFeedbackBranch();
  const patchFile = repo.patch({ "a.ts": "b\n", "b.ts": "b\n", "c.ts": "c\n" });
  const gh = github();
  const result = await publishWith(gh, repo, { patchFile });
  assert.match(result.violations[0], /4 files, more than `max_files` \(3\)/);
});

test("review comments get an in-thread reply; problems and refusals still get one", async () => {
  const repo = onFeedbackBranch();
  let gh = github();
  await publishWith(gh, repo, {
    comment: commentFrom(reviewComment("@claude rename")),
    push: false,
    problem: "the agent hit its 30-turn limit",
    verdict: null,
  });
  assert.equal(gh.replies.length, 1);
  assert.equal(gh.replies[0].comment_id, 12);
  assert.match(gh.replies[0].body, /\*\*Nothing was pushed:\*\* the agent hit its 30-turn limit/);

  gh = github();
  await publishWith(gh, repo, { mode: "refuse", gateReason: "the agent is turned off for this repo", push: false, verdict: null });
  assert.match(gh.comments.get(5)[0].body, /Nothing was pushed:\*\* the agent is turned off/);

  gh = github();
  await publishWith(gh, repo, { push: false, verdict: { status: "no_change", changes: [], reply: "It uses `new Date()`." } });
  const body = gh.comments.get(5)[0].body;
  assert.match(body, /It uses `new Date\(\)`\./);
  assert.doesNotMatch(body, /Nothing was pushed|Pushed/);
});

test("the comment gets 👀, a review doesn't", async () => {
  const gh = github();
  await acknowledge({ github: gh, owner: "o", repo: "r", comment: commentFrom(issueComment("@claude go")) });
  await acknowledge({ github: gh, owner: "o", repo: "r", comment: commentFrom(reviewComment("@claude go")) });
  await acknowledge({ github: gh, owner: "o", repo: "r", comment: commentFrom(review("@claude go")) });
  assert.deepEqual(
    gh.calls.filter((c) => c[0] === "reaction"),
    [
      ["reaction", "issue_comment", 11, "eyes"],
      ["reaction", "review_comment", 12, "eyes"],
    ]
  );
});
