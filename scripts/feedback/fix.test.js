"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeRepo } = require("./test-git");
const {
  slugify,
  branchName,
  issueFromBranch,
  retriesFrom,
  likelyFilesFrom,
  gateFix,
  allowedTools,
  agentOutcome,
  prBody,
  publish,
  handoff,
  stepResult,
  FIX_MARKER,
  FIX_SCHEMA,
} = require("./fix");
const { COMMENT_MARKER: TRIAGE_MARKER } = require("./triage");
const { parseConfig } = require("./config");
const { fakeGitHub } = require("./fake-github");

const NEVER_TOUCH = ["migrations/**", "lib/auth/**", "proxy.ts", ".github/**", "package.json"];
const config = (agent = {}) =>
  parseConfig({ app: "cxc", lead: "lead", dev_team: "cxc-dev", agent: { never_touch: NEVER_TOUCH, ...agent } });

const person = { login: "alice", type: "User" };
const bot = { login: "nexus-feedback[bot]", type: "Bot" };
const issues = (action, label, sender = person) => ({
  eventName: "issues",
  payload: { action, label: { name: label }, sender, issue: { number: 1 } },
});
const gate = (github, context, cfg = config()) =>
  gateFix({ github, context, owner: "o", repo: "r", getConfig: () => cfg });
const issue = (labels, extra = {}) => ({ number: 1, title: "Footer shows the wrong year", labels, ...extra });

// ─── Names ───────────────────────────────────────────────────────────────────

test("branch names come from the issue number and title", () => {
  assert.equal(slugify("Fix the Footer © year!!"), "fix-the-footer-year");
  assert.equal(slugify("Café menu"), "cafe-menu");
  assert.equal(slugify("a".repeat(30) + " " + "b".repeat(30)).length <= 40, true);
  assert.equal(slugify("!!!"), "fix");
  assert.equal(branchName(12, "Footer year"), "feedback/12-footer-year");
  assert.equal(issueFromBranch("feedback/12-footer-year"), 12);
  assert.equal(issueFromBranch("feature/12-x"), null);
  assert.equal(retriesFrom("text\n<!-- nexus-feedback-fix retries=1 -->"), 1);
  assert.equal(retriesFrom(null), 0);
});

