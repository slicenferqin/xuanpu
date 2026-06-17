# xuanpu-agent 包发布边界

日期：2026-06-17

关联文档：

- `docs/plans/2026-06-16-xuanpu-agent-implementation-task-list.zh-CN.md`
- `docs/plans/2026-06-17-oh-my-pi-v16-upgrade-spike.zh-CN.md`

## 结论

`@xuanpu/agent-cli` 不能单独发布。它的真实运行时依赖是
`@xuanpu/oh-my-pi-runtime`，所以发布链路必须按 runtime -> compat alias -> CLI 的顺序验证。

本轮确定的包边界：

| 包                         | 是否可发布 | 入口                            | 说明                                                                                       |
| -------------------------- | ---------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `@xuanpu/oh-my-pi-runtime` | 是         | `dist/index.js`                 | 受控 oh-my-pi-derived runtime，包含 `runTurn()` contract、`upstream.json` 和 patch queue。 |
| `@xuanpu/pi-agent-core`    | 是         | `dist/index.js`                 | 兼容 alias，保留旧导入路径，依赖 `@xuanpu/oh-my-pi-runtime`。                              |
| `@xuanpu/agent-cli`        | 是         | `dist/index.js` / `dist/cli.js` | CLI、JSON-RPC/ACP bridge、project-local field context 和 coding tools。                    |

实际 npm publish 仍不在本轮执行范围内；需要确认 npm org 权限、版本策略和 release automation 后再发布。

## 包顺序

发布或本地 pack 前按这个顺序构建：

```bash
pnpm --filter @xuanpu/oh-my-pi-runtime build
pnpm --filter @xuanpu/pi-agent-core build
pnpm --filter @xuanpu/agent-cli build
```

原因：

1. `@xuanpu/oh-my-pi-runtime` 是真实 runtime，必须先产出 `dist/*.js` 和 `dist/*.d.ts`。
2. `@xuanpu/pi-agent-core` 是 alias 包，类型解析依赖 runtime 的 package exports。
3. `@xuanpu/agent-cli` 运行时 dynamic import `@xuanpu/oh-my-pi-runtime`，发布包必须能从 npm 解析到 runtime。

## 本地 pack 验证

建议在 `/tmp` 之类的临时目录产物中验证：

```bash
rm -rf /tmp/xuanpu-agent-package-pack
mkdir -p /tmp/xuanpu-agent-package-pack

pnpm --filter @xuanpu/oh-my-pi-runtime pack --pack-destination /tmp/xuanpu-agent-package-pack
pnpm --filter @xuanpu/pi-agent-core pack --pack-destination /tmp/xuanpu-agent-package-pack
pnpm --filter @xuanpu/agent-cli pack --pack-destination /tmp/xuanpu-agent-package-pack
```

验收点：

- runtime tarball 包含 `dist/`、`upstream.json`、`patches/` 和 `package.json`。
- alias tarball 包含 `dist/` 和 `package.json`。
- CLI tarball 包含 `dist/`、`bin.xuanpu-agent` 指向 `dist/cli.js`。
- tarball 内不包含 workspace-only source dependency。

## 发布策略

版本策略：

- `@xuanpu/oh-my-pi-runtime` 当前版本跟随上游基线：`15.2.4`。
- `@xuanpu/pi-agent-core` 当前版本跟随 runtime：`15.2.4`。
- `@xuanpu/agent-cli` 使用独立产品版本：当前 `0.1.0`。
- 当 runtime 回收 v16 patch 但不整体升级上游时，应先决定是使用 `15.2.4-xuanpu.N` 还是提升到 Xuanpu 自有 semver。当前不在本轮决定。

发布顺序：

```bash
pnpm --filter @xuanpu/oh-my-pi-runtime publish --access public
pnpm --filter @xuanpu/pi-agent-core publish --access public
pnpm --filter @xuanpu/agent-cli publish --access public
```

不应直接执行 `pnpm -r publish`，除非 release automation 已经能保证包顺序、dry-run、tag、changelog 和 npm 权限检查。

## 仍需外部确认

- npm scope `@xuanpu` 的 owner / automation token。
- 是否真的需要发布 compat alias `@xuanpu/pi-agent-core`，还是只作为 workspace 内兼容包保留。
- runtime 版本是否继续跟随上游 `15.2.4`，或改为 Xuanpu 自有版本线。
- 是否把 `@oh-my-pi/pi-agent-core` 和 `@oh-my-pi/pi-ai` 固定为 exact version，当前保持 exact `15.2.4`。
