"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, ConfigError } = require("./config");
const { collectContext, buildPrompt } = require("./context");
const { safe, code } = require("./triage");
const { issueFromBranch, retriesFrom, PR_MARKER, BRANCH_PREFIX } = require("./fix");
const {
  env,
  json,
  allowedTools,
  excludeAgentFiles,
  limitReason,
  parseVerdict,
  makePatch,
  applyAndPush,
  botIdentity,
} = require("./agent-run");

/**
 * `@claude` on a feedback PR: Claude makes the requested change on the PR's branch, or answers,
 * and the workflow replies on the PR. Same guardrail and queue as the fix workflow. One function
 * per workflow step (`step*`); see claude-mention.yml for the jobs.
 */

const MENTION_MARKER = "<!-- nexus-feedback-mention -->";
// "@claude" as a whole word: not "@claude-bot", not "x@claude". Replies break every "@" with a
// zero-width space (safe()), so they can never match.
const MENTION = /(?:^|[^\w@])@claude(?![\w-])/i;
const CONTEXT_DIR = ".feedback";
const MAX_REPLY = 3000;
const MAX_CHANGES = 10;
const CONVERSATION_LIMIT = 30;
const WRITE_PERMISSIONS = ["admin", "write"]; // "maintain" is reported as "write"

// Passed to the action inside single quotes, so no apostrophes anywhere in here.
const MENTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "changes", "reply"],
  properties: {
    status: {
      type: "string",
      enum: ["changed", "no_change", "gave_up"],
      description:
        "changed: you edited files and lint and typecheck pass. no_change: nothing needed editing (for example you answered a question). gave_up: the request can not be done within the rules.",
    },
    changes: {
      type: "array",
      items: { type: "string" },
      description: "What you changed, one short line each. Empty unless status is changed.",
    },
    reply: {
      type: "string",
      description: "Your reply to the comment in GitHub Markdown, a few sentences at most. If you gave up, say why.",
    },
  },
};

const oneLine = (text, max = 300) => safe(String(text ?? "")).replace(/\s+/g, " ").slice(0, max);

// ─── The comment ─────────────────────────────────────────────────────────────

/** The new comment in this event, or null if the event isn't a new PR comment. */
function commentFrom(context) {
  const { eventName, payload } = context;
  if (eventName === "issue_comment" && payload.action === "created" && payload.issue?.pull_request) {
    const c = payload.comment;
    return { kind: "issue_comment", id: c.id, body: c.body ?? "", author: c.user, prNumber: payload.issue.number, url: c.html_url };
  }
  if (eventName === "pull_request_review_comment" && payload.action === "created") {
    const c = payload.comment;
    return {
      kind: "review_comment",
      id: c.id,
      body: c.body ?? "",
      author: c.user,
      prNumber: payload.pull_request.number,
      url: c.html_url,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      diffHunk: c.diff_hunk ?? "",
    };
  }
  if (eventName === "pull_request_review" && payload.action === "submitted") {
    const r = payload.review;
    return { kind: "review", id: r.id, body: r.body ?? "", author: r.user, prNumber: payload.pull_request.number, url: r.html_url };
  }
  return null;
}

function isAllowedBot(login, allowedBots) {
  const list = String(allowedBots ?? "").trim();
  if (list === "*") return true;
  const normalize = (name) => name.trim().toLowerCase().replace(/\[bot\]$/, "");
  return list.split(",").map(normalize).filter(Boolean).includes(normalize(login));
}

/** People need write access; bots must be listed in `allowed-bots`. */
async function mayTrigger({ github, owner, repo, user, allowedBots }) {
  if (!user?.login) return { ok: false, reason: "the comment has no author" };
  if (user.type === "Bot") {
    return isAllowedBot(user.login, allowedBots)
      ? { ok: true }
      : { ok: false, reason: `${user.login} isn't listed in allowed-bots` };
  }
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: user.login });
    if (WRITE_PERMISSIONS.includes(data.permission)) return { ok: true };
    return { ok: false, reason: `${user.login} doesn't have write access (${data.permission})` };
  } catch (error) {
    if (error.status === 404) return { ok: false, reason: `${user.login} isn't a collaborator` };
    throw error;
  }
}

// ─── Gate ────────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ mode: "run" | "refuse" | "skip", reason: string, comment?: object,
 *   prNumber?: number, base?: string, branch?: string, issueNumber?: number }>}
 */
