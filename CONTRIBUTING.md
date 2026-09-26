# Contributing

Fork the repo and open a pull request. For vulnerabilities, use [private reporting](SECURITY.md), not an issue.

Code should work in Pi, not just pass checks.

1. Install dependencies: `npm install` (Node.js 22.19+).
2. Run `npm run check` (or `bun run check`). It checks types, lint, formatting, and tests; every source file must reach 100% coverage.
3. For behavior changes, run `./node_modules/.bin/pi --extension ./src/index.ts` and try the affected command or event.

Fix lint findings rather than hiding them. If a rule does not apply, use a narrowly scoped configuration exception. Run `npm run format` to fix formatting.

We use TypeScript 6 until the typed linter supports 7.

## Publishing to npm

`.github/workflows/ci.yml` publishes a new patch version after checks pass on each push to `main` (including merges): `0.1.0` → `0.1.1` → `0.1.2`. CI reads npm's `latest` version, increments its patch number, and updates `package.json` and `package-lock.json` only in the release checkout. npm is the release version source of truth; CI does not push version commits or create tags.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) with short-lived GitHub OIDC credentials and provenance, not an `NPM_TOKEN` secret. The publish job runs separately from checks, without project dependencies, caches, or package lifecycle scripts. GitHub Actions are pinned to commit SHAs and the publishing npm CLI is pinned to a version.

### Releasing an update

Merge the PR into `main`; no manual version bump is needed. Every successful deployment, including documentation-only changes, publishes the next patch version. The checked-in manifest versions are not advanced by CI.

Workflow runs for the same ref are queued, including their checks, rather than canceling pending deployments (up to GitHub's 100-pending-run limit). npm's recorded `gitHead` identifies already-published commits, so rerunning a successful release skips publication even after newer versions have shipped. Registry errors, an invalid `latest` tag, or an existing target version fail the release instead of guessing a version. After fixing a failed release, rerun the workflow.

Keep the `pi-package` keyword: public npm releases are eligible for the Pi package gallery after indexing. OMP marketplace catalog publication is separate from npm publishing.
