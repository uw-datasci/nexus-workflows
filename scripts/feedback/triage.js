"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, branchFor, ConfigError } = require("./config");
const { findMatches, normalizePath } = require("./globs");
const { pickAssignee } = require("./assign");
const {
  gate,
  collectContext,
  areaLabels,
  buildPrompt,
  labelNames,
  ROUTE_LABELS,
  RETRIAGE_LABEL,
} = require("./context");

/**
 * Feedback triage: the verdict schema the agent fills in, the deterministic rules that turn a
 * verdict into labels, and one function per workflow step (`step*`), so the workflow YAML stays
 * thin and the logic is testable.
 */

const COMMENT_MARKER = "<!-- nexus-feedback-triage -->";
const CONTEXT_DIR = ".feedback";
const SIZES = ["s", "m", "l"];
const MAX_LIKELY_FILES = 50;
const MISSING_ENV_QUESTION =
  "Which environment did you see this in? Add `env:prod` if it's on the live site, or `env:staging` if it's something shown from `dev` that isn't in production yet.";

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["route", "needs_info"] },
    question: { type: ["string", "null"] },
    route: { type: "string", enum: ["agent", "dev"] },
    size: { type: "string", enum: SIZES },
    area: { type: ["string", "null"] },
    likely_files: { type: "array", items: { type: "string" } },
    needs_new_dependency: { type: "boolean" },
    needs_schema_change: { type: "boolean" },
    needs_env_var: { type: "boolean" },
    expected_result_clear: { type: "boolean" },
    duplicate_of: { type: ["integer", "null"] },
    summary: { type: "string" },
    reason: { type: "string" },
  },
  required: [
    "decision",
    "route",
    "size",
    "likely_files",
    "needs_new_dependency",
    "needs_schema_change",
    "needs_env_var",
    "expected_result_clear",
    "summary",
    "reason",
  ],
  additionalProperties: false,
};

// ─── The checkout ────────────────────────────────────────────────────────────

const ENV_NAMES = { "env:prod": "production (the live site)", "env:staging": "staging" };

/**
 * The branch triage reads and what its prompt says about it. The issue's env label picks the
 * branch, the same one the fix works on, so triage never routes a change the fix can't find.
 * When the two branches differ, something missing from this branch most likely means the label
 * is wrong, so triage asks instead of guessing.
 */
function checkoutFor(config, environment) {
  const branch = branchFor(config, environment);
  if (!branch) return { branch: null, checkout: "the code in this checkout", missingRule: "" };

  const other = environment === "env:prod" ? "env:staging" : "env:prod";
  const otherBranch = branchFor(config, other);
  const checkout = `the code in this checkout: the \`${branch}\` branch, which ${ENV_NAMES[environment]} runs (the issue is labelled \`${environment}\`). A fix would be made on this branch`;
  const missingRule =
    otherBranch === branch
      ? ""
      : `\n   If what the issue describes (the page, component or text) isn't on \`${branch}\`, don't guess and don't route it: return \`decision: "needs_info"\` and ask whether they saw it on ${ENV_NAMES[other]}, for example "I can't find this on ${ENV_NAMES[environment]}. If you saw it on ${ENV_NAMES[other]}, the issue's \`${environment}\` label should be \`${other}\`."`;
  return { branch, checkout, missingRule };
}

// ─── Deciding ────────────────────────────────────────────────────────────────

const cleanText = (value, max = 1500) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * Turn the agent's verdict into the final outcome. The agent only suggests a route: it becomes
 * `agent` only if every eligibility rule holds; anything else goes to a developer.
 */
