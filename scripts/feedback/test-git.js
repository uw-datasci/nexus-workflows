"use strict";

/**
 * Throwaway git repos for the tests: a bare "origin" with a `dev` branch and a clone of it, so the
 * guardrail and publish run against real git rather than a fake.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Ignore the machine's git config (signing, hooks, default branch), here and in the code under test.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];

function run(cwd, ...args) {
  return execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeFiles(dir, files) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    if (content === null) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/** origin (bare) + a clone on `dev`, both seeded with `files`. */
function makeRepo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nf-git-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const clone = path.join(root, "clone");

  run(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  run(root, "init", "--quiet", "--initial-branch=main", seed);
  writeFiles(seed, { "README.md": "app\n", ...files });
  run(seed, "add", "-A");
  run(seed, "commit", "--quiet", "-m", "init");
  run(seed, "branch", "dev");
  run(seed, "remote", "add", "origin", origin);
  run(seed, "push", "--quiet", "origin", "main", "dev");
  run(root, "clone", "--quiet", "--branch", "dev", origin, clone);

  return {
    root,
    origin,
    clone,
    git: (...args) => run(clone, ...args),
    write: (changes) => writeFiles(clone, changes),
    head: () => run(clone, "rev-parse", "HEAD").trim(),
    /** A patch of `changes` on top of the clone's HEAD, the way the agent job makes one. */
    patch(changes) {
      writeFiles(clone, changes);
      run(clone, "add", "-A");
      const text = run(clone, "diff", "--cached", "--binary", "HEAD");
      run(clone, "reset", "--quiet", "--hard", "HEAD");
      run(clone, "clean", "-fdq");
      const file = path.join(root, `patch-${Date.now()}-${Math.random()}.patch`);
      fs.writeFileSync(file, text);
      return file;
    },
    /** Files of `branch` on origin. */
    show: (branch, file) => run(origin, "show", `${branch}:${file}`),
    branches: () => run(origin, "branch", "--format=%(refname:short)").split("\n").filter(Boolean),
  };
}

module.exports = { makeRepo };
