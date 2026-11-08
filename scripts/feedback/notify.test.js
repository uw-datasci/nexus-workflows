"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFeedbackBlock, planNotify, postToDiscord } = require("./notify");
const { renderComment } = require("./triage");
const { parseConfig } = require("./config");
const { fakeGitHub } = require("./fake-github");

const config = parseConfig({ app: "cxc", lead: "lead", branches: { production: "main", staging: "dev" } });
const IDS = { guild: "100000000000000001", channel: "300000000000000002", message: "600000000000000001", user: "400000000000000001" };
const BLOCK = `<!-- nexus-feedback ${JSON.stringify(IDS)} -->`;
const PREVIEW_URL = "https://cxc-abc123-uwdsc.vercel.app";

const feedbackIssue = (extra = {}) => ({
  number: 12,
  title: "Fix the FAQ link @everyone",
  body: `> the FAQ link 404s\n\n${BLOCK}`,
  labels: ["feedback", "route:agent", "env:prod"],
  html_url: "https://github.com/uw-datasci/cxc/issues/12",
  ...extra,
});
const pr = (extra = {}) => ({
  number: 34,
  state: "open",
  merged_at: null,
  head: { ref: "feedback/12-fix-the-faq-link", sha: "abc", repo: { full_name: "uw-datasci/cxc" } },
  base: { ref: "main" },
  html_url: "https://github.com/uw-datasci/cxc/pull/34",
  ...extra,
});

const deployment = (environment, sha = "abc", state = "success") => ({
  eventName: "deployment_status",
  payload: {
    deployment: { sha, environment },
    deployment_status: { state, environment, environment_url: PREVIEW_URL, target_url: PREVIEW_URL },
  },
});

const plan = (github, context, extra = {}) =>
  planNotify({ github, context, owner: "uw-datasci", repo: "cxc", config, ...extra });

test("parseFeedbackBlock reads the last valid block", () => {
  assert.deepEqual(parseFeedbackBlock(`text\n${BLOCK}`), IDS);
  const forgedFirst = `<!-- nexus-feedback {"guild":"1","channel":"2","message":"3","user":"4"} -->\n${BLOCK}`;
  assert.deepEqual(parseFeedbackBlock(forgedFirst), IDS);
  assert.equal(parseFeedbackBlock("a hand-written issue"), null);
  assert.equal(parseFeedbackBlock('<!-- nexus-feedback {"guild":"x"} -->'), null);
  assert.equal(parseFeedbackBlock("<!-- nexus-feedback {not json} -->"), null);
  assert.equal(parseFeedbackBlock(null), null);
});