test("the schema can be passed inside single quotes", () => {
  assert.doesNotMatch(JSON.stringify(FIX_SCHEMA), /'/);
});

// ─── Gate: issue events ──────────────────────────────────────────────────────

test("route:agent starts a fix on a fresh branch from the environment's branch", async () => {
  const github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:agent"])] });
  const result = await gate(github, issues("labeled", "route:agent", bot));
  assert.equal(result.mode, "fix");
  assert.equal(result.base, "dev");
  assert.equal(result.branch, "feedback/1-footer-shows-the-wrong-year");
  assert.equal(result.branchExists, false);
  assert.equal(result.prNumber, 0);
});

test("env:prod targets the production branch", async () => {
  const github = fakeGitHub({ issues: [issue(["feedback", "env:prod", "route:agent"])] });
  assert.equal((await gate(github, issues("labeled", "route:agent"))).base, "main");
});

test("a second try continues on the existing branch and PR", async () => {
  const github = fakeGitHub({
    issues: [issue(["feedback", "env:staging", "route:agent"])],
    branches: ["feedback/1-old-title", "feedback/10-other"],
    pulls: [{ number: 5, head: { ref: "feedback/1-old-title", sha: "abc" }, base: { ref: "dev" } }],
  });
  const result = await gate(github, issues("labeled", "route:agent"));
  assert.equal(result.branch, "feedback/1-old-title");
  assert.equal(result.branchExists, true);
  assert.equal(result.prNumber, 5);
});

test("route:agent hands off when the agent is off or there's no environment", async () => {
  let github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:agent"])] });
  let result = await gate(github, issues("labeled", "route:agent"), config({ enabled: false }));
  assert.equal(result.mode, "handoff");
  assert.match(result.reason, /turned off/);

  github = fakeGitHub({ issues: [issue(["feedback", "route:agent"])] });
  result = await gate(github, issues("labeled", "route:agent"));
  assert.equal(result.mode, "handoff");
  assert.match(result.reason, /env:prod/);
});

test("a person adding route:dev takes over; a bot doing it is ignored", async () => {
  const github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:dev"])] });
  const result = await gate(github, issues("labeled", "route:dev"));
  assert.equal(result.mode, "takeover");
  assert.match(result.reason, /alice switched/);
  assert.equal((await gate(github, issues("labeled", "route:dev", bot))).mode, "skip");
});

test("a person removing route:agent stops the agent, unless route:dev is set too", async () => {
  let github = fakeGitHub({ issues: [issue(["feedback", "env:staging"])] });
  assert.equal((await gate(github, issues("unlabeled", "route:agent"))).mode, "stop");
  assert.equal((await gate(github, issues("unlabeled", "route:agent", bot))).mode, "skip");

  github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:dev"])] });
  assert.equal((await gate(github, issues("unlabeled", "route:agent"))).mode, "skip");
});

test("other events and issues are skipped", async () => {
  const github = fakeGitHub({
    issues: [issue(["feedback", "env:staging", "route:agent"], { state: "closed" }), { number: 2, labels: ["bug", "route:agent"] }],
  });
  assert.equal((await gate(github, issues("labeled", "feedback"))).mode, "skip");
  assert.equal((await gate(github, issues("unlabeled", "route:dev"))).mode, "skip");
  assert.match((await gate(github, issues("labeled", "route:agent"))).reason, /closed/);
  const other = issues("labeled", "route:agent");
  other.payload.issue.number = 2;
  assert.match((await gate(github, other)).reason, /no `feedback` label/);
  assert.equal((await gate(github, { eventName: "push", payload: {} })).mode, "skip");
});

test("route:agent that's gone again by the time the run starts is skipped", async () => {
  const github = fakeGitHub({ issues: [issue(["feedback", "env:staging"])] });
  assert.equal((await gate(github, issues("labeled", "route:agent"))).mode, "skip");
});

// ─── Gate: quality-gate results ──────────────────────────────────────────────

const failedRun = (extra = {}) => ({
  eventName: "workflow_run",
  payload: {
    action: "completed",
    workflow_run: {
      id: 77,
      name: "CI Quality Gate",
      conclusion: "failure",
      head_branch: "feedback/1-footer",
      head_sha: "sha1",
      head_repository: { full_name: "o/r" },
      html_url: "https://github.test/runs/77",
      ...extra,
    },
  },
});
const withPr = (body = "<!-- nexus-feedback-fix retries=0 -->", labels = ["feedback", "env:staging", "route:agent"]) =>
  fakeGitHub({
    issues: [issue(labels)],
    pulls: [{ number: 5, body, head: { ref: "feedback/1-footer", sha: "sha1" }, base: { ref: "dev" } }],
  });

test("the first quality-gate failure gets a retry, the second hands off", async () => {
  const first = await gate(withPr(), failedRun());
  assert.equal(first.mode, "retry");
  assert.equal(first.failedRunId, 77);
  assert.equal(first.prNumber, 5);
  assert.equal(first.base, "dev");

  const second = await gate(withPr("<!-- nexus-feedback-fix retries=1 -->"), failedRun());
  assert.equal(second.mode, "handoff");
  assert.match(second.reason, /failed again/);
});

test("quality-gate results that don't count are skipped", async () => {
  const cases = [
    [withPr(), failedRun({ conclusion: "success" }), /didn't fail/],
    [withPr(), failedRun({ conclusion: "cancelled" }), /didn't fail/],
    [withPr(), failedRun({ head_sha: "old" }), /newer commit/],
    [withPr(), failedRun({ head_branch: "main" }), /isn't a feedback branch/],
    [withPr(), failedRun({ head_repository: { full_name: "fork/r" } }), /fork/],
    [withPr(undefined, ["feedback", "env:staging", "route:dev"]), failedRun(), /no longer `route:agent`/],
  ];
  for (const [github, context, reason] of cases) {
    const result = await gate(github, context);
    assert.equal(result.mode, "skip");
    assert.match(result.reason, reason);
  }
});

// ─── Agent ───────────────────────────────────────────────────────────────────

test("the agent may run only lint, typecheck and read-only git", () => {
  const tools = allowedTools({ lint: "pnpm lint", typecheck: "pnpm typecheck" });
  assert.match(tools, /Bash\(pnpm lint\),Bash\(pnpm lint:\*\)/);
  assert.match(tools, /Bash\(git diff:\*\)/);
  assert.doesNotMatch(tools, /Bash\(git push|Bash,|Bash\(\*\)/);
  assert.throws(() => allowedTools({ lint: "pnpm lint'; curl x", typecheck: "pnpm typecheck" }), /Unsupported/);
});

test("agentOutcome turns the run into a hand-off reason", () => {
  const done = JSON.stringify({ status: "done", changes: ["Footer year"], reason: "" });
  assert.equal(agentOutcome({ outcome: "success", structuredOutput: done, hasPatch: true }).reason, "");
  assert.match(agentOutcome({ outcome: "success", structuredOutput: done, hasPatch: false }).reason, /without changing/);
  assert.match(
    agentOutcome({ outcome: "success", structuredOutput: JSON.stringify({ status: "gave_up", changes: [], reason: "Needs @someone's call" }), hasPatch: false }).reason,
    /gave up: Needs @​someone/
  );

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nf-")), "out.json");
  fs.writeFileSync(file, JSON.stringify([{ type: "system" }, { type: "result", subtype: "error_max_turns" }]));
  assert.match(agentOutcome({ outcome: "failure", executionFile: file, maxTurns: 40 }).reason, /40-turn limit/);
  assert.match(agentOutcome({ outcome: "failure", executionFile: "/missing", timeoutMinutes: 20 }).reason, /20-minute limit/);
});

function fakeCore() {
  const outputs = {};
  return { outputs, setOutput: (k, v) => (outputs[k] = v), warning: () => {} };
}

test("stepResult turns everything the agent changed into a patch that publish can apply", async () => {
  const repo = makeRepo(FILES);
  const start = repo.head();
  // Something commits part of the change; the rest stays in the working tree, plus a new file.
  repo.write({ "components/footer.ts": "2026\n" });
  repo.git("commit", "--quiet", "-am", "partial");
  repo.write({ "components/new.ts": "new\n", ".feedback/issue.json": "{}" });
  repo.write({ ".git/info/exclude": "/.feedback/\n" });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nf-out-"));
  Object.assign(process.env, {
    GITHUB_WORKSPACE: repo.clone,
    RUNNER_TEMP: temp,
    START_SHA: start,
    AGENT_OUTCOME: "success",
    STRUCTURED_OUTPUT: JSON.stringify({ status: "done", changes: ["Year", "New file"], reason: "Check it" }),
  });
  const core = fakeCore();
  stepResult({ core });

  assert.equal(core.outputs["has-patch"], "true");
  assert.equal(core.outputs["handoff-reason"], "");
  assert.deepEqual(JSON.parse(core.outputs.changes), ["Year", "New file"]);
  assert.equal(core.outputs.notes, "Check it");

  // Back to the starting commit, the way the publish job checks it out.
  repo.git("reset", "--quiet", "--hard", start);
  repo.git("clean", "-fdq");
  const github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:agent"])] });
  const result = await publishWith({ repo, github, patchFile: path.join(temp, "feedback-fix", "changes.patch") });
  assert.deepEqual(result.files, ["components/footer.ts", "components/new.ts"], "the excluded .feedback folder isn't included");
});

// ─── PR body ─────────────────────────────────────────────────────────────────

const CXC_TEMPLATE = `<!-- Make sure you add the correct **Assignees** and **Labels** that best fit this pull request -->

## Closes Issue

<!-- IMPORTANT: please replace "[issue-number]" with the issue number from the GitHub Project -->

closes #[issue-number]

## Changes Made

<!-- Brief description of what you changed using bullet points -->

-

## Additional Notes/Screenshots/Videos (Optional)
`;

test("the PR body fills in cxc's template", () => {
  const body = prBody({ template: CXC_TEMPLATE, issueNumber: 12, changes: ["Update the footer year", "Ping @lead <!-- x -->"], notes: "Check mobile" });
  assert.match(body, /closes #12\n/);
  assert.doesNotMatch(body, /\[issue-number\]|Make sure you add/);
  assert.match(body, /## Changes Made\n\n- Update the footer year\n- Ping @​lead x\n/);
  assert.equal(body.match(/closes #12/g).length, 1);
  assert.match(body, /\*\*Note from the agent:\*\* Check mobile/);
  assert.equal(body.split("<!--").length, 2, "only the marker comment");
  assert.equal(retriesFrom(body), 0);
});

test("without a template the body still closes the issue", () => {
  const body = prBody({ template: null, issueNumber: 3, changes: [], retries: 1 });
  assert.ok(body.startsWith("closes #3\n\n## Changes made\n\n- See the diff."));
  assert.equal(retriesFrom(body), 1);
});

// ─── Publish ─────────────────────────────────────────────────────────────────

const IDENTITY = { name: "nexus-feedback[bot]", email: "1+nexus-feedback[bot]@users.noreply.github.com" };
const FILES = { "components/footer.ts": "2025\n", "proxy.ts": "proxy\n", ".github/pull_request_template.md": CXC_TEMPLATE };

function publishWith({ repo, github, patchFile, plan = {}, cfg = config() }) {
  return publish({
    github,
    owner: "o",
    repo: "r",
    cwd: repo.clone,
    plan: { mode: "fix", issueNumber: 1, base: "dev", branch: "feedback/1-footer", prNumber: 0, retries: 0, ...plan },
    patchFile,
    agent: { changes: ["Update the footer year"], notes: "" },
    config: cfg,
    identity: IDENTITY,
    pushToken: "",
  });
}

test("publish pushes the branch, opens the PR and reports it on the issue", async () => {
  const repo = makeRepo(FILES);
  const patchFile = repo.patch({ "components/footer.ts": "2026\n" });
  const github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:agent", "route:dev"])] });

  const result = await publishWith({ repo, github, patchFile });

  assert.equal(result.pr.created, true);
  assert.deepEqual(result.files, ["components/footer.ts"]);
  assert.equal(repo.show("feedback/1-footer", "components/footer.ts"), "2026\n");
  const [pr] = github.prs;
  assert.equal(pr.base.ref, "dev");
  assert.match(pr.title, /^Feedback #1: Footer shows the wrong year$/);
  assert.match(pr.body, /closes #1/);
  assert.ok(github.calls.some((c) => c[0] === "requestReviewers" && c[2][0] === "lead"));
  assert.ok(!github.issue(1).labels.some((l) => l.name === "route:dev"), "a stale route:dev is removed");
  assert.match(github.comments.get(1)[0].body, new RegExp(`^${FIX_MARKER}\\n\\*\\*Agent PR opened:\\*\\* #100`));
});

test("an opened agent PR moves the issue to In Review on the board", async () => {
  const repo = makeRepo(FILES);
  const patchFile = repo.patch({ "components/footer.ts": "2026\n" });
  const github = fakeGitHub({
    issues: [issue(["feedback", "env:staging", "route:agent"])],
    project: { number: 28, options: ["Backlog", "Todo", "In Progress", "In Review"] },
  });
  const cfg = parseConfig({ app: "cxc", lead: "lead", dev_team: "cxc-dev", project: { number: 28 } });

  const result = await publishWith({ repo, github, patchFile, cfg });

  assert.equal(result.status, "In Review");
  assert.equal(github.projectStatus(1), "In Review");
});

test("a change that breaks the rules is never pushed", async () => {
  const repo = makeRepo(FILES);
  const patchFile = repo.patch({ "components/footer.ts": "2026\n", "proxy.ts": "changed\n" });
  const github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:agent"])] });

  const result = await publishWith({ repo, github, patchFile });

  assert.match(result.handoff.join("\n"), /`proxy\.ts` matches `never_touch`/);
  assert.ok(!repo.branches().includes("feedback/1-footer"));
  assert.equal(github.prs.length, 0);
});

test("max_files counts what's already on the branch", async () => {
  const repo = makeRepo(FILES);
  repo.git("checkout", "--quiet", "-b", "feedback/1-footer");
  repo.write({ "components/a.ts": "a\n" });
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "earlier");
  repo.git("push", "--quiet", "origin", "feedback/1-footer");
  const patchFile = repo.patch({ "components/footer.ts": "2026\n" });
  const github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:agent"])] });

  const result = await publishWith({ repo, github, patchFile, cfg: config({ max_files: 1 }) });
  assert.match(result.handoff.join("\n"), /2 files, more than `max_files` \(1\)/);
});

test("a retry pushes onto the PR and records the retry", async () => {
  const repo = makeRepo(FILES);
  repo.git("checkout", "--quiet", "-b", "feedback/1-footer");
  repo.write({ "components/footer.ts": "2026 \n" });
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "first try");
  repo.git("push", "--quiet", "origin", "feedback/1-footer");
  const patchFile = repo.patch({ "components/footer.ts": "2026\n" });
  const github = fakeGitHub({
    issues: [issue(["feedback", "env:staging", "route:agent"])],
    pulls: [{ number: 5, body: "<!-- nexus-feedback-fix retries=0 -->", head: { ref: "feedback/1-footer", sha: "x" }, base: { ref: "dev" } }],
  });

  const result = await publishWith({ repo, github, patchFile, plan: { mode: "retry", prNumber: 5, retries: 0 } });

  assert.equal(result.pr.created, false);
  assert.equal(repo.show("feedback/1-footer", "components/footer.ts"), "2026\n");
  assert.equal(retriesFrom(github.prs[0].body), 1);
  assert.ok(!github.calls.some((c) => c[0] === "requestReviewers"));
});

test("a rejected push hands off", async () => {
  const repo = makeRepo(FILES);
  const start = repo.head();
  const patchFile = repo.patch({ "components/footer.ts": "2026\n" });
  // Someone else pushes to the feedback branch while the agent works.
  repo.git("checkout", "--quiet", "-b", "feedback/1-footer");
  repo.write({ "components/other.ts": "x\n" });
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "someone else");
  repo.git("push", "--quiet", "origin", "feedback/1-footer");
  repo.git("checkout", "--quiet", "--detach", start);
  const github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:agent"])] });

  const result = await publishWith({ repo, github, patchFile });
  assert.match(result.handoff[0], /was rejected/);
  assert.equal(github.prs.length, 0);
});

test("publish does nothing once the issue has left route:agent", async () => {
  const repo = makeRepo(FILES);
  const patchFile = repo.patch({ "components/footer.ts": "2026\n" });
  const github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:dev"])] });
  const result = await publishWith({ repo, github, patchFile });
  assert.match(result.skipped, /no longer `route:agent`/);
  assert.ok(!repo.branches().includes("feedback/1-footer"));
});

// ─── Hand-off ────────────────────────────────────────────────────────────────

const handoffWith = (github, extra = {}) =>
  handoff({ github, owner: "o", repo: "r", issueNumber: 1, config: config(), mode: "fix", reasons: ["the agent gave up: too big"], ...extra });

test("hand-off assigns the developer who last changed the files, then swaps the labels", async () => {
  const github = fakeGitHub({
    issues: [issue(["feedback", "env:staging", "route:agent", "area:landing"], { assignees: [{ login: "lead" }] })],
    teams: { "cxc-dev": ["bob"] },
    commits: { "components/footer.ts": [["bob", "2026-10-01T00:00:00Z"]] },
  });
  const result = await handoffWith(github, { files: ["components/footer.ts"], runUrl: "https://github.test/runs/1" });

  assert.equal(result.assignee.login, "bob");
  assert.deepEqual(github.issue(1).assignees, [{ login: "bob" }]);
  const labels = github.issue(1).labels.map((l) => l.name);
  assert.ok(labels.includes("route:dev") && !labels.includes("route:agent"));

  const body = github.comments.get(1)[0].body;
  assert.ok(body.startsWith(FIX_MARKER));
  assert.match(body, /- the agent gave up: too big/);
  assert.match(body, /\*\*Assigned:\*\* @bob, most recently changed `components\/footer\.ts`/);
  assert.match(body, /\[Workflow run\]\(https:\/\/github\.test\/runs\/1\)/);

  const order = github.calls.map((c) => c[0]);
  assert.ok(order.indexOf("createComment") < order.indexOf("addLabels"), "labels change last");
});

test("hand-off moves the issue to Todo on the board", async () => {
  const github = fakeGitHub({
    issues: [issue(["feedback", "env:staging", "route:agent"])],
    teams: { "cxc-dev": [] },
    project: { number: 28, options: ["Backlog", "Todo", "In Progress"] },
  });
  const result = await handoffWith(github, { config: parseConfig({ app: "cxc", lead: "lead", dev_team: "cxc-dev", project: { number: 28 } }) });
  assert.equal(result.status, "Todo");
  assert.equal(github.projectStatus(1), "Todo");
});

test("hand-off falls back to the triage comment's likely files and mentions an open PR", async () => {
  const github = fakeGitHub({
    issues: [issue(["feedback", "env:staging", "route:agent"])],
    teams: { "cxc-dev": ["carol"] },
    commits: { "lib/x.ts": [["carol", "2026-10-01T00:00:00Z"]] },
    branches: ["feedback/1-footer"],
    pulls: [{ number: 5, head: { ref: "feedback/1-footer", sha: "s" }, base: { ref: "dev" } }],
  });
  github.comments.set(1, [{ id: 1, body: `${TRIAGE_MARKER}\n**Triage:** x\n\n**Likely files:** \`lib/x.ts\`, \`lib/y.ts\`` }]);
  assert.deepEqual(likelyFilesFrom(github.comments.get(1)[0].body), ["lib/x.ts", "lib/y.ts"]);

  const result = await handoffWith(github);
  assert.equal(result.assignee.login, "carol");
  assert.match(github.comments.get(1).at(-1).body, /#5 is still open/);
});

test("a developer who is already assigned keeps the issue", async () => {
  const github = fakeGitHub({
    issues: [issue(["feedback", "env:staging", "route:dev", "route:agent"], { assignees: [{ login: "lead" }, { login: "dana" }] })],
  });
  const result = await handoffWith(github, { mode: "takeover", reasons: ["alice switched this issue to `route:dev`"] });
  assert.equal(result.assignee.login, "dana");
  assert.ok(!github.calls.some((c) => c[0] === "addAssignees"));
  assert.ok(!github.issue(1).labels.some((l) => l.name === "route:agent"));
});

test("an automatic hand-off does nothing once someone else moved the issue", async () => {
  const github = fakeGitHub({ issues: [issue(["feedback", "env:staging", "route:dev"])] });
  const result = await handoffWith(github);
  assert.match(result.skipped, /no longer `route:agent`/);
  assert.equal(github.calls.length, 0);
});
