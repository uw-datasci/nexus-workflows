# Nexus

Reusable GitHub Actions workflows for the Data Science Club.

## Available Workflows

- **Node Build** - Build Node.js applications with Infisical secrets
- **Vercel Deploy** - Deploy to Vercel
- **Quality Gate** - Lint and typecheck
- **Quality Sonar** - SonarQube analysis

## Release Automation

This repository includes three release automation workflows:

### 1. Automatic Semantic Release (Recommended)

**Workflow:** `.github/workflows/release.yml`

Automatically creates releases based on commit messages following [Conventional Commits](https://www.conventionalcommits.org/).

**Commit Format:**

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**

- `feat:` - New feature (triggers minor release)
- `fix:` - Bug fix (triggers patch release)
- `perf:` - Performance improvement (triggers patch release)
- `docs:` - Documentation changes (triggers patch release)
- `refactor:` - Code refactoring (triggers patch release)
- `BREAKING CHANGE:` - Breaking change (triggers major release)

**Example commits:**

```bash
feat: add new workflow for Docker builds
fix: correct artifact path in build workflow
feat!: redesign workflow input parameters

# Breaking change in footer
feat: change deployment strategy

BREAKING CHANGE: deployment now requires vercel-project-id
```

**Triggers automatically on push to `main`.**

### 2. Manual Release

**Workflow:** `.github/workflows/release-manual.yml`

Create releases manually via GitHub UI.

**To use:**

1. Go to Actions → Manual Release
2. Click "Run workflow"
3. Enter version (e.g., `1.0.0`)
4. Optionally add release notes
5. Click "Run workflow"

### 3. Tag-Based Release

**Workflow:** `.github/workflows/release-tag.yml`

Creates releases when you push a version tag.

**To use:**

```bash
# Create and push a tag
git tag v1.0.0
git push origin v1.0.0

# For pre-releases
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1
```

## Quick Start for Releases

### Using Semantic Release (Recommended)

Just commit using conventional commit format and push to main:

```bash
git commit -m "feat: add new deployment workflow"
git push origin main
```

### Using Manual Release

Go to Actions → Manual Release → Run workflow

### Using Tags

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Configuration

The semantic release is configured via `.releaserc.json` in the repository root.
