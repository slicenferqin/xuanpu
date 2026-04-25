<div align="center">
  <img src="resources/banner.png" alt="Xuanpu Workbench" width="100%" />
  <p><strong>An AI-native workbench for builders.</strong></p>
  <p>Not a chat box bolted onto an editor. A workspace where projects, context, tasks, agents, changes, and outputs live together.</p>
  <p><a href="./README.md">简体中文</a> | <a href="./README.en.md"><strong>English</strong></a></p>

  <p>
    <a href="https://github.com/slicenferqin/xuanpu/releases/latest"><img src="https://img.shields.io/github/v/release/slicenferqin/xuanpu?style=flat-square&logo=github&label=version" alt="Latest Release" /></a>
    <a href="https://github.com/slicenferqin/xuanpu/releases"><img src="https://img.shields.io/github/downloads/slicenferqin/xuanpu/total?style=flat-square&logo=github" alt="Downloads" /></a>
    <a href="https://github.com/slicenferqin/xuanpu/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/slicenferqin/xuanpu/release.yml?style=flat-square&logo=github-actions&label=build" alt="Build Status" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS_%7C_Windows-111827?style=flat-square&logo=apple&logoColor=white" alt="macOS | Windows" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
  </p>
</div>

## What Is Xuanpu
Xuanpu is an AI-native workbench for builders. It is not "an editor with an AI sidebar" or "a terminal with a new theme." It puts the real first-class units of modern work back on the desktop:

- `Workspace` — your projects, repos, linked repos, and the boundaries of your context
- `Worktree` — the isolated execution surface for parallel tasks
- `Session` — the thread an agent actually works in, not a one-shot Q&A
- `Connections` — context shared across worktrees and across repos
- `Changes` — files, diffs, command output, execution traces, approvals, questions

If you regularly juggle multiple features, branches, repos, and agents at once, you already know the pain:

- too many terminals and tabs — no idea which agent is doing what
- multiple tasks share one branch and pollute each other
- jumping between front-end / back-end / multiple repos shreds the context you held in your head
- agent generation, edits, questions, and approvals are scattered across different tools

Xuanpu's goal is to pull that workflow back into one coherent desktop workbench.

> **📖 v1.4.0 milestone**: Xuanpu just finished its turning point — from "an Electron workbench with Hub bolted on" to "a field provider for agents."
> Read more (Chinese): [**From 1.3 to 1.4: Xuanpu's thinking on the AI-native workbench**](./docs/essays/2026-04-25-from-1-3-to-1-4-ai-native-workbench.md)

## Current Capabilities

**Workbench foundation**:

- project / worktree / space management
- native session flows for Claude Code, OpenCode, and Codex
- streaming transcripts, permission approvals, question prompts, task tracking
- file tree, git status, inline diff, Monaco diff, image diff
- embedded terminal, setup / run script entry points, command run state
- worktree connections for cross-branch and cross-repo context sharing
- headless mode — same local DB and services exposed via GraphQL + WebSocket
- Chinese-first UI, localized copy, first-launch environment check and agent onboarding

**v1.4 field awareness** ([details, Chinese](./docs/essays/2026-04-25-from-1-3-to-1-4-ai-native-workbench.md)):

- **Field event stream** — every bash command, file read/write, terminal output, and agent tool call is structured into SQLite, sharded by worktree
- **Layered memory** — Working / Episodic (real summaries from Claude Haiku) / Semantic (your `memory.md`), shared across agents
- **Field injection** — every prompt is automatically prefixed with Field Context (worktree, current focus, recent activity, what you were doing when you last hit abort), so you don't have to "translate" yourself again
- **Session checkpoints** — abort, sleep, or crash, the next launch picks the field back up
- **Hub remote / mobile** — desktop runs the service, your phone scans the QR code and takes over the session; the same field follows you across devices
- **New Session UI (v2)** — unified timeline, three-state Composer, Agent Rail, Field Context Debug panel

This means it's no longer just "a convenient Electron shell for browsing files" — it's a desktop workbench that actually lets agents see the field they're operating in.

## Xuanpu Is Not an IDE — It's a Field Provider for Agents

Open Cursor, Claude Code, Codex, or Amp and at heart it's the same interaction: user intent → translate to natural language → type into a box → model replies.

**The problem isn't that the model isn't smart enough — it's that the model can't see the field.** Which worktree you're in, which file is open, what command you just ran, what you've been doing the last hour, what you were doing when you last hit abort. All of this is naturally visible to a human collaborator and completely invisible to the AI.

What Xuanpu does is move that visibility layer out of the user's head and into the agent's prompt. Its differentiation isn't in the UI (we did rewrite it), and not in the agent model (we don't train one) — it's that **any agent inside Xuanpu becomes more capable than in its native environment, because for the first time it gets a field**.