function decide(verdict, config, areas = []) {
  if (!verdict || typeof verdict !== "object" || !["route", "needs_info"].includes(verdict.decision)) {
    return {
      kind: "route",
      route: "dev",
      size: "m",
      area: null,
      likelyFiles: [],
      overrides: ["the triage agent didn't return a usable verdict"],
      summary: "",
      reason: "",
      duplicateOf: null,
    };
  }

  if (verdict.decision === "needs_info") {
    return {
      kind: "needs_info",
      question:
        cleanText(verdict.question, 800) ||
        "Could you describe what you expected to see, and on which page?",
    };
  }

  const likelyFiles = [
    ...new Set(
      (Array.isArray(verdict.likely_files) ? verdict.likely_files : [])
        .filter((f) => typeof f === "string" && f.trim())
        .map(normalizePath)
    ),
  ].slice(0, MAX_LIKELY_FILES);

  const areaName = typeof verdict.area === "string" ? verdict.area.trim().replace(/^area:/, "") : "";
  const area = areas.includes(areaName) ? areaName : null;
  const size = SIZES.includes(verdict.size) ? verdict.size : "m";

  const overrides = [];
  if (verdict.route === "agent") {
    const { agent } = config;
    if (!agent.enabled) overrides.push("the agent is turned off for this repo (`agent.enabled: false`)");
    if (likelyFiles.length === 0) overrides.push("no likely files were identified");
    if (likelyFiles.length > agent.max_files) {
      overrides.push(`it needs ${likelyFiles.length} files, more than \`max_files\` (${agent.max_files})`);
    }
    for (const { path: file, pattern } of findMatches(likelyFiles, agent.never_touch)) {
      overrides.push(`\`${file}\` is in \`never_touch\` (\`${pattern}\`)`);
    }
    if (verdict.needs_new_dependency !== false) overrides.push("it needs a new dependency");
    if (verdict.needs_schema_change !== false) overrides.push("it needs a database change");
    if (verdict.needs_env_var !== false) overrides.push("it needs a new environment variable");
    if (verdict.expected_result_clear !== true) overrides.push("the expected result isn't clear");
  }

  const duplicateOf = Number.isInteger(verdict.duplicate_of) && verdict.duplicate_of > 0 ? verdict.duplicate_of : null;

  return {
    kind: "route",
    route: verdict.route === "agent" && overrides.length === 0 ? "agent" : "dev",
    size,
    area,
    likelyFiles,
    overrides,
    summary: cleanText(verdict.summary),
    reason: cleanText(verdict.reason, 600),
    duplicateOf,
  };
}

// ─── Comment ─────────────────────────────────────────────────────────────────

/** Agent text comes from untrusted issue content: no pings, no hidden markup. */
function safe(text) {
  return String(text)
    .replace(/<!--|-->/g, "")
    .replace(/@(?=[A-Za-z0-9])/g, "@​")
    .trim();
}

const code = (text) => `\`${String(text).replace(/`/g, "'")}\``;

function renderComment(outcome, { assignee = null, duplicate = null } = {}) {
  if (outcome.kind === "needs_info") {
    return [
      COMMENT_MARKER,
      "**Triage: needs more information.**",
      "",
      safe(outcome.question),
      "",
      `<sub>Answer in a comment, then add the \`${RETRIAGE_LABEL}\` label to run triage again (from Discord, press **Answer**).</sub>`,
    ].join("\n");
  }

  const tags = [`route:${outcome.route}`, `size:${outcome.size}`];
  if (outcome.area) tags.push(`area:${outcome.area}`);

  const lines = [COMMENT_MARKER, `**Triage:** ${tags.map(code).join(" · ")}`, ""];
  if (outcome.summary) lines.push(`**What to change:** ${safe(outcome.summary)}`, "");
  lines.push(
    `**Likely files:** ${outcome.likelyFiles.length ? outcome.likelyFiles.map(code).join(", ") : "none identified"}`,
    ""
  );
  if (outcome.reason) {
    const heading = outcome.overrides.length > 0 ? "The triage agent suggested `route:agent` because" : "Why this route";
    lines.push(`**${heading}:** ${safe(outcome.reason)}`, "");
  }
  if (outcome.overrides.length > 0) {
    lines.push("**Sent to a developer because:**", ...outcome.overrides.map((o) => `- ${o}`), "");
  }
  if (assignee) {
    const note = assignee.failed ? " (couldn't assign automatically)" : "";
    lines.push(`**Assigned:** @${assignee.login}, ${assignee.reason}${note}`, "");
  }
  if (duplicate) {
    lines.push(
      duplicate.closed
        ? `**Duplicate of #${duplicate.number}.** Closing this one.`
        : `**Possible duplicate of #${duplicate.number}.** @${duplicate.lead}, please check.`,
      ""
    );
  }
  lines.push("<sub>Swap `route:agent` and `route:dev` to override this.</sub>");
  return lines.join("\n");
}

const NEEDS_INFO_HEADING = "**Triage: needs more information.**";

/** Triage's question, from its needs-info comment (renderComment's format), or null. */
function questionFrom(body) {
  const text = String(body ?? "");
  if (!text.includes(COMMENT_MARKER) || !text.includes(NEEDS_INFO_HEADING)) return null;
  const after = text.slice(text.indexOf(NEEDS_INFO_HEADING) + NEEDS_INFO_HEADING.length);
  const question = after.split("<sub>")[0].trim();
  return question || null;
}

