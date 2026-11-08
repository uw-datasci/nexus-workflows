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
```

`never_touch` patterns work like `.gitignore`. A pattern without `/` matches that file name at any depth (`package.json` also blocks `apps/web/package.json`). A pattern with `/` is anchored at the repo root. `**` crosses directories and `*` doesn't.

### Feedback Triage

`.github/workflows/feedback-triage.yml` runs when an issue gets the `feedback` label. It has two jobs:

1. **Analyze.** Claude (`claude-sonnet-5-5`, read-only tools, a read-only token) reads the issue, its screenshots, `AGENTS.md`, the config and the code, and returns a verdict.
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
| unclear, or no `env:prod` / `env:staging` label | `needs-info`, plus a question comment | none |

- The route label is added last, so the fix workflow finds the comment and assignee in place.
- `area:*` values come from the repo's existing `area:*` labels.
- `strict` repos never close anything and flag possible duplicates for the lead. `relaxed` repos close duplicates.
- An issue that already has a route label isn't triaged again unless `retriage: true`.
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
2. **Agent.** Waits its turn, installs dependencies, and runs Claude (`claude-sonnet-5-5`, 40 turns, 20 minutes). It can edit files and run the lint and typecheck commands, nothing else. Its token can't push. What it changed is uploaded as a patch.
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

**One agent at a time.** Each repo runs one agent at a time and drops none. A GitHub concurrency group keeps only one pending run, so it isn't used here. Instead, the agent job waits until every older run of the queue workflows has finished: the caller's own workflow, plus `queue-workflows`. Per issue, a concurrency group cancels the old run when the labels flip.

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
    secrets:
      INFISICAL_CLIENT_ID: ${{ secrets.INFISICAL_CLIENT_ID }}
      INFISICAL_CLIENT_SECRET: ${{ secrets.INFISICAL_CLIENT_SECRET }}
```

The scripts behind both workflows live in `scripts/feedback/`, and their tests run with `node --test 'scripts/**/*.test.js'`.

## Release Automation

This repository uses **automatic versioning** based on conventional commits with manual fallback options.

### Primary: Automatic Release

**Workflow:** `.github/workflows/release.yml`

Automatically creates releases based on commit messages following [Conventional Commits](https://www.conventionalcommits.org/).

#### Automatic Mode (Push to main)

When you push to `main`, the workflow automatically:

- Analyzes commit messages since the last release
- Determines the version bump (major, minor, or patch)
- Creates and pushes a version tag (e.g., `v1.2.3`)
- Generates release notes from commits
- Creates a GitHub release
- Updates the major version tag (e.g., `v1`) to point to the latest release

#### Manual Mode (Workflow Dispatch)

For situations where you need manual control:

1. Go to **Actions** → **Release** → **Run workflow**
2. Choose options:
   - **Release type:**
     - `auto` - Analyze commit messages (default)
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
