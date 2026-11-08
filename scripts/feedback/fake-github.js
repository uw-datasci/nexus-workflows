"use strict";

/**
 * In-memory stand-in for the Octokit client github-script provides, covering only the calls the
 * feedback scripts make. Used by the *.test.js files.
 */

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
const names = (issue) => issue.labels.map((l) => (typeof l === "string" ? l : l.name));

function fakeGitHub({ issues = [], labels = [], teams = {}, commits = {}, pulls = [], branches = [], runs = {}, jobs = {}, logs = {}, users = {}, permissions = {}, reviewComments = [], issueComments = {} } = {}) {
  const byNumber = new Map(
    issues.map((i) => [
      i.number,
      { state: "open", body: "", assignees: [], user: { login: "someone" }, html_url: `https://github.test/${i.number}`, ...i, labels: (i.labels ?? []).map((name) => ({ name })) },
    ])
  );
  const prs = pulls.map((p) => ({ state: "open", body: "", html_url: `https://github.test/pull/${p.number}`, ...p }));
  const comments = new Map(Object.entries(issueComments).map(([n, list]) => [Number(n), list.map((c, i) => ({ id: 1000 + i, ...c }))]));
  const replies = [];
  const calls = [];
  let nextCommentId = 1;

  const issue = (n) => {
    const found = byNumber.get(n);
    if (!found) throw notFound();
    return found;
  };

  const rest = {
    issues: {
      get: async ({ issue_number }) => ({ data: issue(issue_number) }),
      listForRepo: async ({ state = "open", labels: label, assignee }) => ({
        data: [...byNumber.values()].filter(
          (i) =>
            i.state === state &&
            (!label || names(i).includes(label)) &&
            (!assignee || i.assignees.some((a) => a.login === assignee))
        ),
      }),
      listLabelsForRepo: async () => ({ data: labels.map((name) => ({ name })) }),
      listComments: async ({ issue_number }) => ({ data: comments.get(issue_number) ?? [] }),
      createComment: async ({ issue_number, body }) => {
        calls.push(["createComment", issue_number]);
        const list = comments.get(issue_number) ?? [];
        list.push({ id: nextCommentId++, body });
        comments.set(issue_number, list);
        return { data: {} };
      },
      updateComment: async ({ comment_id, body }) => {
        calls.push(["updateComment", comment_id]);
        for (const list of comments.values()) {
          const c = list.find((x) => x.id === comment_id);
          if (c) c.body = body;
        }
        return { data: {} };
      },
      addLabels: async ({ issue_number, labels: added }) => {
        calls.push(["addLabels", issue_number, added]);
        const i = issue(issue_number);
        for (const name of added) if (!names(i).includes(name)) i.labels.push({ name });
        return { data: {} };
      },
      removeLabel: async ({ issue_number, name }) => {
        const i = issue(issue_number);
        if (!names(i).includes(name)) throw notFound();
        calls.push(["removeLabel", issue_number, name]);
        i.labels = i.labels.filter((l) => l.name !== name);
        return { data: {} };
      },
      addAssignees: async ({ issue_number, assignees }) => {
        calls.push(["addAssignees", issue_number, assignees]);
        issue(issue_number).assignees.push(...assignees.map((login) => ({ login })));
        return { data: {} };
      },
      removeAssignees: async ({ issue_number, assignees }) => {
        calls.push(["removeAssignees", issue_number, assignees]);
        const i = issue(issue_number);
        i.assignees = i.assignees.filter((a) => !assignees.includes(a.login));
        return { data: {} };
      },
      update: async ({ issue_number, state, state_reason }) => {
        calls.push(["update", issue_number, state, state_reason]);
        issue(issue_number).state = state;
        return { data: {} };
      },
    },
    teams: {
      listMembersInOrg: async ({ team_slug }) => {
        if (!(team_slug in teams)) throw notFound();
        return { data: teams[team_slug].map((login) => ({ login })) };
      },
    },
    pulls: {
      get: async ({ pull_number }) => {
        const pr = prs.find((p) => p.number === pull_number);
        if (!pr) throw notFound();
        return { data: pr };
      },
      listReviewComments: async () => ({ data: reviewComments }),
      createReplyForReviewComment: async ({ comment_id, body }) => {
        calls.push(["createReplyForReviewComment", comment_id]);
        replies.push({ comment_id, body });
        return { data: {} };
      },
      list: async ({ owner, head, state = "open" }) => ({
        data: prs.filter((p) => p.state === state && `${owner}:${p.head.ref}` === head),
      }),
      create: async ({ title, head, base, body }) => {
        calls.push(["createPull", head, base]);
        const number = 100 + prs.length;
        const pr = { number, title, body, state: "open", head: { ref: head, sha: "new" }, base: { ref: base }, html_url: `https://github.test/pull/${number}` };
        prs.push(pr);
        return { data: pr };
      },
      update: async ({ pull_number, body }) => {
        calls.push(["updatePull", pull_number]);
        const pr = prs.find((p) => p.number === pull_number);
        if (!pr) throw notFound();
        pr.body = body;
        return { data: pr };
      },
      requestReviewers: async ({ pull_number, reviewers }) => {
        calls.push(["requestReviewers", pull_number, reviewers]);
        return { data: {} };
      },
    },
    git: {
      listMatchingRefs: async ({ ref }) => ({
        data: branches.filter((b) => `heads/${b}`.startsWith(ref)).map((b) => ({ ref: `refs/heads/${b}` })),
      }),
    },
    actions: {
      listWorkflowRuns: async ({ workflow_id }) => {
        if (!(workflow_id in runs)) throw notFound();
        return { data: { workflow_runs: runs[workflow_id] } };
      },
      listJobsForWorkflowRun: async ({ run_id }) => ({ data: jobs[run_id] ?? [] }),
      downloadJobLogsForWorkflowRun: async ({ job_id }) => {
        if (!(job_id in logs)) throw notFound();
        return { data: logs[job_id] };
      },
    },
    users: {
      getByUsername: async ({ username }) => {
        if (!(username in users)) throw notFound();
        return { data: { login: username, id: users[username] } };
      },
    },
    reactions: {
      createForIssueComment: async ({ comment_id, content }) => {
        calls.push(["reaction", "issue_comment", comment_id, content]);
        return { data: {} };
      },
      createForPullRequestReviewComment: async ({ comment_id, content }) => {
        calls.push(["reaction", "review_comment", comment_id, content]);
        return { data: {} };
      },
    },
    repos: {
      listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
        data: prs.filter((p) => p.head?.sha === commit_sha || p.merge_commit_sha === commit_sha),
      }),
      getCollaboratorPermissionLevel: async ({ username }) => {
        if (!(username in permissions)) throw notFound();
        return { data: { permission: permissions[username] } };
      },
      listCommits: async ({ path }) => ({
        data: (commits[path] ?? []).map(([login, date]) => ({
          author: login ? { login, type: "User" } : null,
          commit: { author: { date } },
        })),
      }),
    },
  };

  const paginate = async (fn, params) => (await fn(params)).data;

  return { rest, paginate, calls, comments, replies, issue, prs };
}

module.exports = { fakeGitHub };
