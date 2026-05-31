# xuanpu-agent 独立配置文件方案

日期：2026-05-31
分支：`feat/xuanpu-agent-oh-my-pi`

## 结论

xuanpu-agent 必须有自己的配置文件，不应该在运行时依赖 Codex、Claude Code、OpenCode
等其他 agent 的配置文件。

Codex 配置只允许用于一次性 bootstrap：

- 读取 `~/.codex/config.toml` 和 `~/.codex/auth.json`
- 生成 xuanpu-agent 自己的配置文件
- 之后 xuanpu-agent 只读取 `~/.xuanpu/xuanpu-agent.json`

## 配置格式选择

选择 JSON。

理由：

- 当前项目没有 TOML runtime parser 依赖，JSON 可用 Node 标准库直接解析。
- 玄圃 settings 目前已经以 JSON 存储，字段形态一致。
- 避免为实验 runtime 引入新依赖和打包风险。
- secret 可以拆到独立 auth 文件，主配置文件保持可读、可审计。

## 文件位置

正式配置：

```text
~/.xuanpu/xuanpu-agent.json
```

可选 secret 文件：

```text
~/.xuanpu/xuanpu-agent.auth.json
```

两个文件都应为用户本机文件，不进 repo。

## 文件模板

```json
{
  "enabled": true,
  "mainModel": {
    "providerID": "openai",
    "modelID": "gpt-5.5",
    "variant": "xhigh"
  },
  "compactionModel": {
    "providerID": "openai",
    "modelID": "gpt-5.4-mini"
  },
  "providers": {
    "openai": {
      "baseUrl": "https://api.asxs.top/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "authFile": "~/.xuanpu/xuanpu-agent.auth.json",
      "authKey": "OPENAI_API_KEY"
    },
    "anthropic": {
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "authFile": "~/.xuanpu/xuanpu-agent.auth.json",
      "authKey": "ANTHROPIC_API_KEY"
    },
    "google": {
      "apiKeyEnv": "GEMINI_API_KEY",
      "authFile": "~/.xuanpu/xuanpu-agent.auth.json",
      "authKey": "GEMINI_API_KEY"
    }
  },
  "context": {
    "contextWindow": 500000,
    "autoCompactTokenLimit": 450000
  }
}
```

Secret 文件模板：

```json
{
  "OPENAI_API_KEY": "sk-...",
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "GEMINI_API_KEY": "..."
}
```

`providers` 必须设计成多 provider map，不要只写死 `openai?: ...`。当前实际需要是
OpenAI-compatible GPT，但 `model-config.ts` 已经支持 `anthropic`、`openai`、`google`，配置格式
应一次性容纳这三类 provider，避免后续破坏性迁移。

## Bootstrap 规则

可以提供一个一次性导入命令或函数：

```text
Import Codex config -> write ~/.xuanpu/xuanpu-agent.json -> write ~/.xuanpu/xuanpu-agent.auth.json
```

导入后不再读取 Codex 配置。

本机这次的 bootstrap 映射为：

```json
{
  "codexModelProvider": "weiyi",
  "codexModel": "gpt-5.5",
  "codexBaseUrl": "https://api.asxs.top/v1",
  "xuanpuAgentProviderID": "openai",
  "xuanpuAgentMainModel": "gpt-5.5",
  "xuanpuAgentCompactionModel": "gpt-5.4-mini"
}
```

说明：`weiyi` 是 Codex 配置里的 provider 名，不应该传给 xuanpu-agent runtime。
xuanpu-agent 应使用 `providerID = "openai"`，再通过 `baseUrl` 指向兼容网关。

## 代码改造范围

### 1. 新增 config loader

新增：

```text
src/main/services/xuanpu-agent/config-loader.ts
```

职责：

- 读取 `~/.xuanpu/xuanpu-agent.json`
- 展开 `~`
- 校验字段
- 返回标准化 `XuanpuAgentConfig` 对象
- 不负责判断某个 provider 的 credential 是否 present
- 不读取 `~/.codex/*`
- 不在日志、IPC、timeline、context package 里输出明文 key

建议类型：

```ts
export interface XuanpuAgentConfig {
  enabled: boolean
  mainModel: {
    providerID: string
    modelID: string
    variant?: string
  }
  compactionModel?: {
    providerID: string
    modelID: string
    variant?: string
  } | null
  providers?: Record<string, XuanpuAgentProviderConfig>
  context?: {
    contextWindow?: number
    autoCompactTokenLimit?: number
  }
}

export interface XuanpuAgentProviderConfig {
  baseUrl?: string
  apiKeyEnv?: string
  authFile?: string
  authKey?: string
}
```

配置加载失败策略：

```text
~/.xuanpu/xuanpu-agent.json 不存在
  -> 返回 env-only/default config，不报错。

~/.xuanpu/xuanpu-agent.json 存在但 JSON 解析失败
  -> 抛出配置错误，runtime status 显示 config-error，不 fallback。

~/.xuanpu/xuanpu-agent.json 存在但字段缺失
  -> 缺失字段使用默认值；非法字段值抛出配置错误。

默认 mainModel
  -> providerID=anthropic, modelID=claude-haiku-4-5，保持现有兼容。

默认 providers.<provider>.apiKeyEnv
  -> openai: OPENAI_API_KEY
  -> anthropic: ANTHROPIC_API_KEY
  -> google: GEMINI_API_KEY

默认 authKey
  -> 与 apiKeyEnv 相同。
```

注意：不存在配置文件时仍允许 `XUANPU_AGENT_RUNTIME=1` + env var 的旧模式继续工作。

Credential 决策链必须明确：

