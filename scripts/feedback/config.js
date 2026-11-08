"use strict";

const fs = require("node:fs");

/**
 * `.github/feedback.yml`, after the workflow converts it to JSON with `yq -o=json`.
 *
 *   app: cxc
 *   strictness: strict          # strict | relaxed
 *   branches: { production: main, staging: dev }
 *   lead: <github handle>
 *   dev_team: cxc-dev           # empty = every dev issue goes to the lead
 *   devs: [{ github: <handle>, areas: [landing, auth] }]
 *   agent: { enabled: true, max_files: 5, never_touch: [...] }
 */

class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid feedback config:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const handle = (value) => String(value).trim().replace(/^@/, "");
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

function parseConfig(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(["the file is empty or not a YAML mapping"]);
  }

  if (!isNonEmptyString(raw.app)) problems.push("`app` is required");
  if (!isNonEmptyString(raw.lead)) problems.push("`lead` (a GitHub handle) is required");

  const strictness = raw.strictness ?? "strict";
  if (!["strict", "relaxed"].includes(strictness)) {
    problems.push("`strictness` must be `strict` or `relaxed`");
  }

  const branches = { production: "main", staging: "dev", ...(raw.branches ?? {}) };
  for (const key of ["production", "staging"]) {
    if (!isNonEmptyString(branches[key])) problems.push(`\`branches.${key}\` must be a branch name`);
  }

  if (raw.dev_team != null && typeof raw.dev_team !== "string") {
    problems.push("`dev_team` must be a team slug or empty");
  }

  const devs = raw.devs ?? [];
  if (!Array.isArray(devs)) {
    problems.push("`devs` must be a list");
  } else {
    devs.forEach((dev, i) => {
      if (!dev || !isNonEmptyString(dev.github)) problems.push(`\`devs[${i}].github\` is required`);
      if (dev && dev.areas != null && !Array.isArray(dev.areas)) {
        problems.push(`\`devs[${i}].areas\` must be a list`);
      }
    });
  }

  const agent = { enabled: true, max_files: 5, never_touch: [], ...(raw.agent ?? {}) };
  if (typeof agent.enabled !== "boolean") problems.push("`agent.enabled` must be true or false");
  if (!Number.isInteger(agent.max_files) || agent.max_files < 1) {
    problems.push("`agent.max_files` must be a whole number of at least 1");
  }
  if (!Array.isArray(agent.never_touch)) problems.push("`agent.never_touch` must be a list");

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    app: raw.app.trim(),
    strictness,
    branches: { production: branches.production.trim(), staging: branches.staging.trim() },
    lead: handle(raw.lead),
    dev_team: (raw.dev_team ?? "").trim(),
    devs: devs.map((dev) => ({
      github: handle(dev.github),
      areas: (dev.areas ?? []).map((area) => String(area).trim().replace(/^area:/, "")),
    })),
    agent: {
      enabled: agent.enabled,
      max_files: agent.max_files,
      never_touch: agent.never_touch.map(String),
    },
  };
}

function loadConfig(jsonPath) {
  let text;
  try {
    text = fs.readFileSync(jsonPath, "utf8");
  } catch {
    throw new ConfigError([`could not read ${jsonPath}`]);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(["the file is not valid YAML"]);
  }
  return parseConfig(raw);
}

module.exports = { parseConfig, loadConfig, ConfigError };
