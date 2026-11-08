"use strict";

/**
 * Who gets a feedback issue. Shared by triage and by the fix workflow's hand-off to a developer.
 *
 * - route:agent → the lead, who reviews the agent's PR.
 * - route:dev   → a `devs` override whose areas include the issue's area; otherwise the
 *                 `dev_team` member who most recently changed the likely files, skipping anyone
 *                 with OPEN_ISSUE_LIMIT or more open feedback issues; otherwise the lead.
 */

const OPEN_ISSUE_LIMIT = 3;
const MAX_FILES_TO_CHECK = 10;
const COMMITS_PER_FILE = 20;

async function teamMembers(github, org, teamSlug) {
  const members = await github.paginate(github.rest.teams.listMembersInOrg, {
    org,
    team_slug: teamSlug,
    per_page: 100,
  });
  return new Set(members.map((m) => m.login.toLowerCase()));
}

/** `{ login, date, path }` for recent commits to each file, newest first, one entry per login. */
async function recentAuthors(github, owner, repo, files) {
  const seen = [];
  for (const path of files.slice(0, MAX_FILES_TO_CHECK)) {
    const { data: commits } = await github.rest.repos.listCommits({
      owner,
      repo,
      path,
      per_page: COMMITS_PER_FILE,
    });
    for (const commit of commits) {
      const login = commit.author?.login;
      const date = commit.commit?.author?.date ?? commit.commit?.committer?.date;
      if (!login || !date || commit.author?.type === "Bot") continue;
      seen.push({ login, date, path });
    }
  }
  seen.sort((a, b) => b.date.localeCompare(a.date));

  const byLogin = new Map();
  for (const entry of seen) {
    const key = entry.login.toLowerCase();
    if (!byLogin.has(key)) byLogin.set(key, entry);
  }
  return [...byLogin.values()];
}

async function openFeedbackCount(github, owner, repo, login, excludeIssue) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    labels: "feedback",
    assignee: login,
    per_page: 100,
  });
  return issues.filter((i) => !i.pull_request && i.number !== excludeIssue).length;
}

/**
 * @returns {Promise<{ login: string, reason: string }>}
 */
async function pickAssignee({ route, area, likelyFiles = [], config, github, owner, repo, issueNumber, log = () => {} }) {
  const lead = { login: config.lead, reason: "the lead" };

  if (route === "agent") return { login: config.lead, reason: "the lead reviews the agent's PR" };

  if (area) {
    const override = config.devs.find((dev) => dev.areas.includes(area));
    if (override) return { login: override.github, reason: `owns \`area:${area}\`` };
  }

  if (!config.dev_team) return { ...lead, reason: "no `dev_team` is configured" };

  let members;
  try {
    members = await teamMembers(github, owner, config.dev_team);
  } catch (error) {
    log(`Could not list team ${config.dev_team}: ${error.message}`);
    return { ...lead, reason: `the \`${config.dev_team}\` team couldn't be read` };
  }

  let authors = [];
  if (likelyFiles.length > 0) {
    try {
      authors = await recentAuthors(github, owner, repo, likelyFiles);
    } catch (error) {
      log(`Could not read commit history: ${error.message}`);
    }
  }

  for (const author of authors) {
    if (!members.has(author.login.toLowerCase())) continue;
    const open = await openFeedbackCount(github, owner, repo, author.login, issueNumber);
    if (open >= OPEN_ISSUE_LIMIT) {
      log(`Skipping ${author.login}: ${open} open feedback issues`);
      continue;
    }
    return { login: author.login, reason: `most recently changed \`${author.path}\`` };
  }

  return {
    ...lead,
    reason:
      authors.length > 0
        ? `no free \`${config.dev_team}\` member has changed the likely files recently`
        : "no recent history for the likely files",
  };
}

module.exports = { pickAssignee, OPEN_ISSUE_LIMIT };
