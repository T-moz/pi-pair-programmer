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

### One-time maintainer setup

1. Create the GitHub environment **`npm`** in repository Settings → Environments. Restrict deployment branches to **`main`** only (no tags). Do not require environment approval if releases should be fully automatic.
2. Protect `main`: require pull requests and the CI `check` status, disallow force pushes, and restrict bypass permissions. Review changes to the workflow and package manifest carefully: merges to `main` authorize releases. Direct pushes to `main` also trigger the workflow if branch protection permits them.
3. Push the workflow to GitHub. If the npm package does not yet exist, publish the first version locally after checks and tarball inspection:

   ```sh
   npm run check
   npm pack --dry-run --ignore-scripts
   npm publish --access public --ignore-scripts
   ```

   Complete npm's browser/2FA prompt. The first CI publish may fail until this bootstrap and trusted-publisher setup are complete; rerun the failed job afterward.

4. Configure the trusted publisher using the pinned npm CLI:

   ```sh
   npm exec --yes --package=npm@12.1.0 -- npm trust github pi-pair-programmer \
     --repository T-moz/pi-pair-programmer --file ci.yml --environment npm \
     --allow-publish --yes
   ```

   Complete npm's browser/2FA prompt. The workflow filename is not a full path. Stage-only publishing requires manual approval and will not support this automatic workflow.

5. Require two-factor authentication and disallow traditional publishing tokens:

   ```sh
   npm access set mfa=publish pi-pair-programmer
   ```

   OIDC publishing remains allowed. No npm secret needs to be added to GitHub. Verify the publisher with `npm exec --yes --package=npm@12.1.0 -- npm trust list pi-pair-programmer`.

### Releasing an update

In the release pull request, bump the version and commit both manifests:

```sh
npm version patch --no-git-tag-version
```

Use `minor` or `major` instead for those releases. Merge the PR into `main`; CI checks it and publishes the new version automatically. Merging without a version bump runs checks but does not publish another version. Re-running a successful release skips the immutable npm version.

Keep the `pi-package` keyword: public npm releases are eligible for the Pi package gallery after indexing. OMP marketplace catalog publication is separate from npm publishing.
