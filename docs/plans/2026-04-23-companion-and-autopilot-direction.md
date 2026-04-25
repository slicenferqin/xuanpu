# 玄圃演进方向：伴随式工作台 + 意图级托管

**日期**：2026-04-23
**性质**：未来方向探索，**非当前迭代任务**
**状态**：待时机成熟后再启动；当前 1.4.0 / Phase 21.5 / Phase 24c 优先

---

## 一、起点

来自一次开放式讨论。两个直觉同时浮现：

1. **伴随感** —— 受华为 HarmonyOS 6「小艺伴随式 AI」（2026-04 Pura X Max 首发）启发：工作台能否像「在场的同事」一样持续陪伴使用者，而不是被召唤的工具
2. **托管模式** —— Claude Code / Codex / OpenCode 频繁打断用户做小决策（continue?、A or B?）。能否由玄圃在 user 和 agent 之间插入一层「代理决策层」，把这些微观打断接走，仅在重大歧义时才停下

讨论结论：这两件事不是两个 feature，而是**同一个产品哲学的两面**——
- 伴随 = 空间维度（AI 在场，不需召唤）
- 托管 = 时间维度（AI 自主推进，不需逐步指挥）

合起来定义玄圃的下一个产品形态：**在场 + 自主**。

---

## 二、产业参照系（2026-04 同月爆发）

### 华为「小艺伴随式 AI」（消费级伴随）

四个机制可借鉴：
1. **侧边常驻**：始终在场，不占主界面
2. **三种伴随模式**：侧边常驻 / 展开 / 后台静默——不同的「在场密度」
3. **主动识别 + 时序整理**：订阅生活事件流（微信群、日历、机票），到点主动提醒
4. **Agentic 自演进**：快慢思考融合、记忆与自主学习

差别警示：华为做消费场景（事件语义标准化），玄圃做开发场景（事件语义远更复杂）。**借哲学，不抄形态。**

### Anthropic Claude Code Auto Mode（工具级守护）

- 基于 Sonnet 4.6 的 Classifier 对每个 tool call 做风险评估
- 安全操作自动批准，危险操作（rm 批量、数据外泄等）自动拦截
- 启用：`claude --enable-auto-mode`

**核心局限**：只判断「这一步安不安全」，不判断「这一步和用户最初意图一致不一致」。Auto Mode 一路绿灯放行 20 个 tool call，第 21 步发现整个方向就是错的——用户损失不是被删数据，是 30 分钟跑在错误的赛道。

### VS Code Autopilot Mode（2026-03）

四件事 GitHub 没说清：作用域边界、审计可追溯性、密钥处理、安全默认值。**玄圃做托管必须第一天堵住这四个坑。**

### Devin 团队实战教训

- 长任务必须拆成小的、隔离的 sub-task，跨独立 session 跑
- 成功与「范围具体程度」强相关；模糊范围自动偏航

---

## 三、产品定位（暂定）

> **「你的工作台在场，替你守着 AI 的方向」**

- "在场"对应伴随
- "守着方向"对应托管（**意图级**而非工具级）
- 不许诺情感联结（伙伴 → 守护者），只许诺一件可检验的事

---

## 四、三层架构

| 层 | 名称 | 职责 | 玄圃现状对应 |
|---|---|---|---|
| 1 | 感知层 | 收集 FieldEvent：worktree/file/terminal/git/agent message/focus | Phase 21 Field Event Stream（已做）+ Phase 21.5（agent tool events，进行中）|
| 2 | 决策层 | Guardian 替用户对 agent 的微观询问做代理决策 | **新做** |
| 3 | 透明层 | 决策日志 + 可回退性 + 历史正确率 | 增强 Phase 24c Checkpoint |

### 决策层的四个信号

Guardian 基于以下四个信号产出决策：
1. **任务原始意图**（用户最初需求文本，作为 hard anchor）
2. **当前进度轨迹**（已完成步骤 vs 原始意图的偏离度）
3. **用户历史偏好**（Phase 22 Memory 已在做）
4. **风险等级**（可逆性、是否触及禁区）

