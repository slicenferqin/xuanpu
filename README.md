<div align="center">
  <img src="resources/banner.png" alt="玄圃 Xuanpu Workbench" width="100%" />
  <p><strong>面向构建者的 AI 原生工作台</strong></p>
  <p>不是把 AI 塞进传统编辑器，而是把项目、上下文、任务、Agent、变更和产物放进同一个工作台。</p>
  <p>
    <a href="https://xuanpu.clawplay.club"><strong>官网</strong></a>
    ·
    <a href="./README.md"><strong>简体中文</strong></a>
    ·
    <a href="./README.en.md">English</a>
  </p>

  <p>
    <a href="https://github.com/slicenferqin/xuanpu/releases/latest"><img src="https://img.shields.io/github/v/release/slicenferqin/xuanpu?style=flat-square&logo=github&label=version" alt="Latest Release" /></a>
    <a href="https://github.com/slicenferqin/xuanpu/releases"><img src="https://img.shields.io/github/downloads/slicenferqin/xuanpu/total?style=flat-square&logo=github" alt="Downloads" /></a>
    <a href="https://github.com/slicenferqin/xuanpu/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/slicenferqin/xuanpu/release.yml?style=flat-square&logo=github-actions&label=build" alt="Build Status" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS_%7C_Windows-111827?style=flat-square&logo=apple&logoColor=white" alt="macOS | Windows" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
  </p>
</div>

## 玄圃是什么

玄圃是一款面向构建者的 AI 原生工作台。它不是“给编辑器加一个聊天框”，也不是“把终端换个皮肤”，而是把真实工作流里的几个一等公民放回桌面端：

- `Workspace`：你的项目、仓库、关联仓库和上下文边界
- `Worktree`：并行推进任务时的隔离执行面
- `Session`：Agent 真正工作的线程，而不是一次性问答
- `Connections`：跨 worktree、跨仓库共享上下文
- `Changes`：文件、diff、命令输出、执行轨迹、审批、问题

如果你平时会同时推进多个功能、多个分支、多个 Agent，会遇到这些痛点：

- 终端和标签页越来越多，不知道哪个 Agent 在做什么
- 不同任务共用一个分支，改动互相污染
- 前后端或多个仓库来回切换，脑子里的上下文断裂
- AI 在生成、编辑、提问、等待审批时，状态分散在不同工具里

玄圃的目标就是把这些事情收拢到一个统一工作台里。

> **📖 v1.4.0 节点**：玄圃刚刚完成从"加了 Hub 的 Electron 工作台"到"为 Agent 提供现场"的关键转折。
> 详见：[**从 1.3 到 1.4：玄圃对 AI 原生工作台的思考与推进**](./docs/essays/2026-04-25-from-1-3-to-1-4-ai-native-workbench.md)

## 当前能力

**工作台基础**：

- 项目 / worktree / space 管理
- Claude Code、OpenCode、Codex 三类本地 Agent 接入
- 会话流式输出、权限审批、问题应答、任务跟踪
- 文件树、git 状态、内联 diff、Monaco diff、图片 diff
- 内置终端、setup / run 脚本入口、命令运行状态
- worktree connections，用于跨分支和跨仓库共享上下文
- headless 模式，基于 GraphQL + WebSocket 复用同一套本地数据库和服务
- 中文界面、本地化文案、首次启动环境检查与 Agent 引导

**v1.4 现场感知**（[详细说明](./docs/essays/2026-04-25-from-1-3-to-1-4-ai-native-workbench.md)）：

- **现场事件流**：每条 bash 命令、文件读写、terminal 输出、agent 工具调用都被结构化沉淀到 SQLite，按 worktree 分片
- **分层记忆**：Working / Episodic（Claude Haiku 真摘要）/ Semantic（用户写的 `memory.md`）三层，跨 agent 共享
- **现场注入**：每条 prompt 自动前置 Field Context（worktree、当前焦点、最近活动、上次 abort 时正在做什么），不需要你重复"翻译"
- **会话 Checkpoint**：abort、关电脑、崩溃后下次启动自动续上现场
- **Hub 远程移动端**：桌面开服务，手机扫码就接管会话；同一份现场跨设备
- **新版 Session UI（v2）**：统一 timeline、三态 Composer、Agent Rail、Field Context Debug 面板

这意味着它已经不只是一个"方便看文件的 Electron 壳"，而是一套能让 Agent 真正感知现场的桌面工作台。

## 玄圃不是 IDE，是"agent 的现场提供者"

打开 Cursor、Claude Code、Codex、Amp，本质都是同一种交互：用户的意图 → 翻译成自然语言 → 打字进输入框 → 模型回复。

**问题不是模型不够聪明，是模型看不见"现场"** —— 你在哪个 worktree、哪个文件、刚才跑了什么命令、上一小时在做什么、上次 abort 时正在干嘛。这些信息对人类协作者天然可见，对 AI 完全不可见。

玄圃做的事情就是把这一层视野从用户大脑搬到 agent 的 prompt 里。它的差异化不在 UI（虽然也重写了），不在 agent 模型（不自研），而在**能让任何 agent 在玄圃里都比在自己原生环境里更强 —— 因为它们第一次获得了现场**。