test("preview: ready to check, as a reply to the card, with the buttons", async () => {
  const github = fakeGitHub({ issues: [feedbackIssue()], pulls: [pr()] });
  const result = await plan(github, deployment("Preview"));
  assert.equal(result.mode, "post");
  assert.equal(result.kind, "preview");
  assert.equal(result.channel, IDS.channel);

  const { body } = result;
  assert.match(body.content, /^<@400000000000000001> 🔍 \*\*\[#12\]\(https:\/\/github\.com\/uw-datasci\/cxc\/issues\/12\) is ready to check\*\*/);
  assert.doesNotMatch(body.content, /@everyone/, "the title can't ping");
  assert.deepEqual(body.allowed_mentions, { users: [IDS.user], replied_user: false });
  assert.deepEqual(body.message_reference, {
    message_id: IDS.message,
    channel_id: IDS.channel,
    guild_id: IDS.guild,
    fail_if_not_exists: false,
  });
  assert.deepEqual(
    body.components[0].components.map((b) => b.url ?? b.custom_id),
    [PREVIEW_URL, "fb:good:uw-datasci/cxc:34:12", "fb:again:uw-datasci/cxc:34:12"]
  );
});

test("preview: skips stale commits, closed PRs, other branches and failed deployments", async () => {
  const stale = fakeGitHub({ issues: [feedbackIssue()], pulls: [pr({ head: { ...pr().head, sha: "newer" }, merge_commit_sha: "abc" })] });
  assert.equal((await plan(stale, deployment("Preview"))).mode, "skip");

  const closed = fakeGitHub({ issues: [feedbackIssue()], pulls: [pr({ state: "closed" })] });
  assert.equal((await plan(closed, deployment("Preview"))).mode, "skip");

  const other = fakeGitHub({ issues: [feedbackIssue()], pulls: [pr({ head: { ...pr().head, ref: "feature/x" } })] });
  assert.match((await plan(other, deployment("Preview"))).reason, /no open feedback PR/);

  const github = fakeGitHub({ issues: [feedbackIssue()], pulls: [pr()] });
  assert.match((await plan(github, deployment("Preview", "abc", "failure"))).reason, /`failure`/);
  assert.match((await plan(github, deployment("copilot"))).reason, /isn't a Preview or Production/);
});

test("live: a feedback PR merged into production, once its deployment succeeds", async () => {
  const merged = pr({ state: "closed", merged_at: "2026-11-08T18:00:00Z", merge_commit_sha: "m1", head: { ...pr().head, sha: "old" } });
  const github = fakeGitHub({ issues: [feedbackIssue()], pulls: [merged] });
  const result = await plan(github, deployment("Production", "m1"), { productionUrl: "https://cxc.uwdatascience.ca" });
  assert.equal(result.kind, "live");
  assert.match(result.body.content, /🚀 \*\*\[#12\]\(.*\) is live\*\*: Fix the FAQ link/);
  assert.match(result.body.content, /\nhttps:\/\/cxc\.uwdatascience\.ca$/);
  assert.equal(result.body.components, undefined);

  const toDev = fakeGitHub({ issues: [feedbackIssue()], pulls: [{ ...merged, base: { ref: "dev" } }] });
  assert.match((await plan(toDev, deployment("Production", "m1"))).reason, /merged into `main`/);
});

test("staging: a feedback PR merged into dev", async () => {
  const github = fakeGitHub({ issues: [feedbackIssue()] });
  const event = (base, merged = true, ref = "feedback/12-fix") => ({
    eventName: "pull_request",
    payload: { action: "closed", pull_request: { number: 34, merged, head: { ref }, base: { ref: base }, html_url: "u" } },
  });
  const result = await plan(github, event("dev"), { stagingUrl: "https://cxc-git-dev-uwdsc.vercel.app" });
  assert.equal(result.kind, "staging");
  assert.match(result.body.content, /🧪 \*\*\[#12\]\(.*\) is on staging\*\*/);
  assert.match(result.body.content, /https:\/\/cxc-git-dev-uwdsc\.vercel\.app/);

  assert.match((await plan(github, event("main"))).reason, /not the staging branch/);
  assert.match((await plan(github, event("dev", false))).reason, /wasn't merged/);
  assert.match((await plan(github, event("dev", true, "feature/x"))).reason, /isn't a feedback branch/);
});

test("needs info: triage's question with an Answer button", async () => {
  const github = fakeGitHub({
    issues: [feedbackIssue({ labels: ["feedback", "needs-info"] })],
    issueComments: { 12: [{ body: renderComment({ kind: "needs_info", question: "Which page? Ping @lead" }) }] },
  });
  const result = await plan(github, {
    eventName: "issues",
    payload: { action: "labeled", label: { name: "needs-info" }, issue: { number: 12 } },
  });
  assert.equal(result.kind, "needs_info");
  assert.match(result.body.content, /❓ \*\*\[#12\]\(.*\) needs more information\*\*/);
  assert.match(result.body.content, /\n> Which page\? Ping @​lead$/);
  assert.equal(result.body.components[0].components[0].custom_id, "fb:answer:uw-datasci/cxc:12");

  const other = await plan(github, { eventName: "issues", payload: { action: "labeled", label: { name: "route:dev" }, issue: { number: 12 } } });
  assert.equal(other.mode, "skip");
});

test("hand-written issues (no hidden block) are skipped, not errors", async () => {
  const github = fakeGitHub({ issues: [feedbackIssue({ body: "Typed on GitHub" })], pulls: [pr()] });
  const result = await plan(github, deployment("Preview"));
  assert.equal(result.mode, "skip");
  assert.match(result.reason, /no nexus-feedback block/);
});

test("buttons that would break Discord's custom_id limit are left off", async () => {
  const long = "o".repeat(90);
  const github = fakeGitHub({ issues: [feedbackIssue()], pulls: [pr({ head: { ...pr().head, repo: { full_name: `${long}/cxc` } } })] });
  const result = await planNotify({ github, context: deployment("Preview"), owner: long, repo: "cxc", config });
  assert.equal(result.dropped, 2);
  assert.deepEqual(result.body.components[0].components.map((b) => b.label), ["Open preview"]);
});

test("postToDiscord: posts with the bot token; a missing channel is only a warning", async () => {
  const calls = [];
  const ok = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  assert.deepEqual(await postToDiscord({ token: "tok", channel: IDS.channel, body: { content: "x" }, fetch: ok }), { posted: true });
  assert.equal(calls[0].url, `https://discord.com/api/v10/channels/${IDS.channel}/messages`);
  assert.equal(calls[0].init.headers.Authorization, "Bot tok");
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: "x" });

  const gone = async () => new Response('{"message":"Unknown Channel"}', { status: 404 });
  assert.equal((await postToDiscord({ token: "t", channel: "1", body: {}, fetch: gone })).posted, false);

  const forbidden = async () => new Response('{"message":"Missing Access"}', { status: 403 });
  await assert.rejects(postToDiscord({ token: "t", channel: "1", body: {}, fetch: forbidden }), /403.*Missing Access/);
});
