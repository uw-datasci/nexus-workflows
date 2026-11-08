"use strict";

const path = require("node:path");
const { loadConfig } = require("./config");
const { issueFromBranch, BRANCH_PREFIX } = require("./fix");
const { questionFrom, safe, COMMENT_MARKER } = require("./triage");

/**
 * Feedback updates in Discord: when a feedback issue's fix has a preview, goes live, reaches
 * staging, or triage needs more information, reply to the issue's Discord card (found through
 * the hidden `nexus-feedback` block nexus-bot puts in the issue). Issues without the block, such
 * as hand-written ones, are skipped. One function per workflow step (`step*`); see
 * feedback-notify.yml. Spec: Feedback loop §6.
 *
 * The buttons are handled by nexus-bot's feedback module. Their custom_ids are a contract with it:
 *   fb:good:<owner/repo>:<pr>:<issue>    Looks good        (comments on the PR)
 *   fb:again:<owner/repo>:<pr>:<issue>   Still not right   (@claude / the dev, or reopen + retriage)
 *   fb:answer:<owner/repo>:<issue>       Answer            (comments on the issue + retriage)
 */

const BLOCK = /<!-- nexus-feedback (\{[^<>]*?\}) -->/g;
const SNOWFLAKE = /^\d{17,20}$/;
const CUSTOM_ID_MAX = 100;
const DISCORD_API = "https://discord.com/api/v10";
const SUPPRESS_EMBEDS = 1 << 2;
const CONTEXT_DIR = ".feedback";
const MAX_TITLE = 150;

const BUTTON = { primary: 1, secondary: 2, success: 3, link: 5 };

/** The card a feedback issue came from: the last hidden block in its body, or null. */
function parseFeedbackBlock(body) {
  const matches = [...String(body ?? "").matchAll(BLOCK)];
  const last = matches.at(-1);
  if (!last) return null;
  let data;
  try {
    data = JSON.parse(last[1]);
  } catch {
    return null;
  }
  const ids = ["guild", "channel", "message", "user"].map((key) => data?.[key]);
  if (!ids.every((id) => typeof id === "string" && SNOWFLAKE.test(id))) return null;
  const [guild, channel, message, user] = ids;
  return { guild, channel, message, user };
}

const isPreview = (environment) => /^preview\b/i.test(environment ?? "");
const isProduction = (environment) => /^production\b/i.test(environment ?? "");

/** Feedback PRs (same repo, `feedback/<issue>-…` branch) that contain this commit. */
async function feedbackPrsFor(github, owner, repo, sha) {
  const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha });
  return data.filter(
    (pr) => pr.head?.ref?.startsWith(BRANCH_PREFIX) && (!pr.head.repo || pr.head.repo.full_name === `${owner}/${repo}`)
  );
}

/**
 * What to post for this event, if anything.
 * @returns {Promise<{ mode: "skip", reason: string } | { mode: "post", kind: string, issueNumber: number,
 *   prNumber?: number, prUrl?: string, url?: string | null }>}
 */