async function gateMention({ github, context, owner, repo, getConfig, allowedBots }) {
  const skip = (reason) => ({ mode: "skip", reason });
  const comment = commentFrom(context);
  if (!comment) return skip(`\`${context.eventName}\` (${context.payload.action}) isn't a new comment on a PR`);
  if (comment.body.includes(MENTION_MARKER)) return skip("this is the workflow's own reply");
  if (!MENTION.test(comment.body)) return skip("the comment doesn't mention @claude");

  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: comment.prNumber });
  if (pr.state !== "open") return skip("the PR isn't open");
  if (!pr.head.ref.startsWith(BRANCH_PREFIX)) return skip(`\`${pr.head.ref}\` isn't a feedback branch`);
  if (pr.head.repo?.full_name !== `${owner}/${repo}`) return skip("the PR is from a fork");

  const who = await mayTrigger({ github, owner, repo, user: comment.author, allowedBots });
  if (!who.ok) return skip(who.reason);

  const plan = {
    comment,
    prNumber: pr.number,
    base: pr.base.ref,
    branch: pr.head.ref,
    issueNumber: issueFromBranch(pr.head.ref) ?? 0,
  };
  if (!getConfig().agent.enabled) {
    return { mode: "refuse", reason: "the agent is turned off for this repo (`agent.enabled: false`)", ...plan };
  }
  return { mode: "run", reason: "", ...plan };
}

// ─── Agent ───────────────────────────────────────────────────────────────────

function formatComment(c) {
  const where = c.path ? ` on \`${c.path}\`${c.line ? ` line ${c.line}` : ""}` : "";
  return `### ${c.user?.login ?? "someone"} (${c.created_at})${where}\n\n${c.body ?? ""}\n`;
}

/** The PR's recent comments and review comments, oldest first. */
async function conversation(github, owner, repo, prNumber) {
  const [issueComments, reviewComments] = await Promise.all([
    github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number: prNumber, per_page: 100 }),
  ]);
  return [...issueComments, ...reviewComments]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-CONVERSATION_LIMIT)
    .map(formatComment)
    .join("\n");
}

/** What the run left behind. `push` is whether the reply job should try to push the patch. */
function mentionOutcome({ outcome, structuredOutput, executionFile, hasPatch, maxTurns, timeoutMinutes }) {
  const verdict = parseVerdict(structuredOutput);
  if (outcome !== "success" || !verdict) {
    return { problem: limitReason({ executionFile, maxTurns, timeoutMinutes }), push: false, verdict };
  }
  if (verdict.status === "gave_up") return { problem: "", push: false, verdict };
  if (verdict.status === "changed" && !hasPatch) {
    return { problem: "the agent said it changed files, but nothing changed", push: false, verdict };
  }
  return { problem: "", push: hasPatch, verdict };
}

// ─── Reply (no model) ────────────────────────────────────────────────────────

const resetRetries = (body) => String(body ?? "").replace(PR_MARKER, "<!-- nexus-feedback-fix retries=0 -->");

function renderReply({ comment, verdict, pushed, notes = [], violations = [], repoUrl, runUrl }) {
  const lines = [];
  if (comment.kind !== "review_comment") lines.push(`<sub>Re: [this ${comment.kind === "review" ? "review" : "comment"}](${comment.url})</sub>`, "");
  const reply = safe(String(verdict?.reply ?? "")).slice(0, MAX_REPLY);
  if (reply) lines.push(reply, "");

  if (pushed) {
    lines.push(`**Pushed** [\`${pushed.sha.slice(0, 7)}\`](${repoUrl}/commit/${pushed.sha}):`);
    const changes = (verdict?.changes ?? []).slice(0, MAX_CHANGES).map((c) => oneLine(c)).filter(Boolean);
    lines.push(...(changes.length ? changes.map((c) => `- ${c}`) : ["- See the commit."]), "");
  } else if (violations.length > 0) {
    lines.push("**Nothing was pushed**, because the change breaks the agent's rules:", ...violations.map((v) => `- ${v}`), "");
  } else if (notes.length > 0) {
    lines.push(...notes.map((note) => `**Nothing was pushed:** ${oneLine(note, 500)}`), "");
  } else if (!reply) {
    lines.push("Nothing to change.", "");
  }

  lines.push(`<sub>[Workflow run](${runUrl})</sub>`, MENTION_MARKER);
  return lines.join("\n");
}

async function postReply({ github, owner, repo, comment, body, log = () => {} }) {
  if (comment.kind === "review_comment") {
    try {
      await github.rest.pulls.createReplyForReviewComment({ owner, repo, pull_number: comment.prNumber, comment_id: comment.id, body });
      return;
    } catch (error) {
      log(`Couldn't reply in the review thread (${error.message}); replying on the PR instead.`);
    }
  }
  await github.rest.issues.createComment({ owner, repo, issue_number: comment.prNumber, body });
}

/**
 * Push the agent's change if there is one and it passes the guardrail, then reply. Runs with the
 * App token and without the model.
 */