Full reasoning: [VISION](./docs/VISION.md) and the [v1.4.0 retrospective](./docs/essays/2026-04-25-from-1-3-to-1-4-ai-native-workbench.md) (Chinese).

## Install
### Releases
Download the latest build from [GitHub Releases](https://github.com/slicenferqin/xuanpu/releases/latest).

| Platform | File | Note |
|----------|------|------|
| macOS (Apple Silicon) | `Xuanpu-x.x.x-arm64.dmg` | M1 / M2 / M3 / M4 |
| macOS (Intel) | `Xuanpu-x.x.x.dmg` | Intel Mac |
| Windows (x64) | `Xuanpu-Setup-x.x.x.exe` | 64-bit installer |
| Windows (ARM) | `Xuanpu-Setup-x.x.x-arm64.exe` | ARM64 installer |

> **macOS note**: The current build is unsigned. On first launch macOS will show an "unidentified developer" warning.
> Run this in Terminal, then reopen the app:
> ```bash
> /usr/bin/xattr -cr "/Applications/玄圃.app"
> ```
> Or: System Settings → Privacy & Security → click "Open Anyway".
>
> **Windows note**: The installer is unsigned. Windows SmartScreen may show a warning.
> Click "More info" → "Run anyway".

### Run From Source
```bash
pnpm install
pnpm dev
```

### Platform Status
- `macOS`: primary platform, full feature set including Ghostty terminal
- `Windows`: supported — all core features work; Ghostty terminal is macOS-only
- `Linux`: planned target, still evolving

## Quick Start
1. Add a local git repo as a project
2. Create a dedicated worktree for the current task
3. Start an agent session inside that worktree
4. Browse files, diffs, run output, and changes on the right
5. When you need it, pull related worktrees / repos in via connections

If you live on the keyboard, the command palette, session switcher, sidebar toggles, and terminal/file pane interplay should feel natural.

<p>
  <a href="https://github.com/slicenferqin/xuanpu/releases"><img src="https://img.shields.io/github/downloads/slicenferqin/xuanpu/total?style=flat-square&label=total%20downloads&color=blue" alt="Total Downloads" /></a>
  <a href="https://github.com/slicenferqin/xuanpu/releases/latest"><img src="https://img.shields.io/github/downloads/slicenferqin/xuanpu/latest/total?style=flat-square&label=latest%20release&color=brightgreen" alt="Latest Release Downloads" /></a>
</p>

📊 [View full download analytics →](https://greedeks.github.io/Pulse/?username=slicenferqin&repo=xuanpu)

## Repo Status
This repo is the desktop main line. Current stack:

- Electron 33
- React 19
- TypeScript 5.7
- Tailwind CSS 4
- Zustand 5
- SQLite / better-sqlite3

Architecture (three layers):

- `src/main/` — main process, database, services, IPC
- `src/preload/` — typed bridge
- `src/renderer/` — React UI

A `headless` service entry is also kept, so the desktop app and automation / remote control share the same local core.

## Current Priorities

v1.4.0 cracked the first mile of "field." The 1.4.x line is about **making memory visible and editable**:

- **1.4.3 release / onboarding hardening** — CI post-package verify, first-run onboarding card, README.en.md sync, Edit/Write diff preview, Composer image large preview
- **1.4.4 Codex experience overhaul** — make Codex inside Xuanpu actually feel native
- **1.4.5 Memory panel** — promote the 4-tab Field Context Debug into a real Memory panel: see + edit + reset + regenerate
- **1.4.6 Cost visibility** — token / ¥ spend on compaction, surfaced clearly per month
- **1.4.x cross-agent injection quality** — empirically verify Codex / OpenCode / Amp are *using* the Field Context prefix, not silently dropping it

The next ring (VISION §3.2) is **XFP (Xuanpu Field Protocol)** — let any agent vendor obtain the field through a shared protocol, so "agents are stronger inside Xuanpu" becomes a standard, not a moat.

Full roadmap (Chinese): [docs/plans/2026-04-25-memory-product-direction.md](./docs/plans/2026-04-25-memory-product-direction.md)

If you open the repo today you'll see parts that are still in motion — that's expected. Xuanpu is transitioning from an early fork into a standalone product line.

## Origins
Xuanpu started as a fork / evolution of [Hive](https://github.com/slicenferqin/xuanpu). A meaningful part of the original engineering foundation, workbench structure, and product inspiration came from Hive. This product line has since diverged toward Chinese-first workflow, desktop-native interaction, and an independent brand, but credit to the original should stay visible.

## Contributing
Contributions are especially valuable in these areas:

- Chinese workflow and localization
- desktop UI/UX polish
- Windows / Linux support
- release engineering and install experience
- documentation and design assets

## License
This project is licensed under the [MIT License](./LICENSE).
