<a id="top"></a>

<div align="center">

# 🧑‍💻 Pi Pair Programmer

**Background code review for [Pi](https://pi.dev/docs/extensions) and [OMP](https://omp.sh/docs/extension-authoring).**

[![CI](https://img.shields.io/github/actions/workflow/status/T-moz/pi-pair-programmer/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI)](https://github.com/T-moz/pi-pair-programmer/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen?style=for-the-badge&logo=vitest&logoColor=white)](vitest.config.ts)
[![npm](https://img.shields.io/npm/v/pi-pair-programmer?style=for-the-badge&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/pi-pair-programmer)
[![Downloads](https://img.shields.io/npm/dm/pi-pair-programmer?style=for-the-badge&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/pi-pair-programmer)

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Node](https://img.shields.io/node/v/pi-pair-programmer?style=flat-square&logo=nodedotjs&logoColor=white&color=339933)](package.json)
[![Pi extension](https://img.shields.io/badge/Pi-extension-8a2be2?style=flat-square)](https://pi.dev/docs/extensions)
[![OMP extension](https://img.shields.io/badge/OMP-extension-ff6f00?style=flat-square)](https://omp.sh/docs/extension-authoring)
[![npm provenance](https://img.shields.io/badge/npm-provenance-2ea44f?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-pair-programmer#provenance)
[![License: MIT](https://img.shields.io/github/license/T-moz/pi-pair-programmer?style=flat-square&color=blue)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=flat-square)](CONTRIBUTING.md)

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

This extension lets you run multiple highly specialized reviewers, each focused on a specific concern, to catch issues static analysis cannot detect as soon as code is generated. Without bloating the context window, thanks to a Jev-based filter that removes inherited and duplicate findings.

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

Reviews are on by default. After each successful `write` or `edit`, reviewers run in the background. The coding agent must accept or reject each finding with a reason before continuing with other tools. Only accepted findings appear in your transcript.

| Command            | Action                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `/pair-programmer` | Toggle reviews.                                                                                     |
| `/pair-clear`      | Cancel reviews and clear all findings.                                                              |
| `/pair-stats`      | View review activity, findings, tokens, and estimated costs on demand; missing usage stays unknown. |

The default reviewer uses your current model and asks: _“Does it add entropy?”_ To change the prompt, model, or files reviewed, create `pair-programmer.reviewers.json` in your working directory:

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

Use `current` or a `provider/model` identifier. File patterns are relative to your working directory; exclusions take precedence. Add entries for more reviewers.

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
