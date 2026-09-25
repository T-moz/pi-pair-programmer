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

Reviews start **on** by default. After a successful `write` or `edit`, matching reviewers run in the background. Findings are delivered at the next turn/tool gate, not while you are editing; accept or reject each delivered finding with a reason using `pair_programmer_decide` before other tools. Review findings and decisions persist in the session branch. The gate allows direct `pair_programmer_decide` calls and OMP `write` calls targeting exactly `xd://pair_programmer_decide`; other calls, including ordinary writes, remain blocked while findings are outstanding. Each decision and its nonempty reason are persisted before the finding is cleared. Once no findings remain outstanding, verification, todo updates, and coding can resume.

Run `/pair-programmer` to toggle reviews. Turning off cancels queued and running reviews, discards undelivered findings, and removes pending finding messages; existing decisions remain saved. Turning back on reviews future writes, but does not resend old findings.

## Reviewers

Each reviewer's `prompt` defines its entire task. Nothing more. Findings must directly connect a criterion violation to concrete code evidence and a consequence relevant to that criterion. Surrounding code provides context. An empty result is a successful review when the criterion is satisfied or evidence is insufficient.

Without a config file, one reviewer uses the current model with the prompt “Does it add entropy ?”. To override it, create `pair-programmer.reviewers.json` in your working directory:

```json
{
  "reviewers": [
    {
      "model": "current",
      "prompt": "Does it add entropy ?",
      "include": ["src/**/*.ts"],
      "exclude": ["**/*.test.ts"]
    }
  ]
}
```

Only `model`, `prompt`, `include`, and `exclude` are supported for each reviewer. `model` may be `current` or a provider/model identifier. Include and exclude are project-relative POSIX globs; exclusions take precedence. An empty `reviewers` array disables automatic reviews. Semantic deduplication uses the TypeSafe SDK's `jev-latest` model and requires `TYPESAFE_API_KEY` in the extension's environment. Do not put credentials in the JSON file.

Extensions run with your account's permissions; review the source before installing.

## Develop locally

Requires Node.js 22.19 or newer:

```sh
npm ci
./node_modules/.bin/pi --extension ./src/index.ts
```

For OMP, run `omp --extension ./src/index.ts` instead.

For checks and contribution steps, see [CONTRIBUTING.md](CONTRIBUTING.md).