async function publishMention({ github, owner, repo, cwd, plan, comment, mode, gateReason = "", problem = "", verdict, push, patchFile, config, identity, pushToken, runUrl, log = () => {} }) {
  const notes = [];
  let violations = [];
  let pushed = null;

  if (mode === "refuse") notes.push(gateReason);
  else if (problem) notes.push(problem);
  else if (push) {
    const changes = (verdict?.changes ?? []).slice(0, MAX_CHANGES).map((c) => `- ${oneLine(c)}`);
    const result = applyAndPush({
      cwd,
      base: plan.base,
      branch: plan.branch,
      patchFile,
      config,
      identity,
      pushToken,
      message: [`Address review feedback on #${plan.prNumber}`, ...(changes.length ? [changes.join("\n")] : []), `Requested in ${comment.url}`],
    });
    if (result.violations) violations = result.violations;
    else if (result.error) notes.push(result.error);
    else {
      pushed = result;
      // A new iteration gets the fix workflow's one automatic quality-gate retry again.
      const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: plan.prNumber });
      if (retriesFrom(pr.body) > 0) {
        await github.rest.pulls.update({ owner, repo, pull_number: plan.prNumber, body: resetRetries(pr.body) });
      }
    }
  }

  const body = renderReply({ comment, verdict, pushed, notes, violations, repoUrl: `https://github.com/${owner}/${repo}`, runUrl });
  await postReply({ github, owner, repo, comment, body, log });
  return { pushed, notes, violations, body };
}

/** 👀 on the comment, so the reviewer knows it was picked up. Reviews can't take reactions. */
async function acknowledge({ github, owner, repo, comment, log = () => {} }) {
  try {
    if (comment.kind === "issue_comment") {
      await github.rest.reactions.createForIssueComment({ owner, repo, comment_id: comment.id, content: "eyes" });
    } else if (comment.kind === "review_comment") {
      await github.rest.reactions.createForPullRequestReviewComment({ owner, repo, comment_id: comment.id, content: "eyes" });
    }
  } catch (error) {
    log(`Couldn't react to the comment: ${error.message}`);
  }
}

// ─── Workflow steps ──────────────────────────────────────────────────────────

/** gate: does this comment start a run? */
async function stepGate({ github, context, core }) {
  const { owner, repo } = context.repo;
  const configFile = path.join(env("GITHUB_WORKSPACE"), CONTEXT_DIR, "config.raw.json");
  let config = null;
  const getConfig = () => (config ??= loadConfig(configFile));

  let result;
  try {
    result = await gateMention({ github, context, owner, repo, getConfig, allowedBots: env("ALLOWED_BOTS") });
  } catch (error) {
    if (error instanceof ConfigError) {
      core.setFailed(`${env("CONFIG_PATH")}: ${error.message}`);
      return;
    }
    throw error;
  }

  core.setOutput("mode", result.mode);
  core.setOutput("reason", result.reason ?? "");
  core.setOutput("pr-number", String(result.prNumber ?? 0));
  core.setOutput("issue-number", String(result.issueNumber ?? 0));
  core.setOutput("base", result.base ?? "");
  core.setOutput("branch", result.branch ?? "");
  core.setOutput("config", config ? JSON.stringify(config) : "");
  core.notice(`@claude: ${result.mode}${result.reason ? ` (${result.reason})` : ""}`);
}

/** ack: react to the comment. */
async function stepAck({ github, context, core }) {
  const { owner, repo } = context.repo;
  const comment = commentFrom(context);
  if (comment) await acknowledge({ github, owner, repo, comment, log: (message) => core.warning(message) });
}

