<a id="top"></a>

<h1 align="center">Pi Pair Programmer</h1>

<p align="center">
  Background code review for <a href="https://pi.dev/docs/extensions">Pi</a> and <a href="https://omp.sh/docs/extension-authoring">OMP</a>.
</p>

<p align="center">
  <a href="https://github.com/T-moz/pi-pair-programmer/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/T-moz/pi-pair-programmer/ci.yml?branch=main&style=flat-square&logo=github&label=CI" /></a>
  <a href="vitest.config.ts"><img alt="Coverage: 100%" src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&logo=vitest&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/pi-pair-programmer"><img alt="npm version" src="https://img.shields.io/npm/v/pi-pair-programmer?style=flat-square&logo=npm" /></a>
  <a href="https://www.npmjs.com/package/pi-pair-programmer"><img alt="npm downloads" src="https://img.shields.io/npm/dm/pi-pair-programmer?style=flat-square" /></a>
  <a href="package.json"><img alt="Node version" src="https://img.shields.io/node/v/pi-pair-programmer?style=flat-square&logo=nodedotjs&logoColor=white" /></a>
  <a href="tsconfig.json"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white" /></a>
  <a href=".github/dependabot.yml"><img alt="Dependabot" src="https://img.shields.io/badge/dependabot-enabled-025e8c?style=flat-square&logo=dependabot" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/T-moz/pi-pair-programmer?style=flat-square" /></a>
</p>

<p align="center">
  <img src="assets/pair-programmer-overview.png" alt="Pi Pair Programmer workflow: coding agent writes code, focused reviewers filter findings, then the agent accepts or rejects feedback before continuing" />
</p>

<details open>
<summary><strong>Table of contents</strong></summary>

- [Why](#why)
- [Install](#install)
- [Use](#use)
  - [Commands](#commands)
  - [Configure reviewers](#configure-reviewers)
  - [Diagnostics](#diagnostics)
- [How it works](#how-it-works)

</details>

## Why

Coding with AI adds entropy to a codebase.
Agents optimize for local correctness instead of thinking about the global system. They repeat code and reinvent the wheel.

Turn-by-turn static analysis is necessary but not sufficient.
Code review happens too late in the code production pipeline.

![Cost to fix rises from standards and static analysis to PR checks, AI PR review, and human PR review; Pi Pair Programmer reviews right after each write](assets/cost-to-fix.svg)

This extension lets you run multiple highly specialized reviewers, each focused on a specific concern, to catch issues static analysis cannot detect as soon as code is generated. Without bloating the context window, thanks to a Jev-based filter that removes inherited and duplicate findings.

<p align="right"><a href="#top">↑ Back to top</a></p>

## Install

Install the published [npm package](https://www.npmjs.com/package/pi-pair-programmer).

<details open>
<summary><strong>With Pi</strong></summary>

```sh
pi install npm:pi-pair-programmer
```

</details>

<details>
<summary><strong>With OMP</strong></summary>

```sh
omp install pi-pair-programmer
```

</details>

Restart Pi or OMP after installation to load the extension.

<details>
<summary><strong>Optional: enable the Jev filter</strong></summary>

For the Jev filter, set your TypeSafe API key before starting Pi or OMP:

```sh
export TYPESAFE_API_KEY="your-api-key"
```

Without it, reviews still run, but only exact duplicate findings are filtered.

</details>

<p align="right"><a href="#top">↑ Back to top</a></p>

## Use

Reviews are on by default. After each successful `write` or `edit`, reviewers run in the background. The coding agent must accept or reject each finding with a reason before continuing with other tools. Only accepted findings appear in your transcript.

### Commands

- **`/pair-programmer`**: toggle reviews.
- **`/pair-clear`**: cancel reviews and clear all findings.
- **`/pair-stats`**: view review activity, findings, tokens, and estimated costs on demand; missing usage stays unknown.

### Configure reviewers

The default reviewer uses your current model and asks: “Does it add entropy?” To change the prompt, model, or files reviewed, create `pair-programmer.reviewers.json` in your working directory:

<details open>
<summary><code>pair-programmer.reviewers.json</code></summary>

```json
{
  "reviewers": [
    {
      "model": "current",
      "prompt": "Does it add entropy?",
      "include": ["src/**/*.ts"],
      "exclude": ["**/*.test.ts"]
    }
  ]
}
```

</details>

Use `current` or a `provider/model` identifier. File patterns are relative to your working directory; exclusions take precedence. Add entries for more reviewers.

### Diagnostics

Diagnostics stay in files, never the terminal: OMP uses its native logs; Pi uses `~/.pi/agent/logs/pair-programmer/` (or `$PI_CODING_AGENT_DIR/logs/pair-programmer/`).

<p align="right"><a href="#top">↑ Back to top</a></p>

## How it works

![Review workflow: background reviewers, Jev filters, and the accept/reject gate](assets/pair-programmer-workflow.svg)

<p align="right"><a href="#top">↑ Back to top</a></p>
