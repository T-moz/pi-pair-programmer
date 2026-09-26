# Contributing

Fork the repo and open a pull request. For vulnerabilities, use [private reporting](SECURITY.md), not an issue.

Code should work in Pi, not just pass checks.

1. Install dependencies: `npm install` (Node.js 22.19+).
2. Run `npm run check` (or `bun run check`). It checks types, lint, formatting, and tests; every source file must reach 100% coverage.
3. For behavior changes, run `./node_modules/.bin/pi --extension ./src/index.ts` and try the affected command or event.

Fix lint findings rather than hiding them. If a rule does not apply, use a narrowly scoped configuration exception. Run `npm run format` to fix formatting.

We use TypeScript 6 until the typed linter supports 7.

## Publishing to npm

`.github/workflows/ci.yml` publishes an unpublished `package.json` version after checks pass on a push to `main` (including merges). An already-published version is skipped; registry errors fail the job. The workflow does not bump versions or create commits or tags.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) with short-lived GitHub OIDC credentials and provenance, not an `NPM_TOKEN` secret. The publish job runs separately from checks, without project dependencies, caches, or package lifecycle scripts. GitHub Actions are pinned to commit SHAs and the publishing npm CLI is pinned to a version.

### Releasing an update

In the release pull request, bump the version and commit both manifests:

```sh
npm version patch --no-git-tag-version
```

Use `minor` or `major` instead for those releases. Merge the PR into `main`; CI checks it and publishes the new version automatically. Merging without a version bump runs checks but does not publish another version. Re-running a successful release skips the immutable npm version.

Keep the `pi-package` keyword: public npm releases are eligible for the Pi package gallery after indexing. OMP marketplace catalog publication is separate from npm publishing.
