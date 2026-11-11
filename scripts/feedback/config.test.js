"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseConfig, branchFor, ConfigError } = require("./config");

const CXC = {
  app: "cxc",
  strictness: "strict",
  branches: { production: "main", staging: "dev" },
  lead: "@patel-aaryan",
  dev_team: "cxc-dev",
  agent: {
    enabled: true,
    max_files: 5,
    never_touch: ["migrations/**", "lib/auth/**", "proxy.ts", "config/site.ts", ".github/**", "package.json", "pnpm-lock.yaml"],
  },
};

test("parses the cxc config", () => {
  const config = parseConfig(CXC);
  assert.equal(config.lead, "patel-aaryan");
  assert.equal(config.dev_team, "cxc-dev");
  assert.deepEqual(config.devs, []);
  assert.equal(config.agent.never_touch.length, 7);
});

test("fills in defaults", () => {
  const config = parseConfig({ app: "x", lead: "someone" });
  assert.equal(config.strictness, "strict");
  assert.deepEqual(config.branches, { production: "main", staging: "dev" });
  assert.equal(config.dev_team, "");
  assert.deepEqual(config.agent, { enabled: true, max_files: 5, never_touch: [] });
});

test("normalizes devs overrides", () => {
  const config = parseConfig({ app: "x", lead: "l", devs: [{ github: "@dev1", areas: ["area:landing", "auth"] }] });
  assert.deepEqual(config.devs, [{ github: "dev1", areas: ["landing", "auth"] }]);
});

test("reports every problem at once", () => {
  assert.throws(
    () => parseConfig({ strictness: "loose", agent: { max_files: 0, never_touch: "x" } }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 5);
      return true;
    }
  );
});

test("rejects an empty file", () => {
  assert.throws(() => parseConfig(null), ConfigError);
  assert.throws(() => parseConfig([]), ConfigError);
});

test("branchFor maps env labels to the configured branches", () => {
  const config = parseConfig(CXC);
  assert.equal(branchFor(config, "env:prod"), "main");
  assert.equal(branchFor(config, "env:staging"), "dev");
  assert.equal(branchFor(config, null), null);
  const custom = parseConfig({ ...CXC, branches: { production: "release", staging: "next" } });
  assert.equal(branchFor(custom, "env:staging"), "next");
});
