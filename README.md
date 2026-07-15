# Nexus

Reusable GitHub Actions workflows for the Data Science Club.

## Available Workflows

- **Node Build** - Build Node.js applications with Infisical secrets
- **Vercel Deploy** - Deploy to Vercel
- **Quality Gate** - Lint and typecheck
- **Quality Sonar** - SonarQube analysis
- **Dispatch Docs Update** - Notify the docs app (nexus-docs) when a PR merges so the changelog gets updated

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