```text
1. canonicalize providerID
   claude-code -> anthropic
   codex -> openai
   gemini -> google

2. 找 provider config
   config.providers[canonicalProviderID]，没有则使用 provider 默认 env key。

3. 读取 env
   如果 provider config 指定 apiKeyEnv，用该 env key。
   如果未指定，使用 provider 默认 env key。
   env 有非空值 -> credential present，source=env。

4. 读取 auth file
   如果 env 没有值，并且 provider config 指定 authFile：
     展开 ~
     读取 JSON
     使用 authKey；authKey 未指定则等于 apiKeyEnv 或 provider 默认 env key
     有非空值 -> credential present，source=auth-file。

5. 都没有
   -> credential missing，source=missing。
```

模块职责边界：

```text
config-loader.ts
  - 文件读取
  - ~ 展开
  - JSON parse
  - 字段标准化
  - 基础 schema 校验
  - 返回 config 对象和 config load status
  - 不直接做 provider credential present 判定

model-config.ts
  - 接收 config 对象
  - provider canonicalize
  - credential 决策链
  - baseUrl 决策链
  - resolveXuanpuAgentModelRef
  - resolvePiModel
  - assertXuanpuAgentProviderCredential
```

这样能保留现有 `model-config.ts` 的领域职责，同时把文件 IO 控制在一个模块。
  }
}
```

### 2. 修改 runtime gate

文件：

```text
src/main/index.ts
```

当前只认：

```ts
process.env.XUANPU_AGENT_RUNTIME === '1'
```

改为：

```ts
const xuanpuAgentConfig = loadXuanpuAgentConfig()
if (process.env.XUANPU_AGENT_RUNTIME === '1' || xuanpuAgentConfig.enabled) {
  // register xuanpu-agent
}
```

环境变量保留为强制开启方式；配置文件成为正常开启方式。

### 3. 修改 model-config.ts

文件：

```text
src/main/services/xuanpu-agent/model-config.ts
```

改造点：

- 默认主模型来自 `config.mainModel`
- provider credential 检查支持：
  - `process.env[apiKeyEnv]`
  - `authFile[authKey]`
- OpenAI base URL 优先级：
  1. `XUANPU_AGENT_OPENAI_BASE_URL`
  2. `OPENAI_BASE_URL`
  3. `config.providers.openai.baseUrl`
- `resolvePiModel()` 对 `openai` model 应用 baseUrl override
- `providerID = weiyi` 不属于 xuanpu-agent provider id；一次性导入时应转换成
  `providerID = openai` + `providers.openai.baseUrl`。

### 4. 修改 compaction model 读取

文件：

```text
src/main/services/xuanpu-agent/field/ide-field-provider.ts
```

摘要模型优先级：

1. DB settings 里的 `xuanpuAgentCompactionModel`
2. `~/.xuanpu/xuanpu-agent.json.compactionModel`
3. 从主模型 provider 自动推导
4. rule-based fallback

### 5. 修改 runtime status

文件：

```text
src/main/services/system-info.ts
```

返回状态增加：

- `configPath`
- `configLoaded`
- `configSource: "xuanpu-agent-json" | "env-only" | "missing"`
- `baseUrl`
- `baseUrlSource`
- `credential.source: "env" | "auth-file" | "missing"`
- masked key，仅用于调试显示，不返回明文

### 6. 一次性 bootstrap 脚本

可选新增，优先级低于 runtime config loader：

```text
scripts/bootstrap-xuanpu-agent-from-codex.mjs
```

职责只限一次性生成文件：

- 输入：`~/.codex/config.toml`、`~/.codex/auth.json`
- 输出：`~/.xuanpu/xuanpu-agent.json`、`~/.xuanpu/xuanpu-agent.auth.json`
- 不参与运行时加载
- 这是迁移/初始化工具，不是 xuanpu-agent 的配置源

当前代码确实完全不读 `~/.codex/*`；本机这次只是为了避免手动重复配置，已经手动生成了：

```text
~/.xuanpu/xuanpu-agent.json
~/.xuanpu/xuanpu-agent.auth.json
```

因此 bootstrap 脚本可以后置，不阻塞核心配置加载实现。

## 测试

新增：

```text
test/phase-24/xuanpu-agent-config-loader.test.ts
```

覆盖：

- 读取 `~/.xuanpu/xuanpu-agent.json`
- `~` 路径展开
- env key 优先于 auth file
- auth file key 可用
- missing key 返回 missing-credentials
- baseUrl 从配置注入
- 不读取 Codex 配置

扩展：

```text
test/phase-24/xuanpu-agent-model-config.test.ts
test/phase-24/xuanpu-agent-runtime-status.test.ts
test/phase-24/xuanpu-agent-compaction-model.test.ts
```

这里的“扩展”指在现有 `test/phase-24/` 同名文件里追加 case，不要创建新的 phase 目录，也不要复制同名文件。

## 验证命令

```bash
pnpm vitest run test/phase-24/xuanpu-agent-config-loader.test.ts \
  test/phase-24/xuanpu-agent-model-config.test.ts \
  test/phase-24/xuanpu-agent-runtime-status.test.ts \
  test/phase-24/xuanpu-agent-compaction-model.test.ts

pnpm exec tsc --noEmit --pretty false
pnpm lint
XUANPU_AGENT_RUNTIME=1 pnpm build
```

## 禁止事项

- 禁止 xuanpu-agent runtime 自动读取 `~/.codex/config.toml`
- 禁止把 Codex provider id 当成 xuanpu-agent provider id
- 禁止把真实 key 写进 repo
- 禁止在日志、IPC、timeline、context package 中输出明文 key
- 禁止让 `~/.xuanpu/xuanpu-agent.config.template.json` 成为真实配置来源
