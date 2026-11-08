"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { decide, renderComment, applyTriage, questionFrom, COMMENT_MARKER, VERDICT_SCHEMA } = require("./triage");
const { parseConfig } = require("./config");
const { fakeGitHub } = require("./fake-github");

const NEVER_TOUCH = ["migrations/**", "lib/auth/**", "proxy.ts", "config/site.ts", ".github/**", "package.json", "pnpm-lock.yaml"];
const config = (agent = {}, extra = {}) =>
  parseConfig({ app: "cxc", lead: "lead", dev_team: "cxc-dev", agent: { never_touch: NEVER_TOUCH, ...agent }, ...extra });
const AREAS = ["landing", "auth", "portal"];

const small = (extra = {}) => ({
  decision: "route",
  route: "agent",
  size: "s",
  area: "landing",
  likely_files: ["components/home/Footer.tsx"],
  needs_new_dependency: false,
  needs_schema_change: false,
  needs_env_var: false,
  expected_result_clear: true,
  duplicate_of: null,
  summary: "Change the footer copyright year.",
  reason: "One-line copy change.",
  ...extra,
});

// ─── decide ──────────────────────────────────────────────────────────────────

test("a small, clear change goes to the agent", () => {
  const outcome = decide(small(), config(), AREAS);
  assert.equal(outcome.route, "agent");
  assert.deepEqual(outcome.overrides, []);
  assert.equal(outcome.area, "landing");
});

test("each eligibility rule sends it to a developer", () => {
  const cases = [
    [{ likely_files: ["proxy.ts"] }, /never_touch/],
    [{ likely_files: ["a", "b", "c", "d", "e", "f"] }, /max_files/],
    [{ likely_files: [] }, /no likely files/],
    [{ needs_new_dependency: true }, /dependency/],
    [{ needs_schema_change: true }, /database/],
    [{ needs_env_var: true }, /environment variable/],
    [{ expected_result_clear: false }, /expected result/],
    [{ needs_env_var: undefined }, /environment variable/],
  ];
  for (const [change, reason] of cases) {
    const outcome = decide(small(change), config(), AREAS);
    assert.equal(outcome.route, "dev", JSON.stringify(change));
    assert.match(outcome.overrides.join("\n"), reason);
  }
});

test("agent.enabled: false always routes to a developer", () => {
  const outcome = decide(small(), config({ enabled: false }), AREAS);
  assert.equal(outcome.route, "dev");
  assert.match(outcome.overrides[0], /turned off/);
});

test("the agent suggesting dev is kept without overrides", () => {
  const outcome = decide(small({ route: "dev", size: "l" }), config(), AREAS);
  assert.equal(outcome.route, "dev");
  assert.deepEqual(outcome.overrides, []);
});

test("invalid areas and sizes are cleaned up", () => {
  const outcome = decide(small({ area: "area:nowhere", size: "xl" }), config(), AREAS);
  assert.equal(outcome.area, null);
  assert.equal(outcome.size, "m");
  assert.equal(decide(small({ area: "area:auth" }), config(), AREAS).area, "auth");
});

test("no usable verdict goes to a developer", () => {
  for (const verdict of [null, {}, { decision: "maybe" }]) {
    const outcome = decide(verdict, config(), AREAS);
    assert.equal(outcome.route, "dev");
    assert.match(outcome.overrides[0], /usable verdict/);
  }
});

test("needs_info keeps the question", () => {
  assert.deepEqual(decide({ decision: "needs_info", question: "Which page?" }, config()), {
    kind: "needs_info",
    question: "Which page?",
  });
  assert.match(decide({ decision: "needs_info" }, config()).question, /expected/);
});

