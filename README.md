# Pi Pair Programmer

A TypeScript extension for [Pi](https://pi.dev/docs/extensions) and [OMP](https://omp.sh/docs/extension-authoring).

## Install

Install with Pi:

```sh
pi install git:github.com/T-moz/pi-pair-programmer
```

Or with OMP:

```sh
omp plugin install github:T-moz/pi-pair-programmer
```

Start a new session and run `/pair-programmer` to confirm it loaded. Extensions run with your account's permissions; review the source before installing.

## Develop locally

Requires Node.js 22.19 or newer:

```sh
npm ci
./node_modules/.bin/pi --extension ./src/index.ts
```

For OMP, run `omp --extension ./src/index.ts` instead.

For checks and contribution steps, see [CONTRIBUTING.md](CONTRIBUTING.md).
