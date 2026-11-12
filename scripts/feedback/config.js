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
 *   project: { number: 28, field: Status, statuses: { backlog: Backlog, agent: In Progress, dev: Todo } }
 */

class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid feedback config:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const PROJECT_STATUSES = { backlog: "Backlog", agent: "In Progress", dev: "Todo" };

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

  let project = null;
  if (raw.project != null) {
    const { number, field = "Status", statuses = {} } = raw.project;
    if (!Number.isInteger(number) || number < 1) problems.push("`project.number` must be the org project's number");
    if (!isNonEmptyString(field)) problems.push("`project.field` must be a field name");
    if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
      problems.push("`project.statuses` must map backlog, agent and dev to status names");
    } else {
      for (const key of Object.keys(statuses)) {
        if (!(key in PROJECT_STATUSES)) problems.push(`\`project.statuses.${key}\` isn't one of backlog, agent, dev`);
        else if (!isNonEmptyString(statuses[key])) problems.push(`\`project.statuses.${key}\` must be a status name`);
      }
      project = { number, field: String(field).trim(), statuses: { ...PROJECT_STATUSES } };
      for (const key of Object.keys(PROJECT_STATUSES)) {
        if (isNonEmptyString(statuses[key])) project.statuses[key] = statuses[key].trim();
      }
    }
  }

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
    project,
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


function branchFor(config, envLabel) {
  if (envLabel === "env:prod") return config.branches.production;
  if (envLabel === "env:staging") return config.branches.staging;
  return null;
}

module.exports = { parseConfig, loadConfig, branchFor, ConfigError };
