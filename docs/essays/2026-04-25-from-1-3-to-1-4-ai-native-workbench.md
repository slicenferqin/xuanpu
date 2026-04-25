# 从 1.3 到 1.4：玄圃对 AI 原生工作台的思考与推进

**日期**：2026-04-25
**版本**：v1.4.0
**作者**：玄圃团队

---

## 引子：1.4.0 不只是一个版本号

四天前发布 v1.3.5 的时候，玄圃还可以被很简洁地概括成"加了 Hub 概念的 Electron 工作台"——一个比较顺手的项目/会话面板，一个还过得去的 git diff 视图，一个比 Cursor 多一层 worktree 隔离的 AI 集成壳。

今天发布的 v1.4.0 不是一个简单的版本递进。装上以后第一次启动会被一些微妙的东西击中：你只发了一句"这里怎么挂了"，agent 就准确地把视线跳到了你三十秒前编辑的那个文件；你昨晚 abort 的会话，今天打开的瞬间能看见 "184 分钟前在 pre-release 工作了 104 分钟，编辑了 12 个文件"——它真的记得；你在桌面端开 Hub 之后，掏出手机扫码就接管了刚才在跑的 Claude session。

这是 [VISION 文档](../VISION.md) 里写了半年的"为 Agent 提供一个现场，而不是一个对话框"第一次有一个能演示的载体。所以这一次发布值得专门写一篇文章：复盘我们做对了什么、做错了什么、看清了什么。

---

## 1. 为什么"输入框 + 聊天流"不是终点

VISION 文档里有一段比较激进的论断：**输入框是 AI 时代的实体键盘**。在那篇文档写下的时候，这个比喻还属于"可被接受的产品哲学"——你信也好、不信也罢，反正离它能被代码验证还有一段距离。

1.4.0 让这个论断第一次有了具体的反例。

打开任何主流 AI 产品——Cursor、Claude Code、Codex、Amp、ChatGPT Desktop——它们的本质是同一种交互：用户的意图 → 翻译成自然语言 → 打字进输入框 → 模型回复。**问题不是模型不够聪明，是模型看不见"现场"**。

什么叫现场？看一下 1.4.0 装好之后，agent 在每次响应你的瞬间真正读到的东西：

![Last Injection — agent 在每次回复前看到的现场快照](./screenshots/1.4.0-last-injection.png)

这是 v1.4.0 的 Field Context Debug 面板里的 Last Injection tab。它告诉你：你刚才发的那句"这里怎么挂了"在到达 Claude 之前，被前置了 ~801 tokens 的现场快照——你在哪个 worktree、上次会话什么时候 abort 的、当前 hot files 是哪几个、有几次提交是会话外做的。

**Claude 不需要问"哪里"，因为它已经看见了**。

这才是"现场"。它不是一个新的 chat UI，不是 agent 模型升级，不是 prompt engineering 优化。它是把人类协作时本来就共享的那一层视野——你在看哪个文件、你刚才跑了什么命令、你上一小时在做什么——**从用户大脑里搬到模型 prompt 里**。

去掉这一层，agent 就回到那个"被关在没有窗户的房间里、靠对讲机指挥"的角色。这就是为什么用户和 AI 的协作总有种"在跟一个失忆症患者结对编程"的感觉。

---

## 2. 玄圃在 1.4.0 真正走通的三件事

VISION §3 把玄圃的演化分成三个同心圆：单机现场离不开 → 跨 agent 标准化 → 跨设备流动。1.4.0 不是把第一圈做完，但**第一次让这三圈都有了能跑的 MVP**。

### 2.1 现场事件流（Field Event Stream）

每个发生在工作台里的动作——你跑的 bash 命令、读过的文件、改过的代码、终端输出、agent 工具调用、session 的每一条消息——都被结构化成一个 event 沉淀进 SQLite。这不只是日志，而是**有 schema 的、可查询的、按 worktree 分片的时间线**。

Phase 21 把基础事件采集做了。Phase 21.5 补了"agent 工具事件"——以前只有手敲终端的用户能产生事件，全代理用户因为不动手所以没有现场，这次也补上了。

它本身不是产品，是地基。但**没有这一层，后面所有的记忆和现场注入都是空话**。

### 2.2 分层记忆（Working / Episodic / Semantic Memory）

事件流是无限的、噪音的。要变成"agent 能读的现场"，必须分层压缩：