### 三种决策输出

- **自动继续**：决策显然 + 风险低 + 与意图一致
- **自动选择**：agent 给 A/B/C，Guardian 替选
- **升级到用户**：重大歧义 / 超出意图边界 / 不可逆操作

### 三档信任曲线（用户角度）

| 档 | 行为 | 用户授权 |
|---|---|---|
| Observe | Guardian 只显示「我会选 B，因为…」，**用户自己决定** | 无需授权 |
| Suggest | agent 暂停后倒计时 10s，用户不干预则按 Guardian 建议执行 | 单 session 授权 |
| Autopilot | 完全自主，仅重大歧义停下 | 全局授权 + 累计准确率达标 |

类比 L1-L5 辅助驾驶：**自动化的接受度不取决于能力，取决于信任**。

---

## 五、必须绕过的坑（讨论中识别）

### 坑 1：意图漂移（Intent Drift）

每一步对前一步都是合理延伸，累积起来已偏离原始意图（"做登录页面" → 改全局 CSS → 重构 token → 改 Button API）。

**单靠 LLM 语义距离评分不够**。必须叠加硬规则兜底：
- 文件/目录白名单（用户提需求时声明 scope）
- 漂移预算（累计改动文件数 / 行数超阈值强制升级）
- 每 K 步强制 checkpoint + 一句话摘要

### 坑 2：silent approval

托管下用户不在场，agent 写「我打算改 X」无人响应。Guardian 是唯一在场的人，必须靠硬规则兜底（白名单、预算、checkpoint），不能假设「用户没说话 = 同意」。

### 坑 3：可回退性极难兜底

Phase 24c Checkpoint 只覆盖 git/file 层。回退不了：
- `git push` 后的 remote
- 已调外部 API
- `rm` 已执行

**Guardian 默认作用域必须限定在「纯本地、未 push、未调外部 service」**。越界一律升级。

### 坑 4：Guardian 架构选择 —— 规则 vs LLM

- LLM Guardian：灵活但错误叠加（agent 漂 + Guardian 跟着漂）
- 规则 Guardian：可解释但覆盖窄
- **建议混合**：硬规则兜底 + LLM 仅做「这是不是真歧义」二分判断

### 坑 5：责任问题

Guardian 错了责任在谁？产品语言必须主动降温：
> **代理你做决策，不替你背责任**

边界语言越早立越好，避免用户把 Guardian 视为「伙伴 → 应担责」。

### 坑 6：并发跨 session 架构

玄圃实际并发活跃 session ≤ 5 个。架构选项：
- 每 session 独立 Guardian（隔离、简单，学不到跨 session 模式）
- 全局 Guardian（能识别冲突，但注意力分散）
- 折中：每 session 独立决策 + 全局协调层（仅管资源/冲突，不管内容）

第一天必须定。

### 坑 7：被 Anthropic / OpenAI 追上

Auto Mode 2.0 如果加上 intent-awareness，玄圃护城河剩什么？

判断：Anthropic 没有「用户在做什么」的全景信号源——它只有 Claude Code 单进程内事件。**玄圃真正的护城河不是 Guardian 算法，而是 FieldEvent 的覆盖广度 + 跨 agent (CC/Codex/OpenCode) 的横向视野**。

→ 这意味着 Phase 21.5（agent tool events）的战略重要性 > 现在的认知。

### 坑 8：信任校准（Trust Calibration）

