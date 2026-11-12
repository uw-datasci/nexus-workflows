# Nexus

Reusable GitHub Actions workflows for the Data Science Club.

## Available Workflows

- **Node Build** - Build Node.js applications with Infisical secrets
- **Vercel Deploy** - Deploy to Vercel
- **Quality Gate** - Lint and typecheck
- **Quality Sonar** - SonarQube analysis
- **Dispatch Docs Update** - Notify the docs app (nexus-docs) when a PR merges so the changelog gets updated
- **Feedback Triage** - Route feedback issues to Claude (`route:agent`) or a developer (`route:dev`). See [Feedback loop](#feedback-loop)
- **Feedback Fix** - Have Claude fix `route:agent` issues and open a PR for review. See [Feedback Fix](#feedback-fix)
- **Claude Mention** - `@claude` on a feedback PR asks Claude for a change. See [Claude Mention](#claude-mention)
- **Feedback Notify** - Tell the organizer in Discord when a fix is ready to check, live, on staging, or needs info. See [Feedback Notify](#feedback-notify)

## Feedback loop

App repos opt in with a `.github/feedback.yml` and a caller workflow. Organizers' feedback becomes issues labelled `feedback`, and triage decides who fixes each one. Spec: [Feedback loop](https://app.notion.com/p/4111b70395fc8183aa09f377e40f1f5e).

### `.github/feedback.yml`

```yaml
app: cxc
strictness: strict        # strict | relaxed
branches:
  production: main
  staging: dev
lead: <github-handle>
dev_team: cxc-dev         # empty = every dev issue goes to the lead
devs:                     # optional overrides for clear ownership
  - github: <handle>
    areas: [landing, auth]
agent:
  enabled: true
  max_files: 5
  never_touch: [migrations/**, lib/auth/**, proxy.ts, config/site.ts, .github/**, package.json, pnpm-lock.yaml]
project:                  # optional: keep the issue's status on an org project board
  number: 28
  field: Status           # default
  statuses:               # defaults shown
    backlog: Backlog
    agent: In Progress
    review: In Review
    dev: Todo
```

`never_touch` patterns work like `.gitignore`. A pattern without `/` matches that file name at any depth (`package.json` also blocks `apps/web/package.json`). A pattern with `/` is anchored at the repo root. `**` crosses directories and `*` doesn't.

### Feedback Triage

`.github/workflows/feedback-triage.yml` runs when an issue gets the `feedback` label, and again whenever it gets the `retriage` label. It has two jobs:

1. **Analyze.** Claude (`claude-sonnet-5-5`, read-only tools, a read-only token) reads the issue, its comments, its screenshots, `AGENTS.md`, the config and the code, and returns a verdict. The comments carry answers to triage's questions and organizers' follow-ups from Discord; the workflows' own comments are left out.
   - **Which code:** the branch the issue's env label points at, the same branch the fix works on: `env:staging` reads `branches.staging` and `env:prod` reads `branches.production`. The config always comes from the default branch.
   - **When it isn't there:** if what the issue describes isn't on that branch, triage asks whether the label is wrong (for example, the page is only on the live site) instead of guessing.
2. **Apply.** A script, using the `nexus-feedback` GitHub App token, turns the verdict into labels, an assignee and a triage comment. Labels from an App token trigger other workflows; labels from `GITHUB_TOKEN` wouldn't.

The verdict only *suggests* a route. The script sends the issue to the agent only when every one of these holds:

- `agent.enabled` is true
- the fix needs between 1 and `max_files` files, and none of them match `never_touch`
- no new dependency, database change or environment variable is needed
- the expected result is clear

Anything else goes to `route:dev`, and the comment says which rule decided it.

| Outcome | Labels | Assignee |
|---|---|---|
| `route:agent` | `route:agent`, `size:*`, `area:*` | the `lead`, who reviews the agent's PR |
| `route:dev` | `route:dev`, `size:*`, `area:*` | a `devs` override for the area; otherwise the `dev_team` member who most recently changed the likely files, skipping anyone with 3+ open feedback issues; otherwise the `lead` |
| unclear, no `env:prod` / `env:staging` label, or not found on that env's branch | `needs-info`, plus a question comment | none |

**Project board (optional).** With `project:` set, the apply step adds the issue to that org project and sets its status: `agent` (In Progress) for `route:agent`, `dev` (Todo) for `route:dev`, and `backlog` (Backlog) for a question. Feedback Fix sets `review` (In Review) when the agent's PR is opened or updated, and `dev` when it hands an issue to a developer. A missing board, field or status is a warning, and triage still finishes.

- The `nexus-feedback` App needs the organization permission **Projects: Read and write**. Grant it before adding `project:`, since the token asks for it once `project:` is set.
- For Backlog as soon as the issue is created, turn on the board's built-in **Item added to project** workflow with Status: Backlog, and have **Auto-add to project** add `is:issue` items.

- The route label is added last, so the fix workflow finds the comment and assignee in place.
- `area:*` values come from the repo's existing `area:*` labels.
- `strict` repos never close anything and flag possible duplicates for the lead. `relaxed` repos close duplicates.
- An issue that already has a route label isn't triaged again unless it gets the `retriage` label (or the caller passes `retriage: true`). The apply step removes `retriage` again. When re-triage lands on the same route, the route label is taken off and put back, so `route:agent` starts a new fix. Create the `retriage` label in the repo; nexus-bot adds it when an organizer answers a question or says a merged fix is still not right.
- Only the `labeled` event (adding `feedback`) starts triage. Creating an issue with labels fires both `opened` and `labeled`, so `opened` is skipped.

**Inputs**

| Input | Default | |
|---|---|---|
| `infisical-project-slug` | required | Project holding the feedback secrets |
| `infisical-secret-path` | `/nexus-feedback` | Folder with `FEEDBACK_ANTHROPIC_API_KEY`, `FEEDBACK_APP_CLIENT_ID` (or `FEEDBACK_APP_ID`) and `FEEDBACK_APP_PRIVATE_KEY` |
| `infisical-env-slug` | `prod` | |
| `config-path` | `.github/feedback.yml` | |
| `issue-number` | the event's issue | |
| `retriage` | `false` | Triage again even if a route label is set |
| `model` / `max-turns` | `claude-sonnet-5-5` / `15` | |
| `allowed-bots` | empty | e.g. `nexus-feedback[bot]`, for issues filed from Discord |
| `workflows-ref` | `v4` | Ref the feedback scripts are loaded from; match the ref you call the workflow at |

Secrets: `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`. The secrets are exported to a file and read per job, so the agent step only ever sees the Anthropic key.

**Caller example**

```yaml
on:
  issues:
    types: [labeled]

jobs:
  triage:
    if: github.event.label.name == 'feedback' || github.event.label.name == 'retriage'
    uses: uw-datasci/nexus-workflows/.github/workflows/feedback-triage.yml@v4
    permissions:
      contents: read
      issues: read
    with:
      infisical-project-slug: uwdsc-54e-y
      allowed-bots: nexus-feedback[bot]
    secrets:
      INFISICAL_CLIENT_ID: ${{ secrets.INFISICAL_CLIENT_ID }}
      INFISICAL_CLIENT_SECRET: ${{ secrets.INFISICAL_CLIENT_SECRET }}
```

### Feedback Fix

`.github/workflows/feedback-fix.yml` runs when an issue gets `route:agent`. Claude makes the change and the workflow opens a PR for a person to review. **The agent never merges.** If it can't finish, a developer takes over.

The model never runs in a job that holds a write token:

1. **Gate.** Decides what to do from the event (table below). The config is always read from the default branch.
2. **Queue, then agent.** Waits its turn in the repo's queue, then installs dependencies and runs Claude (`claude-sonnet-5-5`, 40 turns, 20 minutes). It can edit files and run the lint and typecheck commands, nothing else. Its token can't push. What it changed is uploaded as a patch.
3. **Publish.** With the `nexus-feedback` App token and no model, it applies the patch and checks the guardrail. Only then does it commit, push and open or update the PR. App-token pushes start the app's quality gate on the PR.
4. **Hand off.** If anything went wrong, it assigns a developer (same rules as triage), comments why, and swaps `route:agent` for `route:dev`.

| Event | What happens |
|---|---|
| `route:agent` added | The agent works on `feedback/<issue>-<slug>`, cut from `branches.staging` for `env:staging` or `branches.production` for `env:prod`, and opens a PR into that branch. If the branch already exists (a second try), it continues on it. |
| `route:agent` added, but `agent.enabled: false` or no `env:*` label | Hand off |
| A person adds `route:dev` | The running agent is cancelled and a developer is assigned (one who is already assigned keeps it) |
| A person removes `route:agent` | The running agent is cancelled |
| The PR's quality gate fails | The first time, the agent retries once with the failure output. The second time, hand off. |

**Guardrail.** Before anything is pushed, every file the branch changes against its base (renames and deletions included) is checked. The run hands off without pushing if:

- any path matches `never_touch`
- any path is in `.github/workflows/`, whatever the config says
- the branch changes more than `max_files` files

The same check is in `scripts/feedback/guardrail.js` for the `@claude` workflow.

**The PR**

- **Body:** the repo's PR template (`.github/pull_request_template.md`), with the issue number filled in and the agent's list of changes. It includes `closes #N`.
- **Reviewer:** the `lead` is requested, and CODEOWNERS applies as usual.
- **Closing:** GitHub only closes issues on merges into the default branch, so a PR into `dev` won't close its issue.

**One agent at a time.** Each repo runs one agent at a time and drops none. A GitHub concurrency group keeps only one pending run, so it isn't used here. Instead, a `queue` job waits until every older run of the queue workflows has finished: the caller's own workflow, plus `queue-workflows`. List the `@claude` caller there, and list this caller in its `queue-workflows`, so the two never work on a branch at the same time. Per issue, a concurrency group cancels the old run when the labels flip.

**Inputs**

| Input | Default | |
|---|---|---|
| `infisical-project-slug` | required | As for triage |
| `infisical-secret-path` / `infisical-env-slug` | `/nexus-feedback` / `prod` | |
| `config-path` | `.github/feedback.yml` | |
| `model` / `max-turns` / `timeout-minutes` | `claude-sonnet-5-5` / `40` / `20` | |
| `node-version` / `pnpm-version` | `24` / from `packageManager` | |
| `install-command` | `pnpm install --frozen-lockfile` | |
| `lint-command` / `typecheck-command` | `pnpm lint` / `pnpm typecheck` | The only commands the agent may run |
| `queue-workflows` | empty | Other workflow files whose agent runs share the queue, e.g. the `@claude` caller |
| `queue-timeout-minutes` | `90` | Keep it under 200, inside the job's 4-hour limit |
| `allowed-bots` | `nexus-feedback[bot]` | Triage adds `route:agent` as the App, so it must be listed |
| `workflows-ref` | `v4` | |

Secrets: `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`. The agent job only ever holds the Anthropic key and a read-only `GITHUB_TOKEN`. The App token never reaches a job that runs the model, and it has no `workflows` permission. Build output that lint or typecheck writes must be gitignored, or it counts towards `max_files`.

**Caller example**

```yaml
on:
  issues:
    types: [labeled, unlabeled]
  workflow_run:
    workflows: ["CI Quality Gate"]
    types: [completed]

jobs:
  fix:
    uses: uw-datasci/nexus-workflows/.github/workflows/feedback-fix.yml@v4
    permissions:
      contents: read
      issues: read
      pull-requests: read
      actions: read     # the queue and the quality-gate logs
      packages: read    # pnpm install from GitHub Packages
    with:
      infisical-project-slug: uwdsc-54e-y
      queue-workflows: claude.yml   # the @claude caller shares the queue
    secrets:
      INFISICAL_CLIENT_ID: ${{ secrets.INFISICAL_CLIENT_ID }}
      INFISICAL_CLIENT_SECRET: ${{ secrets.INFISICAL_CLIENT_SECRET }}
```

### Claude Mention

`.github/workflows/claude-mention.yml` lets reviewers iterate on a feedback PR by commenting `@claude` instead of fixing things by hand. From F2, the `nexus-feedback` App posts these comments for organizers' "Still not right" replies in Discord. Claude makes the requested change on the PR's branch, or answers the question, and the workflow replies on the PR.

**What counts**

- **The comment:**
  - a new PR comment, review comment or review that mentions `@claude` as a whole word
  - on an open PR from a `feedback/*` branch in the same repo
- **The author:**
  - a person with write access
  - a bot listed in `allowed-bots` (default `nexus-feedback[bot]`)
- **Anything else** does nothing, with no reply.

**What happens**

1. **Acknowledge.** The comment gets a 👀 reaction. Reviews can't take reactions, so they get none.
2. **Wait.** The run waits its turn in the same repo queue as the fix workflow.
3. **Run Claude.** Claude starts from the latest commit on the branch, with the same model setup and the same tools as the fix workflow (30 turns, 15 minutes). It reads:
   - the comment
   - the PR and its recent conversation
   - the feedback issue and its screenshots
   - the code
4. **Push and reply.** The same guardrail runs on the whole branch against its base. If it passes, the change is pushed as the App and the reply says what changed. If not, **nothing is pushed** and the reply says why. Questions get an answer and no commit.
   - **Where:** review comments are answered in their thread. Anything else gets a PR comment.
   - **No pings:** replies never ping anyone and can't start another run.
   - **Retry budget:** a push resets the fix workflow's quality-gate retry, so each requested change gets one automatic retry if the quality gate fails.

If `agent.enabled` is false, the workflow only replies that the agent is turned off.

**Inputs:** the same as Feedback Fix, except `max-turns` (`30`) and `timeout-minutes` (`15`). Nothing is handed off: a failed run just replies.

**Caller example**

```yaml
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

jobs:
  claude:
    uses: uw-datasci/nexus-workflows/.github/workflows/claude-mention.yml@v4
    permissions:
      contents: read
      issues: read
      pull-requests: read
      actions: read
      packages: read
    with:
      infisical-project-slug: uwdsc-54e-y
      queue-workflows: feedback-fix.yml
    secrets:
      INFISICAL_CLIENT_ID: ${{ secrets.INFISICAL_CLIENT_ID }}
      INFISICAL_CLIENT_SECRET: ${{ secrets.INFISICAL_CLIENT_SECRET }}
```

### Feedback Notify

`.github/workflows/feedback-notify.yml` replies to an issue's Discord card as its fix moves along. It only acts on issues filed from Discord: nexus-bot ends those with a hidden `<!-- nexus-feedback {"guild","channel","message","user"} -->` block naming the card. Issues without it are skipped quietly.

| When | Event | Message |
|---|---|---|
| Preview ready | `deployment_status` success, environment `Preview`, on the head commit of an open `feedback/*` PR | `#12 is ready to check`, with **Open preview**, **Looks good** and **Still not right** |
| Live | `deployment_status` success, environment `Production`, for a `feedback/*` PR merged into `branches.production` | `#12 is live`, with `production-url` |
| On staging | `pull_request` closed, a `feedback/*` PR merged into `branches.staging` | `#12 is on staging`, with `staging-url` |
| Needs info | `issues` labeled `needs-info` | triage's question, with **Answer** |

- **The message:** a reply to the card, in its channel or thread, that pings only the person who sent the feedback. Embeds are suppressed.
- **The token:** `DISCORD_BOT_TOKEN` from the Infisical folder, used for one REST call. The job holds only a read-only `GITHUB_TOKEN` and runs no model.
- **Failures:** a deleted channel is a warning. Any other Discord error fails the job, since it means the bot's token or permissions are wrong.
- **The URLs:** the preview link is Vercel's deployment URL from the deployment status. Vercel's GitHub integration creates the deployments and statuses.

**The buttons** are handled by nexus-bot's feedback module. Their custom_ids are the contract between the two:

| custom_id | Button | What nexus-bot does |
|---|---|---|
| `fb:good:<owner/repo>:<pr>:<issue>` | Looks good | Comments on the PR |
| `fb:again:<owner/repo>:<pr>:<issue>` | Still not right | Open PR: an `@claude` comment (`route:agent`) or a mention of the assigned dev. Merged: reopens the issue, comments and adds `retriage` |
| `fb:answer:<owner/repo>:<issue>` | Answer | Comments on the issue and adds `retriage` |

A custom_id over Discord's 100 characters (a very long repo name) is left off with a warning.

**Inputs**

| Input | Default | |
|---|---|---|
| `infisical-project-slug` | required | Project holding the feedback secrets |
| `infisical-secret-path` | `/nexus-feedback` | Folder with `DISCORD_BOT_TOKEN` |
| `infisical-env-slug` | `prod` | |
| `config-path` | `.github/feedback.yml` | For `branches` |
| `staging-url` | empty | The staging branch's deployment, e.g. `https://cxc-git-dev-uwdsc.vercel.app` |
| `production-url` | the deployment's URL | The live site |
| `workflows-ref` | `v4` | |

**Caller example**

```yaml
on:
  deployment_status:
  pull_request:
    types: [closed]
  issues:
    types: [labeled]

jobs:
  notify:
    if: >-
      (github.event_name == 'deployment_status' && github.event.deployment_status.state == 'success') ||
      (github.event_name == 'pull_request' && github.event.pull_request.merged && startsWith(github.event.pull_request.head.ref, 'feedback/')) ||
      (github.event_name == 'issues' && github.event.label.name == 'needs-info')
    uses: uw-datasci/nexus-workflows/.github/workflows/feedback-notify.yml@v4
    permissions:
      contents: read
      issues: read
      pull-requests: read
    with:
      infisical-project-slug: uwdsc-54e-y
      staging-url: https://cxc-git-dev-uwdsc.vercel.app
      production-url: https://cxc.uwdatascience.ca
    secrets:
      INFISICAL_CLIENT_ID: ${{ secrets.INFISICAL_CLIENT_ID }}
      INFISICAL_CLIENT_SECRET: ${{ secrets.INFISICAL_CLIENT_SECRET }}
```

The scripts behind all four workflows live in `scripts/feedback/`, and their tests run with `node --test 'scripts/**/*.test.js'`.

## Release Automation

This repository uses **automatic versioning** based on conventional commits with manual fallback options.

### Primary: Automatic Release

**Workflow:** `.github/workflows/release.yml`

Automatically creates releases based on commit messages following [Conventional Commits](https://www.conventionalcommits.org/).

#### Automatic Mode (Push to main)

When you push to `main`, the workflow automatically:

- Analyzes commit messages since the last release
- Determines the version bump (major, minor, or patch), falling back to **patch** when no commit uses a conventional type (e.g. a direct commit to `main` like `update docs`)
- Creates and pushes a version tag (e.g., `v1.2.3`)
- Generates release notes from commits
- Creates a GitHub release
- Updates the major version tag (e.g., `v1`) to point to the latest release

#### Manual Mode (Workflow Dispatch)

For situations where you need manual control:

1. Go to **Actions** → **Release** → **Run workflow**
2. Choose options:
   - **Release type:**
     - `auto` - Analyze commit messages, falling back to patch (default)
     - `major` - Force major version bump (e.g., 1.0.0 → 2.0.0)
     - `minor` - Force minor version bump (e.g., 1.0.0 → 1.1.0)
     - `patch` - Force patch version bump (e.g., 1.0.0 → 1.0.1)
   - **Dry run:** Preview the version and changelog without creating a release
3. Click **Run workflow**

**Use manual mode when:**

- You need to force a specific version bump regardless of commits
- You want to preview what will be released (dry run)
- Commit messages don't reflect the actual changes
- You need to create a release without waiting for new commits

### Fallback: Tag-Based Release

**Workflow:** `.github/workflows/release-tag.yml`

Creates releases when you push a version tag (bypasses automatic versioning entirely).

**To use:**

```bash
# Create and push a tag
git tag v1.0.0
git push origin v1.0.0

# For pre-releases
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1
```

**Use tag-based when:**

- The automatic release workflow is not working
- You need complete manual control over versioning
- Creating hotfix releases on older versions

## Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/) for automatic releases:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat:` - New feature (triggers **minor** release: 1.0.0 → 1.1.0)
- `fix:` - Bug fix (triggers **patch** release: 1.0.0 → 1.0.1)
- `perf:` - Performance improvement (triggers **patch** release)
- `docs:` - Documentation changes (triggers **patch** release)
- `refactor:` - Code refactoring (triggers **patch** release)
- `chore:` - Maintenance (no release)
- `test:` - Test changes (no release)
- `ci:` - CI changes (no release)
- `BREAKING CHANGE:` - Breaking change (triggers **major** release: 1.0.0 → 2.0.0)

### Example Commits

```bash
# Minor release (new feature)
feat: add new workflow for Docker builds

# Patch release (bug fix)
fix: correct artifact path in build workflow

# Major release (breaking change - option 1)
feat!: redesign workflow input parameters

# Major release (breaking change - option 2)
feat: change deployment strategy

BREAKING CHANGE: deployment now requires vercel-project-id

# No release
chore: update dependencies
test: add unit tests for workflows
```

## Quick Start

### Automatic Release (Recommended)

Just commit using conventional commit format and push to main:

```bash
git commit -m "feat: add new deployment workflow"
git push origin main
# Automatically creates a release!
```

### Manual Release Override

If you need to force a specific version:

1. Go to **Actions** → **Release**
2. Click **Run workflow**
3. Select `major`, `minor`, or `patch`
4. Click **Run workflow**

### Emergency Tag-Based Release

If semantic-release isn't working:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Configuration

The release workflow uses [github-tag-action](https://github.com/mathieudutour/github-tag-action) to analyze conventional commits and determine version bumps automatically.
