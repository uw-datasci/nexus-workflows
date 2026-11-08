"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readSecrets, parseEnvFile } = require("./secrets");

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----";

test("parses single- and multi-line values", () => {
  const values = parseEnvFile(`A='1'\nFEEDBACK_APP_PRIVATE_KEY='${PEM}'\nB='two words'`);
  assert.deepEqual(values, { A: "1", FEEDBACK_APP_PRIVATE_KEY: PEM, B: "two words" });
});

function fakeCore() {
  const outputs = {};
  const secrets = [];
  return { outputs, secrets, setOutput: (k, v) => (outputs[k] = v), setSecret: (v) => secrets.push(v) };
}

function writeEnvFile(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nf-")), ".env");
  fs.writeFileSync(file, content);
  return file;
}

test("outputs the first key that is set, masks it and deletes the file", () => {
  const file = writeEnvFile(`FEEDBACK_APP_ID='123'\nFEEDBACK_APP_PRIVATE_KEY='${PEM.replace(/\n/g, "\\n")}'\nOTHER='x'`);
  const core = fakeCore();
  readSecrets({
    file,
    core,
    outputs: { "client-id": ["FEEDBACK_APP_CLIENT_ID", "FEEDBACK_APP_ID"], "private-key": ["FEEDBACK_APP_PRIVATE_KEY"] },
  });
  assert.equal(core.outputs["client-id"], "123");
  assert.equal(core.outputs["private-key"], PEM, "literal \\n becomes a real line break");
  assert.ok(core.secrets.includes(PEM) && core.secrets.includes("abc"));
  assert.equal(core.outputs.OTHER, undefined);
  assert.equal(fs.existsSync(file), false);
});

test("fails clearly when a secret is missing, and still deletes the file", () => {
  const file = writeEnvFile("OTHER='x'");
  assert.throws(
    () => readSecrets({ file, core: fakeCore(), outputs: { key: ["FEEDBACK_ANTHROPIC_API_KEY"] } }),
    /FEEDBACK_ANTHROPIC_API_KEY/
  );
  assert.equal(fs.existsSync(file), false);
});
