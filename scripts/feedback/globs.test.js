"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { matchingPattern, findMatches } = require("./globs");

const CXC = ["migrations/**", "lib/auth/**", "proxy.ts", "config/site.ts", ".github/**", "package.json", "pnpm-lock.yaml"];

test("cxc never_touch: blocked paths", () => {
  for (const path of [
    "migrations/20260812-role-hardening.js",
    "migrations/sqls/x-up.sql",
    "migrations",
    "lib/auth/guard.ts",
    "proxy.ts",
    "config/site.ts",
    ".github/workflows/quality-gate.yml",
    ".github/feedback.yml",
    "package.json",
    "pnpm-lock.yaml",
    "./proxy.ts",
    "/config/site.ts",
  ]) {
    assert.ok(matchingPattern(path, CXC), `${path} should be blocked`);
  }
});

test("cxc never_touch: allowed paths", () => {
  for (const path of [
    "app/page.tsx",
    "components/home/Footer.tsx",
    "lib/utils.ts",
    "src/lib/auth/guard.ts",
    "app/config/site.ts",
    "migrations-notes.md",
    "server/users/users.service.ts",
  ]) {
    assert.equal(matchingPattern(path, CXC), null, `${path} should be allowed`);
  }
});

test("patterns without a slash match the file name at any depth", () => {
  assert.equal(matchingPattern("apps/web/package.json", ["package.json"]), "package.json");
  assert.equal(matchingPattern("app/proxy.ts", ["proxy.ts"]), "proxy.ts");
  assert.equal(matchingPattern("deep/x/y.env", ["*.env"]), "*.env");
});

test("* stays within a directory, ** crosses directories, ? is one character", () => {
  assert.ok(matchingPattern("src/a.ts", ["src/*.ts"]));
  assert.equal(matchingPattern("src/b/c.ts", ["src/*.ts"]), null);
  assert.ok(matchingPattern("src/b/c.ts", ["src/**/*.ts"]));
  assert.ok(matchingPattern("src/c.ts", ["src/**/*.ts"]));
  assert.ok(matchingPattern("db/a1.sql", ["db/a?.sql"]));
  assert.equal(matchingPattern("db/a12.sql", ["db/a?.sql"]), null);
  assert.ok(matchingPattern("lib/auth/x.ts", ["lib/auth/"]));
});

test("dots and regex characters are literal", () => {
  assert.equal(matchingPattern("proxyXts", ["proxy.ts"]), null);
  assert.ok(matchingPattern("a+b(1).ts", ["a+b(1).ts"]));
});

test("findMatches lists every hit with its pattern", () => {
  assert.deepEqual(findMatches(["app/page.tsx", "proxy.ts", "lib/auth/server.ts"], CXC), [
    { path: "proxy.ts", pattern: "proxy.ts" },
    { path: "lib/auth/server.ts", pattern: "lib/auth/**" },
  ]);
});
