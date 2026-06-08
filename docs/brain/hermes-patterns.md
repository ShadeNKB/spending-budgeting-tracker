# Hermes Patterns — Provenance & Setup Notes

This brain borrows several patterns from **[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)** (MIT licensed). None of Hermes itself is cloned into this repo — we ported only the durable ideas as markdown.

## What we ported

| Brain file | Source skill | What we kept |
|---|---|---|
| `prompts/debug.md` | `skills/software-development/systematic-debugging` | 4-phase loop, Iron Law framing, anti-patterns list |
| `prompts/plan.md` | `skills/software-development/plan` | Plan-only mode, fixed save location, structure |
| `prompts/spike.md` | `skills/software-development/spike` | Decompose→build→verdict, Given/When/Then, disposability |
| `prompts/dogfood-qa.md` | `skills/dogfood` | 5-phase systematic web QA, evidence capture, severity grid |

We did *not* port: TDD skill (already have `tdd` global skill), subagent-driven-development (covered by `docs/orchestration.md`), pre-commit verification (covered by `qa-checklist.md` + `code-reviewer` agent).

## Why this approach over installing Hermes

Hermes is a standalone Python AI agent runtime (~255 MB, peer to Claude Code). Cloning it into this React/TS repo would bloat 50×, introduce Python deps, and serve no purpose — it can't be called from a React app. The patterns are universal; the runtime is incidental.

## If you want to actually run Hermes on your machine

Hermes is a Claude-Code alternative that brings a built-in learning loop (skills self-improve, periodic memory nudges, FTS5 session search across past conversations) and gateways for Telegram/Discord/Slack. It installs **outside this repo**.

**Windows install (PowerShell, native — early beta):**
```powershell
iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)
```
Lands at `%LOCALAPPDATA%\hermes`. Pulls Python 3.11, Node, ripgrep, ffmpeg, MinGit — fully isolated from system installs.

**WSL2 install (more battle-tested):**
```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```
Lands at `~/.hermes`.

**Then:**
```bash
hermes setup    # wizard — picks LLM provider, configures keys
hermes          # interactive CLI
```

You'd need an LLM API key (OpenRouter is cheapest for experimentation, Nous Portal if you want their own models). Hermes can operate on this project from outside it — point `hermes` at this folder and use it as you would Claude Code.

**Cost:** zero infra. Pay-as-you-go LLM calls only.

## What Hermes does that we don't (and probably can't, easily)

- **Self-improving skills** — Hermes mutates its own skill files based on outcomes. We don't (and shouldn't, on a solo project — skills should evolve by deliberate edit, not drift).
- **Cross-session memory with FTS5 search** — Hermes runs its own SQLite session DB. Claude Code has its own memory system (`~/.claude/memory/`) — different mechanism, same purpose.
- **Gateway to Telegram/Discord/Slack/etc.** — useful if you want to message the agent from your phone while it runs on a VPS. Not relevant for a solo PWA project.
- **Cron scheduler** — daily reports, nightly audits via the agent. We have `scripts/check-bundle-size.mjs` style automation in CI instead.

## License

All ported content is MIT, attributed to NousResearch in each file's header. Modifications to fit SpendTrack (paths, tooling, naming) are ours.
