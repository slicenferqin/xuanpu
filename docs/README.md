# 玄圃 — 项目文档索引

## 目录结构

```
docs/
├── prd/                    # 产品需求文档 (PRD)
│   ├── phase-02~20.md      # 桌面端各阶段需求
│   ├── PRD_ANALYTICS.md    # 数据分析需求
│   ├── PRD_TITLES.md       # 会话标题生成需求
│   ├── PRD_VIM.md          # Vim 模式需求
│   └── PRD_WORKTREE_CONNECTION.md
│
├── implementation/         # 实现方案文档
│   ├── phase-03~20.md      # 各阶段实现方案
│   ├── IMPLEMENTATION_ANALYTICS.md
│   ├── IMPLEMENTATION_CODEX.md
│   ├── IMPLEMENTATION_TITLE.md
│   ├── IMPLEMENTATION_VIM.md
│   └── IMPLEMENTATION_WORKTREE_CONNECTION.md
│
├── specs/                  # 技术规格
│   ├── agent-sdk-integration.md
│   ├── context-calculation.md
│   ├── permissions.md
│   └── title-generation.md
│
├── plans/                  # 活跃计划与方案设计
│   └── 2026-03-*           # 近期产品方向与技术方案
│
├── mockups/                # UI 原型 (HTML)
│
├── superpowers/            # Superpowers 功能设计
│
├── archive/                # 归档文档
│   └── plans/              # 早期开发计划 (2月) + 移动端方案
│
├── GUIDE.md                # 用户使用指南
├── FAQ.md                  # 常见问题
├── SHORTCUTS.md            # 快捷键参考
├── distribution-audit.md   # 分发审计
└── session-title-generation.md
```

## 根目录文档

| 文件 | 说明 |
|------|------|
| `CLAUDE.md` | Claude Code 编码指引（架构、命令、规范） |
| `AGENTS.md` | AI Agent 协作文档 |
| `README.md` / `README.en.md` | 项目介绍（中/英） |
| `CONTRIBUTING.md` | 贡献指南 |
| `SECURITY.md` | 安全策略 |
| `CODE_OF_CONDUCT.md` | 行为准则 |

## 快速查找

- **想了解某阶段做了什么？** → `prd/phase-XX.md`（需求）+ `implementation/phase-XX.md`（实现）
- **想了解技术设计细节？** → `specs/`
- **想了解近期产品方向？** → `plans/`
- **想找历史开发记录？** → `archive/plans/`
