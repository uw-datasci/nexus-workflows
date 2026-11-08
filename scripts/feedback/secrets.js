"use strict";

const fs = require("node:fs");

/**
 * Infisical's secrets-action can export every secret in a folder as environment variables, which
 * would hand all of them (including the App private key) to every later step, the agent step
 * included. Instead the workflows export to a file, pick out only the keys a job needs as masked
 * step outputs, and delete the file straight away.
 *
 * The file has one `KEY='value'` per secret; multi-line values (private keys) span lines.
 */

function parseEnvFile(text) {
  const values = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)='(.*)$/.exec(lines[i]);
    if (!match) continue;
    const [, key, first] = match;
    let value = first;
    while (!value.endsWith("'") && i + 1 < lines.length) {
      i += 1;
      value += `\n${lines[i]}`;
    }
    values[key] = value.endsWith("'") ? value.slice(0, -1) : value;
  }
  return values;
}

/** Private keys pasted with literal "\n" sequences become real PEM line breaks. */
function normalizeValue(key, value) {
  if (/PRIVATE_KEY$/.test(key) && !value.includes("\n") && value.includes("\\n")) {
    return value.replace(/\\n/g, "\n");
  }
  return value;
}

/**
 * @param {object} options
 * @param {string} options.file - path of the exported .env file (deleted afterwards)
 * @param {Record<string, string[]>} options.outputs - output name → candidate keys (first set wins)
 * @param {object} options.core - @actions/core
 */
function readSecrets({ file, outputs, core }) {
  let values = {};
  try {
    values = parseEnvFile(fs.readFileSync(file, "utf8"));
  } finally {
    fs.rmSync(file, { force: true });
  }

  const missing = [];
  for (const [output, candidates] of Object.entries(outputs)) {
    const key = candidates.find((k) => values[k]);
    if (!key) {
      missing.push(candidates.join(" or "));
      continue;
    }
    const value = normalizeValue(key, values[key]);
    core.setSecret(value);
    for (const line of value.split("\n")) if (line.trim()) core.setSecret(line);
    core.setOutput(output, value);
  }

  if (missing.length > 0) {
    throw new Error(`Missing secrets in Infisical: ${missing.join(", ")}`);
  }
}

module.exports = { readSecrets, parseEnvFile };
