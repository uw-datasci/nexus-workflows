"use strict";

/**
 * One agent run per repo at a time, without dropping any.
 *
 * A GitHub concurrency group can't do this: it keeps one pending run and cancels the rest. So the
 * agent job waits instead until no OLDER run (lower run ID) of the queue workflows is unfinished.
 * Run IDs only go up, so every run has a fixed place in line, nothing is skipped and two runs can
 * never wait on each other. Runs that only checked a label and skipped finish in seconds, so they
 * barely hold up the line.
 *
 * The queue workflows are the caller's own workflow file plus any listed in `queue-workflows`
 * (the @claude workflow shares this queue).
 */

const RUNS_PER_WORKFLOW = 100;

/** "owner/repo/.github/workflows/feedback.yml@refs/heads/main" → "feedback.yml" */
function workflowFileFromRef(workflowRef) {
  const match = /\.github\/workflows\/([^@/]+)@/.exec(workflowRef ?? "");
  return match ? match[1] : null;
}

/** "a.yml, b.yml" or "a.yml\nb.yml" → ["a.yml", "b.yml"] */
function parseWorkflowList(text) {
  return String(text ?? "")
    .split(/[\s,]+/)
    .map((name) => name.trim().replace(/^\.github\/workflows\//, ""))
    .filter(Boolean);
}

/** Unfinished runs of `workflows` that started before `runId`, oldest first. */
async function olderActiveRuns({ github, owner, repo, workflows, runId }) {
  const older = [];
  for (const workflow of new Set(workflows)) {
    let runs;
    try {
      ({ data: { workflow_runs: runs } } = await github.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflow,
        per_page: RUNS_PER_WORKFLOW,
      }));
    } catch (error) {
      if (error.status === 404) continue; // a listed workflow that doesn't exist (yet)
      throw error;
    }
    for (const run of runs) {
      if (run.id < runId && run.status !== "completed") older.push(run);
    }
  }
  return older.sort((a, b) => a.id - b.id);
}

/**
 * Poll until it's this run's turn.
 * @returns {Promise<{ ready: boolean, waitedMs: number, blocking: object[] }>}
 */
async function waitForTurn({
  github,
  owner,
  repo,
  workflows,
  runId,
  timeoutMs,
  intervalMs = 30_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  log = () => {},
}) {
  const start = now();
  for (;;) {
    const blocking = await olderActiveRuns({ github, owner, repo, workflows, runId });
    const waitedMs = now() - start;
    if (blocking.length === 0) return { ready: true, waitedMs, blocking };
    if (waitedMs >= timeoutMs) return { ready: false, waitedMs, blocking };
    log(`Waiting for ${blocking.length} earlier run(s): ${blocking.map((r) => r.html_url ?? r.id).join(", ")}`);
    await sleep(intervalMs);
  }
}

module.exports = { olderActiveRuns, waitForTurn, workflowFileFromRef, parseWorkflowList };
