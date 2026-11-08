"use strict";

/**
 * Path matching for `agent.never_touch` in `.github/feedback.yml`, shared by the feedback
 * workflows (triage, fix, @claude) so they all agree on what is off limits.
 *
 * Rules (close to .gitignore):
 * - A pattern without "/" matches the file name at any depth: "package.json" matches
 *   "package.json" and "apps/web/package.json".
 * - A pattern with "/" is anchored at the repo root: "lib/auth/**" matches "lib/auth/x.ts" but
 *   not "src/lib/auth/x.ts".
 * - "**" matches any number of path segments, "*" anything except "/", "?" one character.
 * - "dir/**" and "dir/" also match the directory path itself.
 *
 * When in doubt this errs towards matching, because a match only ever sends work to a person.
 */

function normalizePath(path) {
  return String(path).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function globToRegExp(pattern) {
  let p = normalizePath(pattern);
  if (p.endsWith("/")) p += "**";

  const anchored = p.includes("/");
  let body = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        const atEnd = i + 2 === p.length;
        const beforeSlash = p[i + 2] === "/";
        if (beforeSlash) {
          body += "(?:.*/)?"; // "**/" = zero or more directories
          i += 2;
        } else if (atEnd && body.endsWith("/")) {
          body = body.slice(0, -1) + "(?:/.*)?"; // "dir/**" also matches "dir"
          i += 1;
        } else {
          body += ".*";
          i += 1;
        }
      } else {
        body += "[^/]*";
      }
    } else if (ch === "?") {
      body += "[^/]";
    } else {
      body += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${body}$`);
}

/** The first pattern that matches `path`, or null. */
function matchingPattern(path, patterns = []) {
  const target = normalizePath(path);
  for (const pattern of patterns) {
    if (!pattern || !String(pattern).trim()) continue;
    if (globToRegExp(pattern).test(target)) return pattern;
  }
  return null;
}

/** Every `[path, pattern]` pair where a path hits a pattern. */
function findMatches(paths = [], patterns = []) {
  const hits = [];
  for (const path of paths) {
    const pattern = matchingPattern(path, patterns);
    if (pattern) hits.push({ path: normalizePath(path), pattern });
  }
  return hits;
}

module.exports = { globToRegExp, matchingPattern, findMatches, normalizePath };
