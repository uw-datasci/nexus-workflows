"use strict";

/**
 * In-memory stand-in for the Octokit client github-script provides, covering only the calls the
 * feedback scripts make. Used by the *.test.js files.
 */

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
const names = (issue) => issue.labels.map((l) => (typeof l === "string" ? l : l.name));

function fakeGitHub({ issues = [], labels = [], teams = {}, commits = {} } = {}) {
  const byNumber = new Map(
    issues.map((i) => [
      i.number,
      { state: "open", body: "", assignees: [], user: { login: "someone" }, html_url: `https://github.test/${i.number}`, ...i, labels: (i.labels ?? []).map((name) => ({ name })) },
    ])
  );
  const comments = new Map();
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
    repos: {
      listCommits: async ({ path }) => ({
        data: (commits[path] ?? []).map(([login, date]) => ({
          author: login ? { login, type: "User" } : null,
          commit: { author: { date } },
        })),
      }),
    },
  };

  const paginate = async (fn, params) => (await fn(params)).data;

  return { rest, paginate, calls, comments, issue };
}

module.exports = { fakeGitHub };