完整论述见：[VISION](./docs/VISION.md) 和 [v1.4.0 节点回顾](./docs/essays/2026-04-25-from-1-3-to-1-4-ai-native-workbench.md)。

## 安装

当前建议的使用方式：

### 直接下载

从 [GitHub Releases](https://github.com/slicenferqin/xuanpu/releases/latest) 下载最新构建。

| 平台                  | 文件                           | 说明              |
| --------------------- | ------------------------------ | ----------------- |
| macOS (Apple Silicon) | `Xuanpu-x.x.x-arm64.dmg`       | M1 / M2 / M3 / M4 |
| macOS (Intel)         | `Xuanpu-x.x.x.dmg`             | Intel Mac         |
| Windows (x64)         | `Xuanpu-Setup-x.x.x.exe`       | 64-bit 安装包     |
| Windows (ARM)         | `Xuanpu-Setup-x.x.x-arm64.exe` | ARM64 安装包      |

> **macOS 安装提示**：当前版本未经 Apple 签名。打开 DMG 后，双击里面的
> `Install Xuanpu.command`，它会自动复制到 `/Applications`、执行去隔离命令并打开应用。
> 如果脚本不可用，也可以手动执行：
>
> ```bash
> /usr/bin/xattr -cr "/Applications/玄圃.app"
> ```
>
> 或者：系统设置 → 隐私与安全性 → 点击「仍要打开」。
>
> **Windows 安装提示**：安装包未签名，Windows SmartScreen 可能会弹出警告。
> 点击「更多信息」→「仍要运行」即可。

### 从源码启动

```bash
pnpm install
pnpm dev
```

### 当前平台状态

- `macOS`：主支持平台
- `Windows`：已有打包链路，持续验证中
- `Linux`：目标平台之一，仍在逐步补齐体验

## 快速开始

1. 添加本地 git 仓库作为项目
2. 为当前任务创建独立 worktree
3. 在 worktree 中启动 Agent session
4. 在右侧查看文件、diff、运行结果和变更
5. 必要时通过 connections 把相关 worktree / 仓库连接进来

如果你习惯用键盘操作，命令面板、会话切换、侧栏切换、终端与文件区协同会比较顺手。

<p>
  <a href="https://github.com/slicenferqin/xuanpu/releases"><img src="https://img.shields.io/github/downloads/slicenferqin/xuanpu/total?style=flat-square&label=total%20downloads&color=blue" alt="Total Downloads" /></a>
  <a href="https://github.com/slicenferqin/xuanpu/releases/latest"><img src="https://img.shields.io/github/downloads/slicenferqin/xuanpu/latest/total?style=flat-square&label=latest%20release&color=brightgreen" alt="Latest Release Downloads" /></a>
</p>

📊 [查看完整下载统计 →](https://greedeks.github.io/Pulse/?username=slicenferqin&repo=xuanpu)

## 仓库现状

当前仓库是桌面端主仓，核心栈如下：

- Electron 33
- React 19
- TypeScript 5.7
- Tailwind CSS 4
- Zustand 5
- SQLite / better-sqlite3

架构上采用三层：

- `src/main/`：主进程、数据库、服务、IPC
- `src/preload/`：安全桥接层
- `src/renderer/`：React UI

另外还保留了一套 `headless` 服务入口，使桌面端和自动化/远程控制共用同一套本地核心能力。

## 当前优先方向

v1.4.0 把"现场"打通了第一公里。1.4.x 的核心是**让记忆变得可见可编辑**：

- **1.4.1 Pinned Facts**：用户能在 GUI 里直接钉住"这个项目用 pnpm"这种永久事实
- **1.4.2 Memory 面板**：把 4-tab Field Context Debug 升级为完整的 Memory 面板，能看见 + 编辑 + 重置 + 重新生成
- **1.4.3 成本可见**：本月压缩消耗了多少 token / ¥X，明明白白告诉用户
- **1.4.4 跨 agent 注入质量验证**：实测 Codex / OpenCode / Amp 收到 Field Context prefix 是真用还是当垃圾忽略

更远的第二圈（VISION §3.2）是 **XFP（Xuanpu Field Protocol）** —— 让任何 agent 厂商能用同一套协议获取现场，把"在玄圃里 agent 比在原生环境里更强"做成标准。

完整路线图：[docs/plans/2026-04-25-memory-product-direction.md](./docs/plans/2026-04-25-memory-product-direction.md)

如果你现在打开仓库，会看到一些仍在演进中的部分，这是正常状态。玄圃正在从早期 fork 产物，过渡到独立产品主线。

## 致谢与来源

玄圃起步于对 [Hive](https://github.com/slicenferqin/xuanpu) 的 fork / 演化。最初很多工程基础、工作台结构和产品启发都来自 Hive。当前这条产品线已经开始沿着中文工作流、桌面端交互和独立品牌方向持续分化，但对原项目的致谢应该保留。

## 贡献

欢迎贡献，尤其是这些方向：

- 中文文案和本地化体验
- 桌面端 UI/UX 打磨
- Windows / Linux 兼容性
- 测试、发布链路、安装体验
- 文档与设计资产整理

## 许可

本项目基于 [MIT License](./LICENSE) 开源。