- **Working Memory**：刚才那张 Last Injection 截图——每次用户消息发出前实时合成的快照，包含最近事件 + 当前 hot files + 编辑器焦点。每条 prompt 都是新鲜的。
- **Episodic Memory**：6 小时滚动窗口的摘要。事件累积到阈值就触发压缩。1.4.0 同时实现了 rule-based（本地纯计数）和 Claude Haiku（真 LLM 摘要）两套 compactor，Haiku 失败时自动回退 rule-based。
- **Semantic Memory**：用户自己在 worktree 里写的 `memory.md`。这是给"项目永恒事实"留的位置——比如"这个项目用 pnpm 不是 npm"这种永远不会被压缩覆盖的硬规则。

最有意思的是 Episodic 这一层。下面这张是装上 1.4.0 一段时间之后，玄圃用 Haiku 真模型对当前 worktree 的近 307 个事件做的摘要：

![Episodic Memory — Claude Haiku 真摘要](./screenshots/1.4.0-episodic-haiku.png)

注意标签是 `claude-haiku`，不是 `rule-based`。在 RC 阶段我们曾经连续两天看见这里只是 `rule-based`——这就是后面会讲的"第一次重大翻车"。

### 2.3 跨设备现场（Session Hub M1）

VISION §3.3 原本把"现场跨设备流动"放在第三圈，预期是 2026 年 8-10 月才碰。但在 1.4.0 我们提前了——**因为发现移动端是最便宜的"现场可以脱离设备"演示场**。

桌面端开 Hub，手机扫一个二维码（这是 1.4.0 RC.9 才加的），就接管了刚才在跑的 Claude session。手机上不是另一个独立的 chat，**而是同一份现场的另一个视窗**。你在桌面发起的 prompt、agent 的流式回复、tool 卡片、approval、interrupt——手机上全都能看到、能介入。

这件事在产品形态上的意义比"多一个 mobile UI"重要得多：它**把"现场"和"设备"做了第一次解耦**。session 不再属于某台 mac，而是属于一个 worktree。

而 Session Checkpoint（Phase 24C）配合这一层，让现场连"会话生命周期"都能脱钩——你 abort 一个会话、关电脑，下次开机会看见：

![Session Checkpoint — abort 后续传的现场](./screenshots/1.4.0-checkpoint.png)

`age: 184m, source: abort, Worked on pre-release for 104m. 12 files edited, 75 commands run.` 加上 hot files 列表 + warning（"checkpoint 3h old / 8 commits landed since checkpoint"）。这不是日志，这是**给 agent 看的"我从哪里来"**。

---

## 3. 我们在 RC 阶段认错的几次

正向叙事讲完了，下面是不太好看的部分。如果你看 v1.4.0 的 commit 历史，从 rc.5 到 rc.13 一共 9 个候选版本，这 9 个 RC 全在追同一类问题——**"系统模块各自能跑通，但 wiring 在最后一公里掉链子"**。

具体来说：

- **PR #32 实现了一个完整的 Claude Haiku 压缩器**，单元测试全过、设计干净、错误处理周全。但 PR 合进来之后整整两天，**`compactor_id = 'claude-haiku'` 的行从来没在数据库里出现过**——因为 EpisodicMemoryUpdater 这个单例**从来没被实例化**：在 `src/main/index.ts` 里它只在 shutdown 时被 import，启动路径上完全没人 require 它。每次 app 启动后这个 updater 永远不会注册 event-bus 监听，永远不会触发压缩，永远只能 fallback 到 rule-based。我们花了两天才在日志里捕捉到 `getEpisodicMemoryUpdater is not defined` 这一行被 try/catch 吞掉的报错。**PR #34 修了。**

- **PR #34 修好了 wiring，但 Haiku 还是每次失败回退**。日志显示 `Claude Code process exited with code 1`。原因是：在 packaged macOS GUI app 里，子进程不继承用户 shell 的 PATH，所以 Claude Agent SDK 调用 `spawn('claude', ...)` 找不到 binary。我们的 `resolveClaudeBinaryPath()` 已经能拿到绝对路径，但**没把它传给 Haiku compactor**——它被构造时 `claudeBinaryPath` 默认是 null。**rc.11 修了。**

- **rc.10 修了 EPIPE 弹窗**——之前每次手机端断网或 cloudflared 重连，主进程就抛 `Error: write EPIPE` → Electron 默认弹"Uncaught Exception"对话框。原因是没全局兜底。

- **rc.12 修了 macOS "App 想访问其他 App 数据"反复弹**——我们用 `accessSync(~/Library/Safari/Bookmarks.plist)` 做 Full Disk Access 探测，macOS 14+ 每次都弹用户级提示。改成进程内缓存，granted 后永久 sticky。