// ─── Applying ────────────────────────────────────────────────────────────────

/** Create or update the one comment on the issue that carries `marker`. */
async function upsertComment(github, owner, repo, issueNumber, body, marker = COMMENT_MARKER) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(marker));
  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }
}

async function removeLabel(github, owner, repo, issueNumber, name) {
  try {
    await github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function addLabels(github, owner, repo, issueNumber, labels) {
  if (labels.length === 0) return;
  await github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
}

async function openFeedbackIssue(github, owner, repo, number) {
  try {
    const { data } = await github.rest.issues.get({ owner, repo, issue_number: number });
    const isFeedback = labelNames(data).includes("feedback");
    return !data.pull_request && data.state === "open" && isFeedback ? data : null;
  } catch {
    return null;
  }
}

/**
 * Apply a verdict to the issue. The route label goes on last, so the fix workflow it triggers
 * finds the comment and assignee already in place.
 */
async function applyTriage({ github, owner, repo, issueNumber, verdict, config, retriage = false, log = () => {} }) {
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  if (issue.state !== "open") return { skipped: "the issue is closed" };

  const current = labelNames(issue);
  if (!retriage && current.some((name) => ROUTE_LABELS.includes(name))) {
    return { skipped: "the issue is already triaged" };
  }

  const outcome = decide(verdict, config, await areaLabels(github, owner, repo));
  const keepRoute = outcome.kind === "route" ? `route:${outcome.route}` : null;
  // A re-triage that lands on the same route takes the label off and puts it back at the end, so
  // `route:agent` starts the fix workflow again (it ignores the App removing the label).
  const restartRoute = retriage && keepRoute !== null && current.includes(keepRoute);

  const stale = current.filter(
    (name) =>
      name.startsWith("size:") ||
      name.startsWith("area:") ||
      name === "needs-info" ||
      name === RETRIAGE_LABEL ||
      (ROUTE_LABELS.includes(name) && (name !== keepRoute || restartRoute))
  );
  for (const name of stale) await removeLabel(github, owner, repo, issueNumber, name);

  if (outcome.kind === "needs_info") {
    await addLabels(github, owner, repo, issueNumber, ["needs-info"]);
    await upsertComment(github, owner, repo, issueNumber, renderComment(outcome));
    return { outcome };
  }

  const assignee = await pickAssignee({
    route: outcome.route,
    area: outcome.area,
    likelyFiles: outcome.likelyFiles,
    config,
    github,
    owner,
    repo,
    issueNumber,
    log,
  });
  try {
    await github.rest.issues.addAssignees({ owner, repo, issue_number: issueNumber, assignees: [assignee.login] });
  } catch (error) {
    log(`Could not assign ${assignee.login}: ${error.message}`);
    assignee.failed = true;
  }

  let duplicate = null;
  if (outcome.duplicateOf && outcome.duplicateOf !== issueNumber) {
    const original = await openFeedbackIssue(github, owner, repo, outcome.duplicateOf);
    if (original) {
      duplicate = { number: original.number, lead: config.lead, closed: config.strictness === "relaxed" };
    }
  }

  await upsertComment(github, owner, repo, issueNumber, renderComment(outcome, { assignee, duplicate }));

  const extra = [`size:${outcome.size}`];
  if (outcome.area) extra.push(`area:${outcome.area}`);
  await addLabels(github, owner, repo, issueNumber, extra);

  if (duplicate?.closed) {
    // relaxed only: strict repos never close anything.
    await github.rest.issues.update({ owner, repo, issue_number: issueNumber, state: "closed", state_reason: "not_planned" });
    return { outcome, assignee, duplicate };
  }

  if (!current.includes(keepRoute) || restartRoute) await addLabels(github, owner, repo, issueNumber, [keepRoute]);
  return { outcome, assignee, duplicate };
}

// ─── Workflow steps ──────────────────────────────────────────────────────────

const repoOf = (context) => context.repo;
const issueNumberFrom = (context) => Number(process.env.ISSUE_NUMBER) || context.payload.issue?.number;
const isTrue = (value) => String(value).toLowerCase() === "true";

/** analyze: decide whether this event should be triaged. */
async function stepGate({ github, context, core }) {
  const { owner, repo } = repoOf(context);
  const issueNumber = issueNumberFrom(context);
  if (!issueNumber) {
    core.setOutput("run", "false");
    core.notice("No issue number in this event; nothing to triage.");
    return;
  }
  const result = await gate({ github, context, owner, repo, issueNumber, retriage: isTrue(process.env.RETRIAGE) });
  core.setOutput("run", String(result.run));
  core.setOutput("issue-number", String(issueNumber));
  core.setOutput("retriage", String(isTrue(process.env.RETRIAGE) || Boolean(result.retriage)));
  if (!result.run) core.notice(`Skipping triage for #${issueNumber}: ${result.reason}.`);
}

/** analyze: validate the config, collect the agent's inputs and build its prompt. */
async function stepPrepare({ github, context, core }) {
  const { owner, repo } = repoOf(context);
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  const workspace = process.env.GITHUB_WORKSPACE;
  const configPath = process.env.CONFIG_PATH;

  let config;
  try {
    config = loadConfig(path.join(workspace, CONTEXT_DIR, "config.raw.json"));
  } catch (error) {
    if (error instanceof ConfigError) {
      core.setFailed(`${configPath}: ${error.message}`);
      return;
    }
    throw error;
  }

  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const collected = await collectContext({
    github,
    owner,
    repo,
    issue,
    dir: path.join(workspace, CONTEXT_DIR),
    token: process.env.GITHUB_TOKEN,
    log: (message) => core.warning(message),
  });

  const { branch, checkout, missingRule } = checkoutFor(config, collected.environment);
  const template = fs.readFileSync(path.join(__dirname, "triage-prompt.md"), "utf8");
  const prompt = buildPrompt(template, {
    REPO: `${owner}/${repo}`,
    ISSUE_NUMBER: issueNumber,
    CONTEXT_DIR,
    CONFIG_PATH: configPath,
    CHECKOUT: checkout,
    MISSING_RULE: missingRule,
    MAX_FILES: config.agent.max_files,
    NEVER_TOUCH: config.agent.never_touch.length ? config.agent.never_touch.map(code).join(", ") : "(none)",
    SCREENSHOTS: collected.screenshots.length
      ? collected.screenshots.map((file) => code(path.relative(workspace, file))).join(", ")
      : "none",
  });

  core.setOutput("config", JSON.stringify(config));
  core.setOutput("environment", collected.environment ?? "");
  // The workflow checks this branch out before the agent runs (empty: no env label, no agent).
  core.setOutput("branch", branch ?? "");
  core.setOutput("prompt", prompt);
  core.setOutput("schema", JSON.stringify(VERDICT_SCHEMA));
}

/** analyze: the verdict handed to the apply job. */
function stepVerdict({ core }) {
  let verdict;
  if (!process.env.ENVIRONMENT) {
    verdict = { decision: "needs_info", question: MISSING_ENV_QUESTION };
  } else {
    try {
      verdict = process.env.STRUCTURED_OUTPUT ? JSON.parse(process.env.STRUCTURED_OUTPUT) : null;
    } catch {
      verdict = null;
    }
    if (!verdict) core.warning("The triage agent returned no verdict; the issue goes to a developer.");
  }
  core.setOutput("json", JSON.stringify(verdict));
}

/** apply: write the outcome to the issue with the App token. */
async function stepApply({ github, context, core }) {
  const { owner, repo } = repoOf(context);
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  const config = JSON.parse(process.env.CONFIG);
  const verdict = JSON.parse(process.env.VERDICT || "null");

  const result = await applyTriage({
    github,
    owner,
    repo,
    issueNumber,
    verdict,
    config,
    retriage: isTrue(process.env.RETRIAGE),
    log: (message) => core.warning(message),
  });

  if (result.skipped) {
    core.notice(`Not applied to #${issueNumber}: ${result.skipped}.`);
    return;
  }
  const { outcome, assignee } = result;
  const summary =
    outcome.kind === "needs_info"
      ? `#${issueNumber}: needs-info`
      : `#${issueNumber}: route:${outcome.route}, size:${outcome.size}${outcome.area ? `, area:${outcome.area}` : ""}, assigned ${assignee.login}`;
  core.notice(summary);
  await core.summary.addHeading("Feedback triage", 3).addRaw(summary).write();
}

module.exports = {
  VERDICT_SCHEMA,
  MISSING_ENV_QUESTION,
  COMMENT_MARKER,
  checkoutFor,
  decide,
  renderComment,
  questionFrom,
  applyTriage,
  stepGate,
  stepPrepare,
  stepVerdict,
  stepApply,
  // shared with the fix workflow
  safe,
  code,
  upsertComment,
  removeLabel,
  addLabels,
};
