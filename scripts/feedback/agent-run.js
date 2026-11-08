"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { checkChanges, changedFiles } = require("./guardrail");
const { waitForTurn, workflowFileFromRef, parseWorkflowList } = require("./queue");

/**
 * What the fix and @claude workflows share around an agent run: the queue step, the tools the
 * agent may use, turning its work into a patch, and (in a job without the model) applying that
 * patch, checking the guardrail and pushing.
 */

const env = (name, fallback = "") => process.env[name] ?? fallback;
const json = (name, fallback) => {
  try {
    return JSON.parse(env(name)) ?? fallback;
  } catch {
    return fallback;
  }
};

// ─── Queue ───────────────────────────────────────────────────────────────────

/** queue job: wait until no earlier agent run in this repo is still going. */
async function stepWait({ github, context, core }) {
  const { owner, repo } = context.repo;
  const own = workflowFileFromRef(env("GITHUB_WORKFLOW_REF"));
  if (!own) core.warning(`Couldn't tell this workflow's file from ${env("GITHUB_WORKFLOW_REF")}; queueing on queue-workflows only.`);
  const minutes = Number(env("QUEUE_TIMEOUT_MINUTES", "90")) || 90;
  const result = await waitForTurn({
    github,
    owner,
    repo,
    workflows: [own, ...parseWorkflowList(env("QUEUE_WORKFLOWS"))].filter(Boolean),
    runId: Number(env("GITHUB_RUN_ID")),
    timeoutMs: minutes * 60_000,
    log: (message) => core.info(message),
  });
  core.setOutput("ready", String(result.ready));
  core.setOutput("reason", result.ready ? "" : `other agent runs in this repo were still going after ${minutes} minutes`);
}

// ─── The agent's sandbox ─────────────────────────────────────────────────────

const SAFE_COMMAND = /^[A-Za-z0-9 _.:/=@+-]+$/;

/** The agent edits files and runs only lint, typecheck and read-only git. */
function allowedTools({ lint, typecheck }) {
  for (const command of [lint, typecheck]) {
    if (!SAFE_COMMAND.test(command)) throw new Error(`Unsupported characters in command: ${command}`);
  }
  const bash = (command) => [`Bash(${command})`, `Bash(${command}:*)`];
  return [
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "MultiEdit",
    "Write",
    ...bash(lint),
    ...bash(typecheck),
    "Bash(git diff:*)",
    "Bash(git status:*)",
    "Bash(git log:*)",
  ].join(",");
}

/** Keep the agent's inputs and the scripts out of its patch. */
function excludeAgentFiles(workspace, contextDir = ".feedback") {
  const exclude = path.join(workspace, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `\n/${contextDir}/\n/.nexus-workflows/\n/.feedback-secrets.env\n`);
}

/** Why a run stopped early, read from the action's execution file. */
function limitReason({ executionFile, maxTurns, timeoutMinutes }) {
  let subtype = null;
  try {
    const turns = JSON.parse(fs.readFileSync(executionFile, "utf8"));
    subtype = [...turns].reverse().find((t) => t?.type === "result")?.subtype ?? null;
  } catch {
    subtype = null;
  }
  return subtype === "error_max_turns"
    ? `the agent hit its ${maxTurns}-turn limit`
    : `the agent stopped without finishing (it failed or hit the ${timeoutMinutes}-minute limit)`;
}

const parseVerdict = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

/**
 * Everything the agent changed, as a patch against the commit it started from (not HEAD, so the
 * patch is complete even if something committed). Returns the patch text.
 */
function makePatch({ cwd, startSha, outFile }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  git("add", "-A");
  const patch = git("diff", "--cached", "--binary", startSha);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, patch);
  return patch;
}

// ─── Applying and pushing (no model) ─────────────────────────────────────────

function gitRunner(cwd, token) {
  const auth = token
    ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]
    : [];
  return (args, { withAuth = false } = {}) =>
    execFileSync("git", [...(withAuth ? auth : []), ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
}

const errorText = (error) => String(error.stderr || error.message).trim().split("\n").slice(-3).join(" ");

/**
 * Apply the agent's patch on the commit it started from, check every file the branch changes
 * against `base` and only then commit and push (never forced). Nothing is pushed on a violation.
 *
 * @param {string[]} options.message - commit message paragraphs
 * @returns {{ files: string[], sha?: string, violations?: string[], error?: string }}
 */
function applyAndPush({ cwd, base, branch, patchFile, config, identity, pushToken, message }) {
  const git = gitRunner(cwd, pushToken);
  if (!patchFile || !fs.existsSync(patchFile) || !fs.readFileSync(patchFile, "utf8").trim()) {
    return { error: "the agent finished without changing any files", files: [] };
  }
  try {
    git(["apply", "--index", "--binary", "--whitespace=nowarn", patchFile]);
  } catch (error) {
    return { error: `the agent's changes couldn't be applied: ${errorText(error)}`, files: [] };
  }

  git(["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], { withAuth: true });
  const check = checkChanges({ files: changedFiles({ baseRef: `origin/${base}`, cwd }), config });
  if (check.violations.length > 0) return { violations: check.violations, files: check.files };

  git([
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "commit",
    "--no-verify",
    "--quiet",
    ...message.flatMap((paragraph) => ["-m", paragraph]),
  ]);
  try {
    git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { withAuth: true });
  } catch (error) {
    return {
      error: `pushing to \`${branch}\` was rejected, probably because someone pushed while the agent worked: ${errorText(error)}`,
      files: check.files,
    };
  }
  return { files: check.files, sha: git(["rev-parse", "HEAD"]).trim() };
}

/** Commit author for the App's bot user, so commits show up as the App. */
async function botIdentity(github, slug, log = () => {}) {
  let email = `${slug}[bot]@users.noreply.github.com`;
  try {
    const { data: user } = await github.rest.users.getByUsername({ username: `${slug}[bot]` });
    email = `${user.id}+${slug}[bot]@users.noreply.github.com`;
  } catch (error) {
    log(`Couldn't look up ${slug}[bot]: ${error.message}`);
  }
  return { name: `${slug}[bot]`, email };
}

module.exports = {
  env,
  json,
  stepWait,
  allowedTools,
  excludeAgentFiles,
  limitReason,
  parseVerdict,
  makePatch,
  gitRunner,
  errorText,
  applyAndPush,
  botIdentity,
};