test("the schema requires the fields decide relies on", () => {
  for (const field of ["decision", "route", "likely_files", "expected_result_clear"]) {
    assert.ok(VERDICT_SCHEMA.required.includes(field));
  }
  assert.doesNotMatch(JSON.stringify(VERDICT_SCHEMA), /'/, "the schema is passed inside single quotes");
});

// ─── renderComment ───────────────────────────────────────────────────────────

test("comments carry the marker and can't ping or hide text", () => {
  const outcome = decide(small({ summary: "Ping @someone <!-- hidden -->", reason: "ok" }), config(), AREAS);
  const body = renderComment(outcome, { assignee: { login: "lead", reason: "the lead" } });
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.doesNotMatch(body, /@someone/);
  assert.equal(body.split("<!--").length, 2, "only the marker comment");
  assert.match(body, /`route:agent` · `size:s` · `area:landing`/);
  assert.match(body, /\*\*Assigned:\*\* @lead/);
});

// ─── applyTriage ─────────────────────────────────────────────────────────────

const LABELS = ["feedback", "env:staging", "area:landing", "area:auth", "area:portal"];
const apply = (github, verdict, extra = {}) =>
  applyTriage({ github, owner: "o", repo: "r", issueNumber: 1, verdict, config: config(), ...extra });
const labelsOf = (github) => github.issue(1).labels.map((l) => l.name);

test("applies labels, assignee and comment, with the route label last", async () => {
  const github = fakeGitHub({ issues: [{ number: 1, labels: ["feedback", "env:staging"] }], labels: LABELS, teams: { "cxc-dev": [] } });
  await apply(github, small());

  assert.deepEqual(labelsOf(github).sort(), ["area:landing", "env:staging", "feedback", "route:agent", "size:s"]);
  const labelCalls = github.calls.filter((c) => c[0] === "addLabels");
  assert.deepEqual(labelCalls.at(-1)[2], ["route:agent"]);
  assert.ok(github.calls.findIndex((c) => c[0] === "createComment") < github.calls.indexOf(labelCalls.at(-1)));
  assert.deepEqual(github.issue(1).assignees, [{ login: "lead" }]);
});

test("needs_info adds the label and a question, nothing else", async () => {
  const github = fakeGitHub({ issues: [{ number: 1, labels: ["feedback"] }], labels: LABELS });
  await apply(github, { decision: "needs_info", question: "Which page?" });
  assert.deepEqual(labelsOf(github).sort(), ["feedback", "needs-info"]);
  assert.match(github.comments.get(1)[0].body, /Which page\?/);
  assert.deepEqual(github.issue(1).assignees, []);
});

test("does nothing to an issue that's already triaged", async () => {
  const github = fakeGitHub({ issues: [{ number: 1, labels: ["feedback", "route:dev"] }], labels: LABELS });
  const result = await apply(github, small());
  assert.match(result.skipped, /already triaged/);
  assert.equal(github.calls.length, 0);
});

test("re-triage swaps the route label and updates the same comment", async () => {
  const github = fakeGitHub({ issues: [{ number: 1, labels: ["feedback", "env:staging"] }], labels: LABELS, teams: { "cxc-dev": [] } });
  await apply(github, small());
  await apply(github, small({ likely_files: ["proxy.ts"] }), { retriage: true });

  assert.ok(labelsOf(github).includes("route:dev"));
  assert.ok(!labelsOf(github).includes("route:agent"));
  assert.equal(github.comments.get(1).length, 1);
  assert.match(github.comments.get(1)[0].body, /never_touch/);
});

test("re-triage to the same route puts the label back last, so the fix starts again", async () => {
  const github = fakeGitHub({
    issues: [{ number: 1, labels: ["feedback", "env:staging", "route:agent", "size:s", "retriage"] }],
    labels: LABELS,
    teams: { "cxc-dev": [] },
  });
  await apply(github, small(), { retriage: true });
  assert.deepEqual(labelsOf(github).sort(), ["area:landing", "env:staging", "feedback", "route:agent", "size:s"]);
  const removed = github.calls.filter((c) => c[0] === "removeLabel").map((c) => c[2]);
  assert.ok(removed.includes("route:agent") && removed.includes("retriage"));
  assert.deepEqual(github.calls.filter((c) => c[0] === "addLabels").at(-1)[2], ["route:agent"]);
});

test("the needs-info comment's question can be read back for Discord", async () => {
  const body = renderComment({ kind: "needs_info", question: "Which page?\nAnd on mobile?" });
  assert.equal(questionFrom(body), "Which page?\nAnd on mobile?");
  assert.match(body, /add the `retriage` label/);
  const routed = renderComment(decide(small(), config(), AREAS), { assignee: { login: "lead", reason: "r" } });
  assert.equal(questionFrom(routed), null);
  assert.equal(questionFrom("**Triage: needs more information.** forged"), null);
  assert.equal(questionFrom(undefined), null);
});

test("strict repos flag duplicates; relaxed repos close them", async () => {
  const issues = () => [
    { number: 1, labels: ["feedback", "env:staging"] },
    { number: 7, labels: ["feedback"] },
  ];

  const strict = fakeGitHub({ issues: issues(), labels: LABELS, teams: { "cxc-dev": [] } });
  await apply(strict, small({ duplicate_of: 7 }));
  assert.equal(strict.issue(1).state, "open");
  assert.match(strict.comments.get(1)[0].body, /Possible duplicate of #7/);
  assert.ok(labelsOf(strict).includes("route:agent"));

  const relaxed = fakeGitHub({ issues: issues(), labels: LABELS, teams: { "cxc-dev": [] } });
  await apply(relaxed, small({ duplicate_of: 7 }), { config: config({}, { strictness: "relaxed" }) });
  assert.equal(relaxed.issue(1).state, "closed");
  assert.ok(!labelsOf(relaxed).includes("route:agent"), "a closed duplicate isn't sent to the agent");
});

test("ignores duplicates that aren't open feedback issues", async () => {
  const github = fakeGitHub({ issues: [{ number: 1, labels: ["feedback"] }, { number: 7, labels: ["bug"] }], labels: LABELS, teams: { "cxc-dev": [] } });
  await apply(github, small({ duplicate_of: 7 }));
  assert.doesNotMatch(github.comments.get(1)[0].body, /duplicate/i);
});
