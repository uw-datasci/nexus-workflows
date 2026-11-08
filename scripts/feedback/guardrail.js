"use strict";

const { execFileSync } = require("node:child_process");
const { findMatches, normalizePath } = require("./globs");

/**
 * The check every agent change must pass before it is pushed, shared by the fix and @claude
 * workflows. It looks at the whole branch (everything that differs from the base), not just the
 * latest change, so a series of small pushes can't add up to more than the rules allow.
 */

// Blocked whatever feedback.yml says. The App token has no `workflows` permission either.
const ALWAYS_BLOCKED = [".github/workflows/**"];

/**
 * @param {object} options
 * @param {string[]} options.files - every path the branch changes (added, edited, deleted, renamed)
 * @param {object} options.config - parsed feedback config
 * @returns {{ files: string[], violations: string[] }}
 */
function checkChanges({ files, config }) {
  const unique = [...new Set(files.map(normalizePath).filter(Boolean))].sort();
  const violations = [];

  const workflowFiles = findMatches(unique, ALWAYS_BLOCKED);
  for (const { path } of workflowFiles) {
    violations.push(`\`${path}\` is a workflow file, which the agent may never change`);
  }
  const blocked = new Set(workflowFiles.map((hit) => hit.path));
  for (const { path, pattern } of findMatches(unique, config.agent.never_touch)) {
    if (!blocked.has(path)) violations.push(`\`${path}\` matches \`never_touch\` (\`${pattern}\`)`);
  }

  const max = config.agent.max_files;
  if (unique.length > max) {
    violations.push(`the branch changes ${unique.length} files, more than \`max_files\` (${max})`);
  }

  return { files: unique, violations };
}

/**
 * Paths that the index (HEAD plus staged changes) changes compared with where it forked from
 * `baseRef`. Renames count as a delete plus an add, so moving a file out of a never_touch folder
 * is caught too.
 */
function changedFiles({ baseRef, cwd }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const mergeBase = git("merge-base", baseRef, "HEAD").trim();
  return git("diff", "--cached", "--name-only", "--no-renames", "-z", mergeBase)
    .split("\0")
    .filter(Boolean);
}

module.exports = { checkChanges, changedFiles, ALWAYS_BLOCKED };
