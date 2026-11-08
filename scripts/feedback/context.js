"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * The "should this run?" check and everything the triage agent reads, written to a folder in the
 * workspace (the agent only has Read/Glob/Grep, so it gets files rather than API access).
 */

const MAX_SCREENSHOTS = 10;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_OPEN_ISSUES = 100;
const ROUTE_LABELS = ["route:agent", "route:dev"];
const ENV_LABELS = ["env:prod", "env:staging"];
const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const labelNames = (issue) => (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
const hasLabel = (issue, name) => labelNames(issue).includes(name);
const envLabel = (issue) => ENV_LABELS.find((name) => hasLabel(issue, name)) ?? null;

/**
 * Decide whether triage should run for this event. Issues created with labels fire both `opened`
 * and `labeled`, so only `labeled` (with the `feedback` label) counts; `opened` is skipped.
 * Other events (manual or dispatched re-triage) run whenever the issue carries `feedback`.
 */
async function gate({ github, context, owner, repo, issueNumber, retriage = false }) {
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const skip = (reason) => ({ run: false, reason, issue });

  if (issue.pull_request) return skip("this is a pull request");
  if (issue.state !== "open") return skip("the issue is closed");
  if (!hasLabel(issue, "feedback")) return skip("the issue has no `feedback` label");

  if (context.eventName === "issues" && !retriage) {
    const action = context.payload.action;
    if (action === "opened") return skip("`opened` is handled by the matching `labeled` event");
    if (action !== "labeled" || context.payload.label?.name !== "feedback") {
      return skip(`\`${action}\` events other than adding \`feedback\` don't trigger triage`);
    }
  }

  if (!retriage && ROUTE_LABELS.some((name) => hasLabel(issue, name))) {
    return skip("the issue is already triaged");
  }

  return { run: true, reason: "", issue };
}

/** Image URLs from markdown `![..](url)` and HTML `<img src>`, in order, without duplicates. */
function extractImageUrls(body, limit = MAX_SCREENSHOTS) {
  const text = body ?? "";
  const found = [];
  const patterns = [/!\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g, /<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi];
  const matches = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) matches.push({ index: match.index, url: match[1] });
  }
  matches.sort((a, b) => a.index - b.index);
  for (const { url } of matches) {
    if (!found.includes(url)) found.push(url);
    if (found.length >= limit) break;
  }
  return found;
}

const isGitHubHost = (url) => {
  const { hostname } = new URL(url);
  return hostname === "github.com" || hostname.endsWith(".githubusercontent.com");
};

async function downloadImage(url, token) {
  const headers = { "User-Agent": "nexus-feedback-triage" };
  if (token && isGitHubHost(url)) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const extension = IMAGE_EXTENSIONS[type];
  if (!extension) throw new Error(`not a supported image (${type || "no content type"})`);

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_SCREENSHOT_BYTES) throw new Error("larger than 5 MB");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error("larger than 5 MB");
  return { bytes, extension };
}

/**
 * Write the agent's inputs to `dir`:
 *   issue.json, screenshots/NN.ext, open-feedback-issues.json, area-labels.json
 */
async function collectContext({ github, owner, repo, issue, dir, token, log = () => {} }) {
  fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });

  const environment = envLabel(issue);
  fs.writeFileSync(
    path.join(dir, "issue.json"),
    JSON.stringify(
      {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        labels: labelNames(issue),
        author: issue.user?.login ?? null,
        url: issue.html_url,
        environment,
      },
      null,
      2
    )
  );

  const screenshots = [];
  for (const [i, url] of extractImageUrls(issue.body).entries()) {
    try {
      const { bytes, extension } = await downloadImage(url, token);
      const file = path.join(dir, "screenshots", `${String(i + 1).padStart(2, "0")}.${extension}`);
      fs.writeFileSync(file, bytes);
      screenshots.push(file);
    } catch (error) {
      log(`Skipped screenshot ${url}: ${error.message}`);
    }
  }

  const openIssues = (
    await github.paginate(github.rest.issues.listForRepo, {
      owner,
      repo,
      state: "open",
      labels: "feedback",
      per_page: 100,
    })
  )
    .filter((i) => !i.pull_request && i.number !== issue.number)
    .slice(0, MAX_OPEN_ISSUES)
    .map((i) => ({ number: i.number, title: i.title }));
  fs.writeFileSync(path.join(dir, "open-feedback-issues.json"), JSON.stringify(openIssues, null, 2));

  const areas = await areaLabels(github, owner, repo);
  fs.writeFileSync(path.join(dir, "area-labels.json"), JSON.stringify(areas, null, 2));

  return { environment, screenshots, openIssues, areas };
}

/** The repo's `area:*` labels, without the prefix. */
async function areaLabels(github, owner, repo) {
  const labels = await github.paginate(github.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
  return labels.map((l) => l.name).filter((name) => name.startsWith("area:")).map((name) => name.slice(5));
}

/** Fill the prompt template's {{PLACEHOLDERS}}. */
function buildPrompt(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
}

module.exports = {
  gate,
  collectContext,
  extractImageUrls,
  areaLabels,
  buildPrompt,
  labelNames,
  hasLabel,
  envLabel,
  ROUTE_LABELS,
  ENV_LABELS,
};