学术结论（[Adaptive Trust Calibration](https://www.researchgate.net/publication/339424118)、[ECE 指标](https://www.emergentmind.com/topics/trust-calibration-in-ai)）：

- 透明度的目的不是「让用户看到」，是让「主观信任」和「客观可靠度」对齐
- 错位有两种：过度信任（错了不查）和过度怀疑（宁可自己点每一步）
- 光给日志不够，要给：**置信度 + 历史正确率 + 可撤销性**

---

## 六、推荐切入路径

**第一刀：只做 Observe 档**。

- 不要求用户授权托管
- 用户照常用 Claude Code / Codex
- 玄圃只在旁边显示「Guardian 会选 B，因为 X Y Z」
- 同时累计 Guardian 的**实际准确率**（用户最终选择 vs Guardian 建议的一致率）

价值：**0 责任承担 + 拿到 Guardian 真实正确率数据**。
- 数据 ≥ 85% 才开放 Suggest 档
- 数据 ≥ 95% 才开放 Autopilot 档

这条路径与 ECE 指标天然对齐——用真实数据校准用户信任，不靠营销语言。

---

## 七、待深入的开放问题

继续深挖前需要先回答：

1. **Guardian 规则 vs LLM 架构** —— 选错后面全返工
2. **Phase 21.5 之后 FieldEvent 还缺什么** —— Guardian 信号源的完备性
3. **Observe 档的 UI 位置** —— Session HQ 侧边栏 / Hub 手机推送 / Chat inline hint，三者优劣
4. **scope 声明的交互形态** —— 用户提需求时如何低摩擦地圈定文件/目录白名单
5. **决策日志的存储/渲染成本** —— 长期累积的工程约束（参考 Phase 24c 同类问题）
6. **Agent Inbox 三分类**（notify / question / approve，[LangChain 范式](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)）能否复用到 Hub M2

---

## 八、已知的产业参考链接

- [华为 Pura X Max 伴随式 AI（知乎专栏）](https://zhuanlan.zhihu.com/p/2030246751236571245)
- [小艺主动服务生态（品玩）](https://www.pingwest.com/a/310264)
- [Anthropic Claude Code Auto Mode 指南](https://smartscope.blog/en/generative-ai/claude/claude-code-auto-permission-guide/)
- [VS Code Autopilot Mode](https://leadai.dev/insider/vs-code-copilot-introduces-autopilot-mode-for-fully-autonomous-coding)
- [VS Code Autopilot 风险讨论（The Register）](https://www.theregister.com/2026/03/11/visual_studio_code_moves_to/)
- [Cognition 用 Devin 构建 Devin](https://cognition.ai/blog/how-cognition-uses-devin-to-build-devin)
- [Ambient Agents 综述（ZBrain）](https://zbrain.ai/ambient-agents/)
- [LangChain Human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)
- [Stanford Tech Review: Ambient Computing 2026](https://www.stanfordtechreview.com/articles/ambient-computing-and-ai-copilots-in-silicon-valley-2026)
- [Adaptive Trust Calibration](https://www.researchgate.net/publication/339424118)
- [Trust Calibration in AI（Emergent Mind）](https://www.emergentmind.com/topics/trust-calibration-in-ai)
- [SitePoint: Claude Code as Autonomous Agent 2026](https://www.sitepoint.com/claude-code-as-an-autonomous-agent-advanced-workflows-2026/)

---

## 九、与当前迭代的关系

**当前不动手**。1.4.0 优先：
- PR #28 / #29 / Phase 21.5 / Phase 24c 合并 → rc.5 验证 → 发版
- Hub M1 真机验证

本文档为**未来方向锚点**。等 1.4.0 稳定、Phase 21.5 数据流跑通后，重读本文档判断启动时机。

启动信号（满足任一）：
- Phase 21 + 21.5 + 22 + 24c 全部 stable，FieldEvent 信号源完备
- 用户开始反馈「频繁打断 agent 决策」是主要痛点
- 业界出现 intent-aware Auto Mode 竞品，需要正面应对

---

## 十、IM 落地形态（2026-04-23 补充）

原文档把伴随 / 托管定位在「用户 ↔ 玄圃」的一对一关系上。实际产品推演后发现，**IM 群聊是托管模式最自然的生产入口**，因为它天然解决了三件事：触发源（他人发起）、身份（群成员 identity）、通知通道（IM 原生推送）。

但也因此，IM 形态把托管的复杂度**放大了一个量级**——不再是"我的玄圃替我做决策"，而是"别人通过 IM 让我的玄圃替我做事"，多了权限、归属、责任三条新线。

### 目标场景

PM / 测试在群里发现问题 → @玄圃 → 玄圃自动：
1. **Intake**：理解自然语言问题描述（"下单页面挂了"）
2. **Routing**：推断涉及哪个 project / worktree（业务语义 → 代码位置）
3. **Triage**：开调研 session，agent 读 log、grep、复现、定位嫌疑
4. **Fix**：agent 自主修，中间遇到歧义自己判断继续 / 问人
5. **Build & Release**：rc 打包、验证、发布

### 被低估的五个复杂度

#### 1. Project 归属推断（路由层）

业务描述（"下单页面加载慢"）≠ 代码描述（"frontend repo src/pages/checkout/"）。

玄圃现有 project / worktree 模型**没有业务语义标签**。新增字段：
- `project.business_tags`：人配的业务标签（["订单", "下单", "checkout"]）
- `project.ownership_desc`：一段自然语言描述 project 的责任边界

Router 策略推荐**规则 + LLM 混合**：
- 关键词硬命中优先（快、可预测）
- 低置信度时回退 LLM（读 README + recent commits + tags 推断）
- 命中 0 个 → 回 IM 问"你说的是哪个 project？"
- 命中 ≥ 2 个 → 回 IM 给选项按钮

#### 2. agent 自主推进中的歧义 = Guardian 必需

agent 跑到一半问"改 A 方案还是 B 方案"——**谁回答？**
- 回给 PM：PM 不懂代码
- 回给本人：人肉 Director，自动就破产
- **Guardian 自动判断** = 本文档第四、五章的核心命题

**没有 Guardian，IM 托管场景在第一个歧义点就破产。** → Phase C 强依赖。

#### 3. 权限分层（目前玄圃完全没有）

IM 身份 → 玄圃行动能力的映射，至少三档：

| 角色 | 能 @ 请求 | 不能做 |
|---|---|---|
| 群里任何人 | triage（诊断报告，不动代码） | 动代码、合 PR |
| 白名单成员 | 创建 fix branch + PR | 合 main、发布 |
| 只有本人 | 授权 build & release | — |

没有这层，群里任何人 @玄圃 就能触发自动发布 = 勒索攻击入口。

#### 4. Build & Release 硬边界

**产品第一天就必须立的承诺**：
- ✅ 自动打 rc 包（可恢复）
- ❌ 自动 release / tag main / 部署 prod（不可恢复）

不管 Guardian 多自信，不可逆动作**一律升级人**。一次误发 = 信任清零。

#### 5. 责任问题

自动合 PR → 生产事故 → 责任归谁？
- 产品语言必须降温：**"玄圃协助你推进，不替你背责"**
- 每步留**决策日志 + 可回滚标记**（Phase 24c Checkpoint 是基础）
- 群聊自动消息要显式带回滚提示（"已提交 PR #N，如需撤回点此"）

### 能力表 vs 现状

| 愿景要素 | 前置能力 | 1.4.0 状态 |
|---|---|---|
| Intake（NL 问题理解） | LLM | ✅ 能力已在 |
| Routing（业务→代码） | project 业务标签 + LLM 推断 | ❌ 没做 |
| Triage（调研 session） | Phase 21.5 agent tool events | ✅ 1.4.0 有 |
| Fix 自主续跑 | **Guardian 决策层** | ❌ 没做（本文档第四章，1.6.0+） |
| 漂移 / scope 兜底 | Scope 声明 + 白名单 + 漂移预算 | ❌ 没做 |
| 权限分层 | 用户角色模型 + IM identity 绑定 | ❌ 没做 |
| 回滚 / 决策日志 | Phase 24c Checkpoint | ✅ 1.4.0 有 |
| 信任校准数据 | Observe 档跑真实数据 | ❌ 没跑 |

**缺 5/8**，且缺的都是硬依赖。→ 不能一把梭。

### 分层实现路径

#### Phase A（1.4.1 / 1.4.x 补丁）：**IM 通知 + 手动入口**

**目标**：把 Hub M1 的入口从 PWA 扩展到 IM，**不做 agent 编排**。

- 玄圃桌面端 → IM 平台推事件：agent 完成、需要审批、PR 创建、构建失败
- IM 里 @玄圃 → 回复**操作菜单**（列出你的 project，每个带交互按钮）
- 点"打开 session" → 跳转 PWA / 桌面端（复用 Hub M1 通道）
- **PM / 测试在这个阶段只能看状态，不能派活**

**平台优先级**：
- **飞书应用机器人**（首选）：API 最完整、交互卡片最成熟、个人开发者审核快
- **企业微信智能机器人**（随后）：团队场景覆盖
- **微信 ClawBot (iLink)**：观望半年再入场，生态还太早期

**工作量**：2-3 天做完飞书，7 天做完全套飞书+企微。

#### Phase B（1.5.0）：**Triage-Only（只诊断不修复）**

**目标**：@玄圃 + 问题描述 → 诊断报告发回 IM。**不改任何代码。**

- Router（规则 + LLM 混合）推断 project
- 开**调研 session**：agent 自动读 log、grep 代码、跑测试复现
- 产出**诊断报告卡片**推回 IM：嫌疑文件、相关 commit、建议方案
- 群里 PM 的价值已经很高：少等半小时让人看
- 玄圃自己的价值：**积累"问题类型 → 诊断准确率"数据**，为 Phase C 的 Guardian 做训练 / 校准

**新依赖**：
- project.business_tags 配置 UI
- Router 模块（规则引擎 + LLM 兜底）
- 诊断报告模板 + IM 交互卡片

**估时**：4-6 周。

#### Phase C（1.6.0+）：**真正的托管修复**

基于 Phase B 积累的数据，引入完整 Guardian 体系：

- **Guardian 决策层**（本文档第四章）：规则 + LLM 混合
- **Observe / Suggest / Autopilot 三档信任曲线**（第四章）
- **scope 声明**：@玄圃时带 `@xuanpu fix [scope:src/pages/checkout] ...`
- **权限分层**：群成员 / 白名单 / 本人
- **Build & Release**：
  - 自动打 rc 包
  - 发 release / tag main → **永远手动授权**
  - prod 部署 → **永远手动**

**估时**：12 周+，且不追求完备覆盖，只做 Phase B 数据证明"该类型问题 ≥ 95% 成功率"的那些子域。

### 为什么必须分层（反面）

一把梭（直接做 Phase C）的风险：
1. **Guardian 判断基线 = 拍脑袋**。Phase B 不做，Guardian 的"置信度"没数据来源
2. **用户信任来不及建立**。PM 要先看到 3 次准确诊断，才会信"它能诊断"；才会信"它能修"；才会信"它能发"。跳步 = 第一次出事全盘归零
3. **玄圃产品心智不能一步到位成"无人驾驶开发"**。市场 / 法务 / 心理都没准备好

### 与 Hub M1 的关系

Hub M1（手机 PWA 远控）= **个人多设备场景**。
IM 落地 = **多人协作场景**。

两者是正交的，都值得做。但：
- Hub M1 已经上线（1.4.0），先让它撑一段时间
- IM 形态从 Phase A 开始，作为 Hub M1 的**扩展入口**，不替代

### 开放问题

1. **1.4.0 是否顺带做 Phase A？**
   - Pro：IM 入口起步、手机 PWA + IM 构成完整远控矩阵
   - Con：1.4.0 功能已密集，延期 1-2 周
   - **倾向：1.4.0 先发，Phase A 作为 1.4.1 补丁**
2. **飞书 or 企微先做？**取决于目标用户日常用哪个
3. **Router 规则 vs LLM 权重**：Phase B 初版建议 **70% 规则 + 30% LLM**，数据多了再调
4. **群聊权限如何绑定玄圃用户**：IM open_id / union_id ↔ 玄圃本地身份映射，新增配置层

### 启动信号（本章补充）

- Phase A：1.4.0 发版后，若真实场景出现"想把玄圃拉进群"的冲动 → 立刻做
- Phase B：Phase A 跑 1 个月，通知量数据稳定 → 有信号源才做 Router
- Phase C：Phase B 产生的诊断报告准确率 ≥ 85% → 才开放"修复"能力