- **1.4.0 发布后又发现 FieldContextDebug 看不到**——它被渲染了，但 SessionShell v2 的新布局里 ComposerBar 是 `absolute bottom-16 z-20`，把面板压在下面 + `overflow-hidden` 把溢出裁掉了。

- **同一天又发现 `registerFieldHandlers` 又一次"import 但没 call"**——和 PR #34 修的那个 bug **同款再来一次**，导致 panel 修好之后调 `field:getLastInjection` 报 `No handler registered`。

把这些放在一起看会发现一个共同的模式：**模块本身是对的，跨模块的"接线"在 GUI app 的特定路径上失败**。这种 bug 在传统 IDE 时代基本遇不到——传统 IDE 是单进程、单文件、单上下文；AI workbench 是**多 agent 子进程 × 多 worktree × 主/preload/renderer 三进程 × 沙盒环境 × event-bus 异步**的复合系统。

经验值：**任何"两个模块之间靠隐式约定连起来"的设计，在这种复合系统里都会成为 bug**。1.4.x 计划加一个 cold-start IPC 验证脚本，在 packaged 环境跑一遍每个 IPC handler，把这种 wiring 漏接交给 CI 拦截。

我们认这些错。1.4.0 不是一次完美交付，但它是一次**没有掩盖**的交付。

---

## 4. 下一步：1.4.x → 1.5 → 第二圈

1.4.0 装好之后下一个用户场景是这样的：你打开 Field Context Debug → Semantic Memory tab，会看见这个页面：

![Semantic Memory — 留给用户写](./screenshots/1.4.0-semantic-empty.png)

`Project Rules: .xuanpu/memory.md (file not found)`，`User Preferences: ~/.xuanpu/memory.md (file not found)`。**这一页空着不是 bug，是给你留的位置**——但目前用户得用文本编辑器手动建文件，体验很糙。

所以 1.4.x 路线图的核心是**让记忆变得可见可编辑**：

- **1.4.1 Pinned Facts**：用户能在 GUI 里直接钉住"这个项目用 pnpm"这种永久事实，不用碰命令行
- **1.4.2 Memory 面板**：让上面那 4 个 Debug tab 进化成一个完整的 Memory 面板，能看见 + 编辑 + 重置 + 重新生成
- **1.4.3 成本可见**：本月压缩消耗了多少 token / ¥X，明明白白告诉用户
- **1.4.4 跨 agent 注入质量验证**：当前的 Field Context prefix 是个 markdown 块，Claude 能识别。但 **Codex / OpenCode / Amp 收到这个 prefix 是真的会用，还是当用户消息复述出来**？这件事还没有被严格测过。

更远一点是 VISION §3.2 的第二圈：**XFP（Xuanpu Field Protocol）**——让任何 agent 厂商都能用同一套协议获取现场，把"在玄圃里 agent 比在自己原生环境里更强"做成一个标准。这条路如果能走通，玄圃就不再是另一个 IDE，而是 **agent 的现场提供者**。

完整路线图见 [docs/plans/2026-04-25-memory-product-direction.md](../plans/2026-04-25-memory-product-direction.md)。

---

## 5. 致谢与诚邀

1.4.0 是玄圃从早期 fork 产物彻底分化出来的转折点。一路上很多基础工程结构来自最初对 [Hive](https://github.com/slicenferqin/xuanpu) 的 fork——这份致谢应该保留。

但 1.4.0 同时也是一个开始。"为 Agent 提供现场"这件事，我们刚刚走通第一公里。如果你认同"输入框不是 AI 交互的终点"这个判断，玄圃需要你：

- **写代码** —— 1.4.x 路线图列了几个独立的 P0：Pinned Facts、Memory 面板、跨 agent 验证。任何一个都是 1-2 天的 PR
- **写 memory.md** —— 给你自己的项目写一份，把 agent 教会
- **报 bug** —— 上面那串 9 个 RC 还远没修完所有"wiring 漏接"
- **跟我们讨论 XFP** —— 第二圈这件事如果只有玄圃团队在推，永远走不通

仓库：<https://github.com/slicenferqin/xuanpu>
v1.4.0 下载：<https://github.com/slicenferqin/xuanpu/releases/tag/v1.4.0>

下一篇文章预定在 1.4.4 / XFP 草案出来时再写。在那之前，我们安静地把"让记忆可见、让 agent 真用"的这几件事做完。

——玄圃团队，于 1.4.0 发布日
