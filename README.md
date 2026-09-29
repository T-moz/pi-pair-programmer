<a id="top"></a>

<div align="center">

# 🧑‍💻 Pi Pair Programmer

**Background code review for [Pi](https://pi.dev/docs/extensions) and [OMP](https://omp.sh/docs/extension-authoring).**

[![CI](https://github.com/T-moz/pi-pair-programmer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/T-moz/pi-pair-programmer/actions/workflows/ci.yml)
[![Coverage: 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](vitest.config.ts)
[![npm version](https://img.shields.io/npm/v/pi-pair-programmer)](https://www.npmjs.com/package/pi-pair-programmer)
[![npm downloads](https://img.shields.io/npm/dm/pi-pair-programmer)](https://www.npmjs.com/package/pi-pair-programmer)
[![Node](https://img.shields.io/node/v/pi-pair-programmer)](package.json)
[![TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6)](tsconfig.json)
[![License](https://img.shields.io/npm/l/pi-pair-programmer)](LICENSE)

[**Why**](#-why) · [**Install**](#-install) · [**Use**](#-use) · [**How it works**](#-how-it-works)

<br />

![Pi Pair Programmer workflow: coding agent writes code, focused reviewers filter findings, then the agent accepts or rejects feedback before continuing](assets/pair-programmer-overview.png)

</div>

---

## 🤔 Why

> **Coding with AI adds entropy to a codebase.**
> Agents optimize for local correctness instead of thinking about the global system. They repeat code and reinvent the wheel.

Turn-by-turn static analysis is necessary but not sufficient.
Code review happens too late in the code production pipeline.

<p align="center">
  <img src="assets/cost-to-fix.svg" alt="Cost to fix rises from standards and static analysis to PR checks, AI PR review, and human PR review; Pi Pair Programmer reviews right after each write" />
</p>

This extension lets you run multiple highly specialized reviewers, each focused on a specific concern, to catch issues static analysis cannot detect, as soon as code is generated. Without bloating the context window, thanks to a Jev-based filter that removes inherited and duplicate findings.

---

## 📦 Install

Install the published [npm package](https://www.npmjs.com/package/pi-pair-programmer).

<table>
<tr>
<th>With Pi</th>
<th>With OMP</th>
</tr>
<tr>
<td>

```sh
pi install npm:pi-pair-programmer
```

</td>
<td>

```sh
omp install pi-pair-programmer
```

</td>
</tr>
</table>

Restart Pi or OMP after installation to load the extension.

🔑 For the Jev filter, set your TypeSafe API key before starting Pi or OMP:

```sh
export TYPESAFE_API_KEY="your-api-key"
```

> [!NOTE]
> Without it, reviews still run, but only exact duplicate findings are filtered.

---

## 🧭 Use

Reviews are on by default. After each successful `write` or `edit`, reviewers run in the background. The coding agent must accept or reject each finding with a reason before continuing with other tools. Accepted findings appear in your transcript as compact cards; rejected ones stay out of the transcript and are listed in the review feed (`/pair-feed`). Click a card (fullscreen mode) or press `ctrl+o` to expand it.

| Command                 | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/pair-programmer`      | Toggle reviews.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/pair-clear`           | Cancel reviews and clear all findings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/pair-feed` or `alt+r` | Toggle a live review sidebar on the right. It lists running reviews and reviews with accepted or rejected findings, newest first. Each review is one row with its file, reviewer and verdict counts; click it (fullscreen mode) to show its duration, decided findings and the agent's reasons. Reviews with no findings, undecided findings, failures and superseded reviews are left out. It never takes keyboard focus, hides in terminals narrower than 90 columns, and holds up to 100 reviews for the current session; `/pair-clear` empties it. |
| `/pair-stats`           | Open a themed session overview with review activity, findings, and estimated cost. Press `d` for detailed token and model accounting, `h` for hotspots (files ranked by accepted findings on the selected branch), `o` to return to the overview, `r` to refresh the snapshot, arrows or Page Up/Down to scroll, and Esc, Enter, or `q` to close. Missing usage stays unknown; review usage covers the session across branches, while findings reflect the selected branch.                                                                            |

The default reviewer uses your current model and asks: _“Does it add entropy?”_ To change the prompt, model, or files reviewed, create `pair-programmer.reviewers.json` in your working directory:

```json
{
  "reviewers": [
    {
      "name": "entropy",
      "model": "current",
      "prompt": "Does this code add entropy?",
      "include": ["**/*.dart"],
      "exclude": ["**/*.g.dart", "**/*_test.dart"]
    },
    {
      "model": "current",
      "prompt": "Does this code reinvent the wheel instead of reusing code or a library?",
      "include": ["**/*.dart"],
      "exclude": ["**/*.g.dart", "**/*_test.dart"]
    }
  ]
}
```

The optional `name` (1–24 characters) labels the reviewer in the sidebar and chat cards; unnamed reviewers show their model name, and renaming a reviewer keeps its review history. Use `current` or a `provider/model` identifier. File patterns are relative to your working directory; exclusions take precedence. Add entries for more reviewers.

A small badge pinned to the top-right corner shows whether reviews are watching, running, queued, awaiting a decision, or paused. It never takes keyboard focus, stays visible when extensions such as zentui hide the footer, and hides in terminals narrower than 40 columns. Outside Pi's terminal UI (RPC, OMP), it falls back to a line above the editor. Accepted findings appear in the transcript with their location, evidence, and rationale.

> [!TIP]
> Diagnostics stay in files, never the terminal: OMP uses its native logs; Pi uses `~/.pi/agent/logs/pair-programmer/` (or `$PI_CODING_AGENT_DIR/logs/pair-programmer/`).

---

## 🔍 How it works

<p align="center">
  <img src="assets/pair-programmer-workflow.svg" alt="Review workflow: background reviewers, Jev filters, and the accept/reject gate" />
</p>

<div align="center">

<sub>Released under the [MIT License](LICENSE) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)</sub>

<a href="#top">⬆ Back to top</a>

</div>