/** agent: collect what the agent reads and build its prompt. */
async function stepPrepare({ github, context, core }) {
  const { owner, repo } = context.repo;
  const workspace = env("GITHUB_WORKSPACE");
  const dir = path.join(workspace, CONTEXT_DIR);
  const config = JSON.parse(env("CONFIG"));
  const prNumber = Number(env("PR_NUMBER"));
  const issueNumber = Number(env("ISSUE_NUMBER"));
  const comment = commentFrom(context);

  excludeAgentFiles(workspace, CONTEXT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "request.json"),
    JSON.stringify(
      {
        kind: comment.kind,
        author: comment.author?.login ?? null,
        body: comment.body,
        url: comment.url,
        ...(comment.kind === "review_comment" ? { path: comment.path, line: comment.line, diff_hunk: comment.diffHunk } : {}),
      },
      null,
      2
    )
  );

  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  fs.writeFileSync(
    path.join(dir, "pr.json"),
    JSON.stringify({ number: pr.number, title: pr.title, body: pr.body ?? "", base: pr.base.ref, head: pr.head.ref }, null, 2)
  );
  fs.writeFileSync(path.join(dir, "conversation.md"), await conversation(github, owner, repo, prNumber));

  let screenshots = [];
  if (issueNumber) {
    try {
      const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
      ({ screenshots } = await collectContext({
        github,
        owner,
        repo,
        issue,
        dir,
        token: env("GITHUB_TOKEN"),
        log: (message) => core.warning(message),
      }));
    } catch (error) {
      core.warning(`Couldn't read issue #${issueNumber}: ${error.message}`);
    }
  }

  const lint = env("LINT_COMMAND");
  const typecheck = env("TYPECHECK_COMMAND");
  const where =
    comment.kind === "review_comment"
      ? `It's a review comment on \`${comment.path}\`${comment.line ? ` line ${comment.line}` : ""}; the diff hunk is in \`request.json\`.`
      : comment.kind === "review"
        ? "It's the summary of a PR review."
        : "It's a comment on the PR.";
  const template = fs.readFileSync(path.join(__dirname, "mention-prompt.md"), "utf8");
  const prompt = buildPrompt(template, {
    REPO: `${owner}/${repo}`,
    PR_NUMBER: prNumber,
    ISSUE_NUMBER: issueNumber || "(none)",
    BRANCH: env("BRANCH"),
    BASE: env("BASE"),
    WHERE: where,
    CONTEXT_DIR,
    MAX_FILES: config.agent.max_files,
    NEVER_TOUCH: config.agent.never_touch.length ? config.agent.never_touch.map(code).join(", ") : "(none)",
    LINT_COMMAND: lint,
    TYPECHECK_COMMAND: typecheck,
    SCREENSHOTS: screenshots.length ? screenshots.map((file) => code(path.relative(workspace, file))).join(", ") : "none",
  });

  core.setOutput("prompt", prompt);
  core.setOutput("schema", JSON.stringify(MENTION_SCHEMA));
  core.setOutput("allowed-tools", allowedTools({ lint, typecheck }));
}

/** agent: turn the agent's work into a patch file and a result for the reply job. */
function stepResult({ core }) {
  const patch = makePatch({
    cwd: env("GITHUB_WORKSPACE"),
    startSha: env("START_SHA"),
    outFile: path.join(env("RUNNER_TEMP"), "feedback-mention", "changes.patch"),
  });
  const { problem, push, verdict } = mentionOutcome({
    outcome: env("AGENT_OUTCOME"),
    structuredOutput: env("STRUCTURED_OUTPUT"),
    executionFile: env("EXECUTION_FILE"),
    hasPatch: patch.trim() !== "",
    maxTurns: env("MAX_TURNS"),
    timeoutMinutes: env("TIMEOUT_MINUTES"),
  });
  core.setOutput("problem", problem);
  core.setOutput("has-patch", String(push));
  core.setOutput("verdict", verdict ? JSON.stringify(verdict) : "");
  if (problem) core.warning(problem);
}

/** reply: push if there's a change that passes the guardrail, and reply on the PR. */
async function stepReply({ github, context, core }) {
  const { owner, repo } = context.repo;
  const comment = commentFrom(context);
  const mode = env("MODE");

  let problem = env("PROBLEM");
  if (mode === "run" && !problem) {
    if (env("QUEUE_REASON")) problem = env("QUEUE_REASON");
    else if (env("QUEUE_RESULT") !== "success") problem = "waiting for other agent runs failed; see the workflow run";
    else if (env("AGENT_RESULT") !== "success") problem = "the agent job failed; see the workflow run";
  }
  const push = env("HAS_PATCH") === "true";
  const identity = push ? await botIdentity(github, env("APP_SLUG"), (message) => core.warning(message)) : null;

  const result = await publishMention({
    github,
    owner,
    repo,
    cwd: env("GITHUB_WORKSPACE"),
    plan: { prNumber: Number(env("PR_NUMBER")), base: env("BASE"), branch: env("BRANCH") },
    comment,
    mode,
    gateReason: env("GATE_REASON"),
    problem,
    verdict: json("VERDICT", null),
    push,
    patchFile: env("PATCH_FILE"),
    config: JSON.parse(env("CONFIG")),
    identity,
    pushToken: env("PUSH_TOKEN"),
    runUrl: `${env("GITHUB_SERVER_URL")}/${owner}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`,
    log: (message) => core.warning(message),
  });

  const summary = result.pushed
    ? `PR #${env("PR_NUMBER")}: pushed ${result.pushed.sha.slice(0, 7)}`
    : `PR #${env("PR_NUMBER")}: replied, nothing pushed${result.violations.length ? " (guardrail)" : ""}`;
  core.notice(summary);
  await core.summary.addHeading("@claude", 3).addRaw(summary).write();
}

module.exports = {
  MENTION_MARKER,
  MENTION_SCHEMA,
  MENTION,
  commentFrom,
  isAllowedBot,
  gateMention,
  mentionOutcome,
  renderReply,
  resetRetries,
  publishMention,
  acknowledge,
  stepGate,
  stepAck,
  stepPrepare,
  stepResult,
  stepReply,
};
