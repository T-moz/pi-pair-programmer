# Contributing

Fork the repo and open a pull request. For vulnerabilities, use [private reporting](SECURITY.md), not an issue.

Code should work in Pi, not just pass checks.

1. Install dependencies: `npm install` (Node.js 22.19+).
2. Run `npm run check` (or `bun run check`). It checks types, lint, formatting, and tests; every source file must reach 100% coverage.
3. For behavior changes, run `./node_modules/.bin/pi --extension ./src/index.ts` and try the affected command or event.

Fix lint findings rather than hiding them. If a rule does not apply, explain a narrow exception beside the code. Run `npm run format` to fix formatting.

We use TypeScript 6 until the typed linter supports 7.
