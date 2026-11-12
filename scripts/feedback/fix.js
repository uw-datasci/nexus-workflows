"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, branchFor, ConfigError } = require("./config");
const { pickAssignee } = require("./assign");
const { setProjectStatus } = require("./project");
const { failureExcerpt } = require("./ci-logs");
const { collectContext, buildPrompt, labelNames, hasLabel, envLabel } = require("./context");
const { COMMENT_MARKER: TRIAGE_MARKER, safe, code, upsertComment, removeLabel, addLabels } = require("./triage");
const {
  env,
  json,
  stepWait,
  allowedTools,
  excludeAgentFiles,
  limitReason,
  parseVerdict,
  makePatch,
  applyAndPush,
  botIdentity,
} = require("./agent-run");

/**
 * Feedback fix: when an issue gets `route:agent`, Claude makes the change and the workflow opens
 * a PR for a person to review. The workflow has four jobs (see feedback-fix.yml); this file has
 * the logic for each, as `step*` functions, so the YAML stays thin and the rules are testable.
 *
 * Modes (decided by `gateFix`):
 *   fix       route:agent was added: run the agent on the feedback branch
 *   retry     the PR's quality gate failed for the first time: run the agent again with the output
 *   handoff   give the issue to a developer without running the agent
 *   takeover  a person added route:dev: stop the agent and give the issue to a developer
 *   stop      a person removed route:agent: stop the agent
 *   skip      nothing to do
 */

const FIX_MARKER = "<!-- nexus-feedback-fix -->";
const PR_MARKER = /<!-- nexus-feedback-fix retries=(\d+) -->/;
const BRANCH_PREFIX = "feedback/";
const CONTEXT_DIR = ".feedback";
const MAX_CHANGES = 10;
const PR_TEMPLATES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
];

// Passed to the action inside single quotes, so no apostrophes anywhere in here.
const FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "changes", "reason"],
  properties: {
    status: {
      type: "string",
      enum: ["done", "gave_up"],
      description: "done: the change is made and lint and typecheck pass. gave_up: it can not be done within the rules.",
    },
    changes: {
      type: "array",
      items: { type: "string" },
      description: "What you changed, one short line each, for the PR description.",
    },
    reason: {
      type: "string",
      description: "If gave_up: why, in one or two sentences a developer can act on. If done: anything the reviewer should check, or an empty string.",
    },
  },
};

// ─── Names ───────────────────────────────────────────────────────────────────

function slugify(title, max = 40) {
  const slug = String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, max).replace(/-+$/, "") || "fix";
}

const branchName = (issueNumber, title) => `${BRANCH_PREFIX}${issueNumber}-${slugify(title)}`;

function issueFromBranch(branch) {
  const match = /^feedback\/(\d+)-/.exec(branch ?? "");
  return match ? Number(match[1]) : null;
}

const retriesFrom = (body) => Number(PR_MARKER.exec(body ?? "")?.[1] ?? 0);

/** Agent text goes into PRs and comments: one line, no pings, no hidden markup. */
const oneLine = (text, max = 300) => safe(String(text ?? "")).replace(/\s+/g, " ").slice(0, max);

// ─── GitHub lookups ──────────────────────────────────────────────────────────

