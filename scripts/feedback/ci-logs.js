"use strict";

/**
 * The failure output the agent gets for its one retry: the tail of each failed job's log from the
 * quality-gate run, cleaned of timestamps and colour codes and capped in size.
 */

const LINES_PER_JOB = 200;
const MAX_CHARS = 30_000;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

function cleanLog(text, maxLines = LINES_PER_JOB) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(TIMESTAMP, "").replace(ANSI, ""))
    .filter((line) => !/^##\[(?:group|endgroup)\]/.test(line));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.slice(-maxLines).join("\n");
}

/** Markdown with one section per failed job, or null if nothing failed. */
async function failureExcerpt({ github, owner, repo, runId, log = () => {} }) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner,
    repo,
    run_id: runId,
    filter: "latest",
    per_page: 100,
  });
  const failed = jobs.filter((job) => job.conclusion === "failure");
  if (failed.length === 0) return null;

  const budget = Math.floor(MAX_CHARS / failed.length);
  const sections = [];
  for (const job of failed) {
    const steps = (job.steps ?? []).filter((s) => s.conclusion === "failure").map((s) => s.name);
    let body;
    try {
      const { data } = await github.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: job.id });
      body = cleanLog(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
      if (body.length > budget) body = body.slice(-budget);
    } catch (error) {
      log(`Could not download the log for ${job.name}: ${error.message}`);
      body = "(log not available)";
    }
    sections.push(
      [`## ${job.name}`, steps.length ? `Failed steps: ${steps.join(", ")}` : "", "", "````text", body.replace(/^````/gm, "` ```"), "````"]
        .filter((line, i) => i !== 1 || line)
        .join("\n")
    );
  }
  return sections.join("\n\n");
}

module.exports = { cleanLog, failureExcerpt };
