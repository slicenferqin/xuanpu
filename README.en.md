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
Xuanpu is an AI-native workbench for builders. It is not trying to be a traditional IDE with an AI sidebar. It treats the real units of modern work as first-class:

- `Workspace`
- `Worktree`
- `Session`
- `Connections`
- `Changes`
- `Outputs`

If you regularly juggle multiple tasks, branches, repos, and agents, you already know the pain:

- too many terminals and tabs
- unclear agent state
- polluted branches
- fragmented context across repos
- scattered approvals, diffs, questions, and outputs

Xuanpu exists to pull that workflow back into one coherent desktop workbench.

## What It Can Do Today
- Project, worktree, and space management
- Native session flows for Claude Code, OpenCode, and Codex
- Streaming transcripts, approvals, question prompts, and task tracking
- File tree, git status, inline diff, Monaco diff, and image diff
- Embedded terminal, setup/run scripts, and execution state
- Worktree connections for cross-branch and cross-repo context sharing
- Headless mode backed by the same local database and services
- Chinese-first UI and onboarding flow

## Why It Is Not Positioned As a Traditional IDE
Xuanpu is centered on task progression rather than file editing:

- what you move forward is a goal, not a single file
- one task usually spans code, docs, scripts, reviews, and multiple repos
- in the AI era, sessions, approvals, context, and worktree isolation deserve first-class UI

That is why `AI-native workbench` is a more accurate category than `IDE`.

## Install
### Releases
Download the latest build from [GitHub Releases](https://github.com/slicenferqin/xuanpu/releases/latest).

| Platform | File | Note |
|----------|------|------|
| macOS (Apple Silicon) | `Xuanpu-x.x.x-arm64.dmg` | M1 / M2 / M3 / M4 |
| macOS (Intel) | `Xuanpu-x.x.x.dmg` | Intel Mac |
| Windows | `Xuanpu-Setup-x.x.x.exe` | 64-bit installer |

> **macOS note**: The current build is unsigned. On first launch macOS will show an "unidentified developer" warning.
> Run this in Terminal, then reopen the app:
> ```bash
> xattr -cr /Applications/Xuanpu.app
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

## Repo Status
Current stack:

- Electron 33
- React 19
- TypeScript 5.7
- Tailwind CSS 4
- Zustand 5
- SQLite / better-sqlite3

Architecture:

- `src/main/`: Electron main process, database, services, IPC
- `src/preload/`: typed bridge
- `src/renderer/`: React UI
- `src/server/`: headless / remote GraphQL entry

## Origins
Xuanpu started as a fork / evolution of [Hive](https://github.com/slicenferqin/xuanpu). A meaningful part of the original engineering foundation and product inspiration came from Hive, and that credit should remain visible.

## Contributing
Contributions are especially valuable in these areas:

- Chinese workflow and localization
- desktop UI/UX polish
- Windows / Linux support
- release engineering and install experience
- documentation and design assets

## License
This project is licensed under the [MIT License](./LICENSE).