/** An existing `feedback/<n>-*` branch, so a retry or a second try builds on earlier work. */
async function findFeedbackBranch(github, owner, repo, issueNumber) {
  const { data } = await github.rest.git.listMatchingRefs({ owner, repo, ref: `heads/${BRANCH_PREFIX}${issueNumber}-` });
  return data.map((ref) => ref.ref.replace(/^refs\/heads\//, "")).sort()[0] ?? null;
}

async function findOpenPr(github, owner, repo, branch) {
  const { data } = await github.rest.pulls.list({ owner, repo, state: "open", head: `${owner}:${branch}`, per_page: 10 });
  return data[0] ?? null;
}

async function triageComment(github, owner, repo, issueNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return comments.find((c) => c.body?.includes(TRIAGE_MARKER))?.body ?? null;
}

/** The "Likely files" line of the triage comment. */
function likelyFilesFrom(triageBody) {
  const line = (triageBody ?? "").split("\n").find((l) => l.startsWith("**Likely files:**"));
  return line ? [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [];
}

// ─── Gate ────────────────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {() => object} options.getConfig - loads feedback.yml; throws ConfigError
 * @returns {Promise<{ mode: string, reason: string, issueNumber?: number, base?: string,
 *   branch?: string, branchExists?: boolean, prNumber?: number, retries?: number, failedRunId?: number }>}
 */
async function gateFix({ github, context, owner, repo, getConfig }) {
  if (context.eventName === "issues") return gateIssueEvent({ github, context, owner, repo, getConfig });
  if (context.eventName === "workflow_run") return gateWorkflowRun({ github, context, owner, repo });
  return { mode: "skip", reason: `\`${context.eventName}\` events don't start the fix workflow` };
}

async function feedbackIssue(github, owner, repo, issueNumber) {
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  if (issue.pull_request) return { issue, problem: "this is a pull request" };
  if (issue.state !== "open") return { issue, problem: "the issue is closed" };
  if (!hasLabel(issue, "feedback")) return { issue, problem: "the issue has no `feedback` label" };
  return { issue, problem: null };
}

async function gateIssueEvent({ github, context, owner, repo, getConfig }) {
  const { action, label, sender } = context.payload;
  const name = label?.name;
  const skip = (reason, issueNumber) => ({ mode: "skip", reason, ...(issueNumber ? { issueNumber } : {}) });

  const starts = action === "labeled" && name === "route:agent";
  const takesOver = action === "labeled" && name === "route:dev";
  const stops = action === "unlabeled" && name === "route:agent";
  if (!starts && !takesOver && !stops) {
    return skip(`\`${action}\`${name ? ` \`${name}\`` : ""} doesn't affect the agent`);
  }
  // Triage and this workflow's own hand-off change route labels as the App. Those changes never
  // need a reaction here (triage already assigned someone); only a person's override does.
  if (!starts && sender?.type === "Bot") return skip(`${sender.login} changed \`${name}\`, not a person`);

  const issueNumber = context.payload.issue.number;
  const { issue, problem } = await feedbackIssue(github, owner, repo, issueNumber);
  if (problem) return skip(problem, issueNumber);
  const who = sender?.login ?? "someone";

  if (stops) {
    // Swapping labels by hand fires "removed route:agent" and "added route:dev". The second run
    // stops the agent and assigns a developer, so this one has nothing to add.
    if (hasLabel(issue, "route:dev")) return skip("`route:dev` is set, so that run handles it", issueNumber);
    return { mode: "stop", issueNumber, reason: `${who} removed \`route:agent\`` };
  }
  if (takesOver) return { mode: "takeover", issueNumber, reason: `${who} switched this issue to \`route:dev\`` };

  if (!hasLabel(issue, "route:agent")) return skip("`route:agent` was removed before this run started", issueNumber);
  const config = getConfig();
  if (!config.agent.enabled) {
    return { mode: "handoff", issueNumber, reason: "the agent is turned off for this repo (`agent.enabled: false`)" };
  }
  const env = envLabel(issue);
  if (!env) {
    return {
      mode: "handoff",
      issueNumber,
      reason: "the issue has no `env:prod` or `env:staging` label, so there's no branch to fix",
    };
  }

  const existing = await findFeedbackBranch(github, owner, repo, issueNumber);
  const branch = existing ?? branchName(issueNumber, issue.title);
  const pr = existing ? await findOpenPr(github, owner, repo, branch) : null;
  return {
    mode: "fix",
    reason: "",
    issueNumber,
    base: pr?.base.ref ?? branchFor(config, env),
    branch,
    branchExists: Boolean(existing),
    prNumber: pr?.number ?? 0,
    retries: 0,
  };
}

async function gateWorkflowRun({ github, context, owner, repo }) {
  const run = context.payload.workflow_run;
  const skip = (reason, issueNumber) => ({ mode: "skip", reason, ...(issueNumber ? { issueNumber } : {}) });

  if (context.payload.action !== "completed" || run?.conclusion !== "failure") {
    return skip(`the ${run?.name ?? "workflow"} run didn't fail (${run?.conclusion ?? context.payload.action})`);
  }
  if (run.head_repository?.full_name !== `${owner}/${repo}`) return skip("the run is for a fork");
  const issueNumber = issueFromBranch(run.head_branch);
  if (!issueNumber) return skip(`\`${run.head_branch}\` isn't a feedback branch`);

  const { issue, problem } = await feedbackIssue(github, owner, repo, issueNumber);
  if (problem) return skip(problem, issueNumber);
  if (!hasLabel(issue, "route:agent")) return skip("the issue is no longer `route:agent`", issueNumber);

  const pr = await findOpenPr(github, owner, repo, run.head_branch);
  if (!pr) return skip(`no open PR from \`${run.head_branch}\``, issueNumber);
  if (pr.head.sha !== run.head_sha) return skip("the PR has a newer commit, which gets its own run", issueNumber);

  const retries = retriesFrom(pr.body);
  const plan = {
    issueNumber,
    base: pr.base.ref,
    branch: run.head_branch,
    branchExists: true,
    prNumber: pr.number,
    retries,
    failedRunId: run.id,
  };
  if (retries >= 1) {
    return { mode: "handoff", ...plan, reason: `the quality gate failed again after the agent's retry ([run](${run.html_url}))` };
  }
  return { mode: "retry", ...plan, reason: `the quality gate failed ([run](${run.html_url}))` };
}

// ─── Agent ───────────────────────────────────────────────────────────────────

function situation({ mode, branchExists, branch, base }) {
  if (mode === "retry") {
    return [
      `This is a retry. Branch \`${branch}\` already has your earlier change (see \`git diff origin/${base}...HEAD\`) and its PR failed the quality gate.`,
      `The failure output is in \`${CONTEXT_DIR}/ci-failure.md\`. Fix what it reports and keep the original change working.`,
      "This is the last try: if it fails again, a developer takes over.",
    ].join(" ");
  }
  if (branchExists) {
    return `Branch \`${branch}\` already has earlier work on this issue (see \`git diff origin/${base}...HEAD\`). Build on it rather than starting over.`;
  }
  return `You are on a fresh branch from \`${base}\`.`;
}

/** What the agent run left behind, as a hand-off reason (empty if it finished). */
function agentOutcome({ outcome, structuredOutput, executionFile, hasPatch, maxTurns, timeoutMinutes }) {
  const verdict = parseVerdict(structuredOutput);
  if (outcome !== "success" || !verdict) return { reason: limitReason({ executionFile, maxTurns, timeoutMinutes }), verdict };
  if (verdict.status === "gave_up") {
    return { reason: `the agent gave up: ${oneLine(verdict.reason) || "no reason given"}`, verdict };
  }
  if (!hasPatch) return { reason: "the agent finished without changing any files", verdict };
  return { reason: "", verdict };
}

// ─── Publish ─────────────────────────────────────────────────────────────────

function prBody({ template, issueNumber, changes = [], notes = "", retries = 0 }) {
  const bullets = changes.slice(0, MAX_CHANGES).map((c) => oneLine(c)).filter(Boolean).map((c) => `- ${c}`);
  const list = bullets.length ? bullets.join("\n") : "- See the diff.";

  let body;
  if (template && template.trim()) {
    body = template.replace(/<!--[\s\S]*?-->/g, "").replace(/#?\[issue[-_ ]?number\]/gi, `#${issueNumber}`);
    const emptyBullet = /^[ \t]*-[ \t]*$/m;
    body = emptyBullet.test(body) ? body.replace(emptyBullet, () => list) : `${body.trimEnd()}\n\n## Changes made\n\n${list}`;
  } else {
    body = `## Changes made\n\n${list}`;
  }
  if (!new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, "i").test(body)) {
    body = `closes #${issueNumber}\n\n${body}`;
  }
  if (notes && oneLine(notes)) body += `\n\n**Note from the agent:** ${oneLine(notes)}`;
  body +=
    `\n\n---\n<sub>Opened by the feedback agent for #${issueNumber}. A person reviews and merges it; the agent never merges. ` +
    "Comment `@claude` on this PR to ask for changes, or switch the issue to `route:dev` to hand it to a developer.</sub>" +
    `\n\n<!-- nexus-feedback-fix retries=${retries} -->`;
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

function readTemplate(cwd) {
  for (const file of PR_TEMPLATES) {
    try {
      return fs.readFileSync(path.join(cwd, file), "utf8");
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * Apply the agent's patch, check the whole branch against the guardrail and only then commit,
 * push and open or update the PR. Runs with the App token and without the model.
 *
 * @returns {Promise<{ skipped?: string, handoff?: string[], files?: string[], pr?: object }>}
 */
async function publish({ github, owner, repo, cwd, plan, patchFile, agent, config, identity, pushToken, log = () => {} }) {
  const { issueNumber, base, branch } = plan;
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  if (issue.state !== "open" || !hasLabel(issue, "route:agent")) {
    return { skipped: "the issue is closed or no longer `route:agent`" };
  }

  const title = `Feedback #${issueNumber}: ${oneLine(issue.title, 100)}`;
  const pushed = applyAndPush({ cwd, base, branch, patchFile, config, identity, pushToken, message: [title, `Refs #${issueNumber}`] });
  if (pushed.violations) {
    return { handoff: ["Nothing was pushed, because the change breaks the agent's rules:", ...pushed.violations], files: pushed.files };
  }
  if (pushed.error) return { handoff: [pushed.error], files: pushed.files };

  const body = prBody({
    template: readTemplate(cwd),
    issueNumber,
    changes: agent.changes,
    notes: agent.notes,
    retries: plan.mode === "retry" ? plan.retries + 1 : 0,
  });
  let pr = plan.prNumber ? { number: plan.prNumber } : await findOpenPr(github, owner, repo, branch);
  let created = false;
  if (pr) {
    ({ data: pr } = await github.rest.pulls.update({ owner, repo, pull_number: pr.number, body }));
  } else {
    ({ data: pr } = await github.rest.pulls.create({ owner, repo, title, head: branch, base, body }));
    created = true;
    try {
      await github.rest.pulls.requestReviewers({ owner, repo, pull_number: pr.number, reviewers: [config.lead] });
    } catch (error) {
      log(`Could not request a review from ${config.lead}: ${error.message}`);
    }
  }

  if (hasLabel(issue, "route:dev")) await removeLabel(github, owner, repo, issueNumber, "route:dev");
  const verb = created ? "opened" : plan.mode === "retry" ? "updated after the quality gate failed" : "updated";
  await upsertComment(
    github,
    owner,
    repo,
    issueNumber,
    [
      FIX_MARKER,
      `**Agent PR ${verb}:** #${pr.number} into \`${base}\`, for ${config.lead} to review.`,
      "",
      "<sub>Comment `@claude` on the PR to ask for changes. Switch this issue to `route:dev` to hand it to a developer.</sub>",
    ].join("\n"),
    FIX_MARKER
  );
  const status = await setProjectStatus({ github, owner, issue, config, key: "review", log });
  return { pr: { number: pr.number, url: pr.html_url, created }, files: pushed.files, status };
}

// ─── Hand-off ────────────────────────────────────────────────────────────────

function renderHandoff({ reasons, assignee, prNumber, runUrl }) {
  const lines = [FIX_MARKER, "**Handed to a developer.**", ""];
  for (const reason of reasons) lines.push(reason.endsWith(":") ? oneLine(reason, 500) : `- ${oneLine(reason, 500)}`);
  lines.push("");
  if (prNumber) lines.push(`**Agent PR:** #${prNumber} is still open. Build on it or close it.`, "");
  if (assignee) {
    const note = assignee.failed ? " (couldn't assign automatically)" : "";
    lines.push(`**Assigned:** @${assignee.login}, ${assignee.reason}${note}`, "");
  }
  if (runUrl) lines.push(`[Workflow run](${runUrl})`, "");
  lines.push("<sub>Add `route:agent` again to give the agent another try.</sub>");
  return lines.join("\n");
}

/**
 * Give the issue to a developer: keep a developer who is already assigned, otherwise pick one
 * with the triage rules. The route labels change last.
 */
async function handoff({ github, owner, repo, issueNumber, config, mode, reasons, files = [], prNumber = 0, runUrl = "", log = () => {} }) {
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  if (issue.state !== "open") return { skipped: "the issue is closed" };
  if (mode !== "takeover" && !hasLabel(issue, "route:agent")) {
    return { skipped: "the issue is no longer `route:agent`" };
  }

  const lead = config.lead.toLowerCase();
  const current = (issue.assignees ?? []).map((a) => a.login);
  const developer = current.find((login) => login.toLowerCase() !== lead);
  let assignee;
  if (developer) {
    assignee = { login: developer, reason: "who was already assigned" };
  } else {
    const area = labelNames(issue).find((name) => name.startsWith("area:"))?.slice(5) ?? null;
    const likelyFiles = files.length ? files : likelyFilesFrom(await triageComment(github, owner, repo, issueNumber));
    assignee = await pickAssignee({ route: "dev", area, likelyFiles, config, github, owner, repo, issueNumber, log });
    try {
      await github.rest.issues.addAssignees({ owner, repo, issue_number: issueNumber, assignees: [assignee.login] });
    } catch (error) {
      log(`Could not assign ${assignee.login}: ${error.message}`);
      assignee.failed = true;
    }
    const leadLogin = current.find((login) => login.toLowerCase() === lead);
    if (leadLogin && assignee.login.toLowerCase() !== lead && !assignee.failed) {
      try {
        await github.rest.issues.removeAssignees({ owner, repo, issue_number: issueNumber, assignees: [leadLogin] });
      } catch (error) {
        log(`Could not unassign ${leadLogin}: ${error.message}`);
      }
    }
  }

  if (!prNumber) {
    const branch = await findFeedbackBranch(github, owner, repo, issueNumber);
    prNumber = branch ? (await findOpenPr(github, owner, repo, branch))?.number ?? 0 : 0;
  }
  await upsertComment(github, owner, repo, issueNumber, renderHandoff({ reasons, assignee, prNumber, runUrl }), FIX_MARKER);

  if (hasLabel(issue, "route:agent")) await removeLabel(github, owner, repo, issueNumber, "route:agent");
  if (!hasLabel(issue, "route:dev")) await addLabels(github, owner, repo, issueNumber, ["route:dev"]);
  const status = await setProjectStatus({ github, owner, issue, config, key: "dev", log });
  return { assignee, prNumber, status };
}

// ─── Workflow steps ──────────────────────────────────────────────────────────

/** gate: decide the mode and everything the later jobs need. */
async function stepGate({ github, context, core }) {
  const { owner, repo } = context.repo;
  const configFile = path.join(env("GITHUB_WORKSPACE"), CONTEXT_DIR, "config.raw.json");
  let config = null;
  const getConfig = () => (config ??= loadConfig(configFile));

  let result;
  try {
    result = await gateFix({ github, context, owner, repo, getConfig });
    if (!["skip", "stop"].includes(result.mode)) getConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      core.setFailed(`${env("CONFIG_PATH")}: ${error.message}`);
      return;
    }
    throw error;
  }

  core.setOutput("mode", result.mode);
  core.setOutput("reason", result.reason ?? "");
  core.setOutput("issue-number", String(result.issueNumber ?? 0));
  core.setOutput("base", result.base ?? "");
  core.setOutput("branch", result.branch ?? "");
  core.setOutput("branch-exists", String(Boolean(result.branchExists)));
  core.setOutput("pr-number", String(result.prNumber ?? 0));
  core.setOutput("retries", String(result.retries ?? 0));
  core.setOutput("failed-run-id", String(result.failedRunId ?? 0));
  core.setOutput("config", config ? JSON.stringify(config) : "");

  const target = result.issueNumber ? `#${result.issueNumber}` : "this event";
  core.notice(`Feedback fix for ${target}: ${result.mode}${result.reason ? ` (${result.reason})` : ""}`);
}

/** agent: collect what the agent reads and build its prompt. */
async function stepPrepare({ github, context, core }) {
  const { owner, repo } = context.repo;
  const workspace = env("GITHUB_WORKSPACE");
  const dir = path.join(workspace, CONTEXT_DIR);
  const config = JSON.parse(env("CONFIG"));
  const issueNumber = Number(env("ISSUE_NUMBER"));
  const mode = env("MODE");

  excludeAgentFiles(workspace, CONTEXT_DIR);

  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const collected = await collectContext({
    github,
    owner,
    repo,
    issue,
    dir,
    token: env("GITHUB_TOKEN"),
    log: (message) => core.warning(message),
  });
  fs.writeFileSync(path.join(dir, "triage.md"), (await triageComment(github, owner, repo, issueNumber)) ?? "(no triage comment)");
  if (mode === "retry") {
    const excerpt = await failureExcerpt({
      github,
      owner,
      repo,
      runId: Number(env("FAILED_RUN_ID")),
      log: (message) => core.warning(message),
    });
    fs.writeFileSync(path.join(dir, "ci-failure.md"), excerpt ?? "(no failed jobs found in the run)");
  }

  const lint = env("LINT_COMMAND");
  const typecheck = env("TYPECHECK_COMMAND");
  const base = env("BASE");
  const template = fs.readFileSync(path.join(__dirname, "fix-prompt.md"), "utf8");
  const prompt = buildPrompt(template, {
    REPO: `${owner}/${repo}`,
    ISSUE_NUMBER: issueNumber,
    CONTEXT_DIR,
    BASE: base,
    SITUATION: situation({ mode, branchExists: env("BRANCH_EXISTS") === "true", branch: env("BRANCH"), base }),
    MAX_FILES: config.agent.max_files,
    NEVER_TOUCH: config.agent.never_touch.length ? config.agent.never_touch.map(code).join(", ") : "(none)",
    LINT_COMMAND: lint,
    TYPECHECK_COMMAND: typecheck,
    SCREENSHOTS: collected.screenshots.length
      ? collected.screenshots.map((file) => code(path.relative(workspace, file))).join(", ")
      : "none",
  });

  core.setOutput("prompt", prompt);
  core.setOutput("schema", JSON.stringify(FIX_SCHEMA));
  core.setOutput("allowed-tools", allowedTools({ lint, typecheck }));
}

/** agent: turn the agent's work into a patch file and a result for the next jobs. */
function stepResult({ core }) {
  const patch = makePatch({
    cwd: env("GITHUB_WORKSPACE"),
    startSha: env("START_SHA"),
    outFile: path.join(env("RUNNER_TEMP"), "feedback-fix", "changes.patch"),
  });

  const { reason, verdict } = agentOutcome({
    outcome: env("AGENT_OUTCOME"),
    structuredOutput: env("STRUCTURED_OUTPUT"),
    executionFile: env("EXECUTION_FILE"),
    hasPatch: patch.trim() !== "",
    maxTurns: env("MAX_TURNS"),
    timeoutMinutes: env("TIMEOUT_MINUTES"),
  });
  core.setOutput("handoff-reason", reason);
  core.setOutput("has-patch", String(!reason));
  core.setOutput("changes", JSON.stringify(Array.isArray(verdict?.changes) ? verdict.changes : []));
  core.setOutput("notes", verdict?.status === "done" ? String(verdict.reason ?? "") : "");
  if (reason) core.warning(`Handing off: ${reason}`);
}

/** publish: guardrail, commit, push and PR, with the App token. */
async function stepPublish({ github, context, core }) {
  const { owner, repo } = context.repo;
  const identity = await botIdentity(github, env("APP_SLUG"), (message) => core.warning(message));

  const result = await publish({
    github,
    owner,
    repo,
    cwd: env("GITHUB_WORKSPACE"),
    plan: {
      mode: env("MODE"),
      issueNumber: Number(env("ISSUE_NUMBER")),
      base: env("BASE"),
      branch: env("BRANCH"),
      prNumber: Number(env("PR_NUMBER", "0")),
      retries: Number(env("RETRIES", "0")),
    },
    patchFile: env("PATCH_FILE"),
    agent: { changes: json("CHANGES", []), notes: env("NOTES") },
    config: JSON.parse(env("CONFIG")),
    identity,
    pushToken: env("PUSH_TOKEN"),
    log: (message) => core.warning(message),
  });

  core.setOutput("files", JSON.stringify(result.files ?? []));
  core.setOutput("handoff-reasons", result.handoff ? JSON.stringify(result.handoff) : "");
  core.setOutput("pr-number", String(result.pr?.number ?? 0));
  if (result.skipped) core.notice(`Nothing published: ${result.skipped}.`);
  else if (result.handoff) core.warning(`Not published: ${result.handoff.join(" ")}`);
  else {
    const summary = `#${env("ISSUE_NUMBER")}: PR #${result.pr.number} ${result.pr.created ? "opened" : "updated"} (${result.pr.url})`;
    core.notice(summary);
    await core.summary.addHeading("Feedback fix", 3).addRaw(summary).write();
  }
}

/** handoff: collect the reasons from the earlier jobs and give the issue to a developer. */
async function stepHandoff({ github, context, core }) {
  const { owner, repo } = context.repo;
  const mode = env("MODE");
  const reasons = [];
  if (mode === "handoff" || mode === "takeover") {
    reasons.push(env("GATE_REASON"));
  } else if (env("QUEUE_REASON")) {
    reasons.push(env("QUEUE_REASON"));
  } else if (env("QUEUE_RESULT") === "failure") {
    reasons.push("waiting for other agent runs failed; see the workflow run");
  } else if (env("AGENT_REASON")) {
    reasons.push(env("AGENT_REASON"));
  } else if (env("AGENT_RESULT") === "failure") {
    reasons.push("the agent job failed; see the workflow run");
  } else if (env("PUBLISH_REASONS")) {
    reasons.push(...json("PUBLISH_REASONS", []));
  } else if (env("PUBLISH_RESULT") === "failure") {
    reasons.push("opening the PR failed; see the workflow run");
  }
  if (reasons.length === 0) {
    core.notice("Nothing to hand off.");
    return;
  }

  const issueNumber = Number(env("ISSUE_NUMBER"));
  const result = await handoff({
    github,
    owner,
    repo,
    issueNumber,
    config: JSON.parse(env("CONFIG")),
    mode,
    reasons,
    files: json("FILES", []),
    prNumber: Number(env("PR_NUMBER", "0")),
    runUrl: `${env("GITHUB_SERVER_URL")}/${owner}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`,
    log: (message) => core.warning(message),
  });
  if (result.skipped) {
    core.notice(`Not handed off: ${result.skipped}.`);
    return;
  }
  const summary = `#${issueNumber}: handed to ${result.assignee.login} (${reasons.join(" ")})`;
  core.notice(summary);
  await core.summary.addHeading("Feedback fix", 3).addRaw(summary).write();
}

module.exports = {
  FIX_SCHEMA,
  FIX_MARKER,
  PR_MARKER,
  BRANCH_PREFIX,
  slugify,
  branchName,
  issueFromBranch,
  retriesFrom,
  likelyFilesFrom,
  gateFix,
  allowedTools,
  situation,
  agentOutcome,
  prBody,
  publish,
  handoff,
  renderHandoff,
  stepGate,
  stepWait,
  stepPrepare,
  stepResult,
  stepPublish,
  stepHandoff,
};