async function planEvent({ github, context, owner, repo, config, stagingUrl, productionUrl }) {
  const { eventName, payload } = context;
  const skip = (reason) => ({ mode: "skip", reason });

  if (eventName === "deployment_status") {
    const status = payload.deployment_status ?? {};
    const deployment = payload.deployment ?? {};
    if (status.state !== "success") return skip(`the deployment is \`${status.state}\`, not \`success\``);
    const environment = status.environment ?? deployment.environment;
    const url = status.environment_url || status.target_url || null;
    if (!isPreview(environment) && !isProduction(environment)) {
      return skip(`\`${environment}\` isn't a Preview or Production deployment`);
    }
    const prs = await feedbackPrsFor(github, owner, repo, deployment.sha);

    if (isPreview(environment)) {
      // Only the PR's latest commit: an older deployment finishing late isn't worth a message.
      const pr = prs.find((p) => p.state === "open" && p.head.sha === deployment.sha);
      if (!pr) return skip("no open feedback PR has this commit as its head");
      if (!url) return skip("the deployment has no URL");
      return { mode: "post", kind: "preview", issueNumber: issueFromBranch(pr.head.ref), prNumber: pr.number, prUrl: pr.html_url, url };
    }
    const production = config.branches.production;
    const pr = prs.find((p) => p.merged_at && p.base?.ref === production);
    if (!pr) return skip(`no feedback PR merged into \`${production}\` has this commit`);
    return {
      mode: "post",
      kind: "live",
      issueNumber: issueFromBranch(pr.head.ref),
      prNumber: pr.number,
      prUrl: pr.html_url,
      url: productionUrl || url,
    };
  }

  if (eventName === "pull_request") {
    const pr = payload.pull_request ?? {};
    if (payload.action !== "closed" || !pr.merged) return skip("the PR wasn't merged");
    if (!pr.head?.ref?.startsWith(BRANCH_PREFIX)) return skip(`\`${pr.head?.ref}\` isn't a feedback branch`);
    const staging = config.branches.staging;
    // Production merges wait for the production deployment (see deployment_status above).
    if (pr.base?.ref !== staging) return skip(`merged into \`${pr.base?.ref}\`, not the staging branch \`${staging}\``);
    return {
      mode: "post",
      kind: "staging",
      issueNumber: issueFromBranch(pr.head.ref),
      prNumber: pr.number,
      prUrl: pr.html_url,
      url: stagingUrl || null,
    };
  }

  if (eventName === "issues") {
    if (payload.action !== "labeled" || payload.label?.name !== "needs-info") {
      return skip("only adding `needs-info` posts an update");
    }
    return { mode: "post", kind: "needs_info", issueNumber: payload.issue.number };
  }

  return skip(`\`${eventName}\` events don't post updates`);
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The Discord message: a reply to the card that pings only the person who sent the feedback. */
function buildMessage({ kind, block, repo, issue, prNumber, url, question }) {
  const ref = `[#${issue.number}](${issue.html_url})`;
  const title = truncate(safe(issue.title ?? "").replace(/\s+/g, " "), MAX_TITLE);
  const mention = `<@${block.user}>`;
  const lines = [];
  const buttons = [];

  if (kind === "preview") {
    lines.push(`${mention} 🔍 **${ref} is ready to check**: ${title}`);
    lines.push("Open the preview, then say whether it's right.");
    buttons.push({ type: 2, style: BUTTON.link, label: "Open preview", url });
    buttons.push({ type: 2, style: BUTTON.success, label: "Looks good", custom_id: `fb:good:${repo}:${prNumber}:${issue.number}` });
    buttons.push({ type: 2, style: BUTTON.secondary, label: "Still not right", custom_id: `fb:again:${repo}:${prNumber}:${issue.number}` });
  } else if (kind === "live") {
    lines.push(`${mention} 🚀 **${ref} is live**: ${title}`);
    if (url) lines.push(url);
  } else if (kind === "staging") {
    lines.push(`${mention} 🧪 **${ref} is on staging**: ${title}`);
    lines.push(url ? `Check it on the \`dev\` deployment: ${url}` : "It's merged into `dev`.");
  } else if (kind === "needs_info") {
    lines.push(`${mention} ❓ **${ref} needs more information**: ${title}`);
    if (question) lines.push(...safe(question).split("\n").map((line) => `> ${line}`));
    buttons.push({ type: 2, style: BUTTON.primary, label: "Answer", custom_id: `fb:answer:${repo}:${issue.number}` });
  }

  // A custom_id over Discord's limit (a very long repo name) would make the whole post fail.
  const usable = buttons.filter((b) => !b.custom_id || b.custom_id.length <= CUSTOM_ID_MAX);
  const dropped = buttons.length - usable.length;

  return {
    dropped,
    body: {
      content: truncate(lines.join("\n"), 2000),
      flags: SUPPRESS_EMBEDS,
      allowed_mentions: { users: [block.user], replied_user: false },
      message_reference: { message_id: block.message, channel_id: block.channel, guild_id: block.guild, fail_if_not_exists: false },
      ...(usable.length ? { components: [{ type: 1, components: usable }] } : {}),
    },
  };
}

/**
 * Everything the post needs, or why there's nothing to post. Hand-written issues (no hidden
 * block) are skipped, never an error.
 */
async function planNotify({ github, context, owner, repo, config, stagingUrl = "", productionUrl = "" }) {
  const event = await planEvent({ github, context, owner, repo, config, stagingUrl, productionUrl });
  if (event.mode === "skip") return event;
  if (!event.issueNumber) return { mode: "skip", reason: "the branch name has no issue number" };

  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: event.issueNumber });
  if (issue.pull_request) return { mode: "skip", reason: `#${event.issueNumber} is a pull request` };
  const block = parseFeedbackBlock(issue.body);
  if (!block) return { mode: "skip", reason: `#${issue.number} has no nexus-feedback block, so it wasn't sent from Discord` };

  let question = null;
  if (event.kind === "needs_info") {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issue.number,
      per_page: 100,
    });
    question = questionFrom(comments.find((c) => c.body?.includes(COMMENT_MARKER))?.body);
  }

  const { body, dropped } = buildMessage({ ...event, block, repo: `${owner}/${repo}`, issue, question });
  return { mode: "post", kind: event.kind, issueNumber: issue.number, channel: block.channel, body, dropped };
}

/** POST the message. A deleted channel is a warning; any other failure means setup is wrong. */
async function postToDiscord({ token, channel, body, fetch = globalThis.fetch }) {
  const response = await fetch(`${DISCORD_API}/channels/${channel}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/uw-datasci/nexus-workflows, 1)",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return { posted: true };
  const text = await response.text().catch(() => "");
  if (response.status === 404) return { posted: false, reason: `Discord says the channel is gone (${text.slice(0, 200)})` };
  throw new Error(`Discord returned ${response.status}: ${text.slice(0, 500)}`);
}

// ─── Workflow steps ──────────────────────────────────────────────────────────

async function stepPlan({ github, context, core }) {
  const { owner, repo } = context.repo;
  const config = loadConfig(path.join(process.env.GITHUB_WORKSPACE, CONTEXT_DIR, "config.raw.json"));
  const plan = await planNotify({
    github,
    context,
    owner,
    repo,
    config,
    stagingUrl: process.env.STAGING_URL ?? "",
    productionUrl: process.env.PRODUCTION_URL ?? "",
  });
  core.setOutput("run", String(plan.mode === "post"));
  if (plan.mode !== "post") {
    core.notice(`No Discord update: ${plan.reason}.`);
    return;
  }
  if (plan.dropped) core.warning("A button's custom_id is over Discord's 100-character limit, so it was left off.");
  core.setOutput("channel", plan.channel);
  core.setOutput("message", JSON.stringify(plan.body));
  core.notice(`Posting the ${plan.kind} update for #${plan.issueNumber} to Discord.`);
}

async function stepPost({ core }) {
  const result = await postToDiscord({
    token: process.env.DISCORD_BOT_TOKEN,
    channel: process.env.CHANNEL,
    body: JSON.parse(process.env.MESSAGE),
  });
  if (result.posted) core.notice("Posted to Discord.");
  else core.warning(`Not posted: ${result.reason}.`);
}

module.exports = { parseFeedbackBlock, planEvent, planNotify, buildMessage, postToDiscord, stepPlan, stepPost };
