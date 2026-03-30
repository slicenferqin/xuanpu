<div align="center">
  <img src="resources/banner.png" alt="玄圃 Xuanpu Workbench" width="100%" />
  <p><strong>面向构建者的 AI 原生工作台</strong></p>
  <p>不是把 AI 塞进传统编辑器，而是把项目、上下文、任务、Agent、变更和产物放进同一个工作台。</p>
  <p><a href="./README.md"><strong>简体中文</strong></a> | <a href="./README.en.md">English</a></p>

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

## 当前能力
当前主线已经具备一套比较完整的本地 AI 开发工作流：

- 项目 / worktree / space 管理
- Claude Code、OpenCode、Codex 三类本地 Agent 接入
- 会话流式输出、权限审批、问题应答、任务跟踪
- 文件树、git 状态、内联 diff、Monaco diff、图片 diff
- 内置终端、setup / run 脚本入口、命令运行状态
- worktree connections，用于跨分支和跨仓库共享上下文
- headless 模式，基于 GraphQL + WebSocket 复用同一套本地数据库和服务
- 中文界面、本地化文案、首次启动环境检查与 Agent 引导

这意味着它已经不只是一个“方便看文件的 Electron 壳”，而是一套可以实际承载日常构建任务的桌面工作台。

## 为什么不是传统 IDE
玄圃刻意不把自己定义成传统 `IDE`，原因很直接：

- 你真正想推进的是“功能 / 任务 / 目标”，不是单个文件
- 一个真实任务通常会跨代码、文档、脚本、终端、评审、多个仓库
- AI 时代里，`session`、`approval`、`context`、`worktree isolation` 都应该是界面一等公民

所以玄圃更适合被理解成：

- `AI-native workbench`
- `future workspace for builders`
- `以任务推进为中心，而不是以文件编辑为中心`

## 安装
当前建议的使用方式：

### 直接下载
从 [GitHub Releases](https://github.com/slicenferqin/xuanpu/releases/latest) 下载最新构建。

| 平台 | 文件 | 说明 |
|------|------|------|
| macOS (Apple Silicon) | `Xuanpu-x.x.x-arm64.dmg` | M1 / M2 / M3 / M4 |
| macOS (Intel) | `Xuanpu-x.x.x.dmg` | Intel Mac |
| Windows (x64) | `Xuanpu-Setup-x.x.x.exe` | 64-bit 安装包 |
| Windows (ARM) | `Xuanpu-Setup-x.x.x-arm64.exe` | ARM64 安装包 |

> **macOS 安装提示**：当前版本未经 Apple 签名，首次打开时会提示"无法验证开发者"。
> 请在终端执行以下命令后重新打开：
> ```bash
> /usr/bin/xattr -cr /Applications/Xuanpu.app
> ```
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
当前主线的优先级很明确：

- 持续打磨中文工作流和桌面端交互
- 完成品牌切换、图标和视觉资产替换
- 稳定发布链路和安装体验
- 逐步把“项目中心”升级为“工作台中心”

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
