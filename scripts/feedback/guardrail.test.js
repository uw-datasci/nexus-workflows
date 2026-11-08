"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkChanges, changedFiles } = require("./guardrail");
const { parseConfig } = require("./config");
const { makeRepo } = require("./test-git");

const NEVER_TOUCH = ["migrations/**", "lib/auth/**", "proxy.ts", "config/site.ts", ".github/**", "package.json", "pnpm-lock.yaml"];
const config = (agent = {}) => parseConfig({ app: "cxc", lead: "lead", agent: { never_touch: NEVER_TOUCH, ...agent } });

test("a small change passes", () => {
  const result = checkChanges({ files: ["components/home/Footer.tsx", "./components/home/Footer.tsx"], config: config() });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.files, ["components/home/Footer.tsx"]);
});

test("never_touch matches, including nested file names", () => {
  const { violations } = checkChanges({
    files: ["proxy.ts", "apps/web/package.json", "lib/auth/session.ts", "src/lib/auth/ok.ts"],
    config: config(),
  });
  assert.equal(violations.length, 3);
  assert.match(violations.join("\n"), /`proxy\.ts`/);
  assert.match(violations.join("\n"), /`apps\/web\/package\.json` matches `never_touch` \(`package\.json`\)/);
  assert.doesNotMatch(violations.join("\n"), /src\/lib\/auth/);
});

test("workflow files are blocked even when never_touch is empty", () => {
  const { violations } = checkChanges({ files: [".github/workflows/ci.yml"], config: config({ never_touch: [] }) });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /workflow file/);
});

test("a workflow file is reported once, not also as never_touch", () => {
  const { violations } = checkChanges({ files: [".github/workflows/ci.yml"], config: config() });
  assert.equal(violations.length, 1);
});

test("more than max_files fails", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  assert.deepEqual(checkChanges({ files, config: config({ max_files: 3 }) }).violations, []);
  assert.match(checkChanges({ files, config: config({ max_files: 2 }) }).violations[0], /3 files, more than `max_files` \(2\)/);
});

test("changedFiles covers the whole branch, deletions and both sides of a rename", () => {
  const repo = makeRepo({ "lib/auth/session.ts": "secret\n", "components/a.ts": "a\n" });
  // An earlier commit on the branch...
  repo.write({ "components/a.ts": "a2\n" });
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "earlier");
  // ...plus staged changes: a rename out of lib/auth and a new file.
  repo.git("mv", "lib/auth/session.ts", "lib/session.ts");
  repo.write({ "components/b.ts": "b\n" });
  repo.git("add", "-A");

  const files = changedFiles({ baseRef: "origin/dev", cwd: repo.clone }).sort();
  assert.deepEqual(files, ["components/a.ts", "components/b.ts", "lib/auth/session.ts", "lib/session.ts"]);
  assert.match(checkChanges({ files, config: config() }).violations.join("\n"), /lib\/auth\/session\.ts/);
});
