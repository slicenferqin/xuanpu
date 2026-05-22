# XFP Smoke Checklist

Date: 2026-05-22
Scope: Claude Code and Codex field-delivery validation after XFP migration.

## Goal

Verify that Xuanpu no longer pollutes routine Claude Code / Codex turns with
dynamic Field Context, while still making local field state available through
XFP MCP or bounded fallback when the user asks field-sensitive questions.

OpenCode is intentionally out of scope for this checklist. It keeps the legacy
push-based behavior until there is a concrete OpenCode need.

## Inspector Signals

Open the right sidebar and select **Diagnostics**.

Expected XFP Inspector entries:

- `prompt` / `field_delivery`: one per observed agent turn.
- `tool`: Claude Code XFP MCP tool calls, such as `xfp_get_current_focus`.
- `fallback`: bounded fallback prefixes used when the runtime cannot call XFP
  tools.

For cache-friendliness, routine Claude Code / Codex prompts should show:

```text
mode: none or xfp-mcp
hasFieldContextEnvelope: false
hasXfpFallbackPrefix: false
```

For high-confidence field-sensitive prompts, bounded fallback may show:

```text
mode: xfp-fallback
hasFieldContextEnvelope: false
hasXfpFallbackPrefix: true
```

## Test Matrix

### 1. Routine Claude Code Prompt

Prompt:

```text
解释一下 fast-forward merge 和 rebase 的本质区别
```

Expected:

- UI user bubble contains only the user text.
- XFP Inspector shows `field_delivery` with `mode: xfp-mcp`.
- `hasFieldContextEnvelope` is `false`.
- No `[Field Context]` appears in title, user bubble, or persisted timeline.

### 2. Claude Code Field-Sensitive Prompt

Prompt:

```text
这里为什么挂？
```

Expected:

- Claude Code can call `mcp__xuanpu-field__xfp_get_current_focus` and/or
  `mcp__xuanpu-field__xfp_get_last_terminal_activity`.
- XFP Inspector shows the tool call summary and output size.
- If MCP attach failed, XFP Inspector shows `mode: xfp-fallback` and a
  `fallback` audit event.
- UI user bubble still contains only `这里为什么挂？`.

### 3. Routine Codex Prompt

Prompt:

```text
写一个三点的代码评审清单
```

Expected:

- XFP Inspector shows `field_delivery` with `mode: none`.
- `hasFieldContextEnvelope` is `false`.
- `hasXfpFallbackPrefix` is `false`.
- Codex sendTurn text does not include `[Field Context]`.

### 4. Codex Field-Sensitive Prompt

Prompt:

```text
继续
```

Expected:

- XFP Inspector may show `mode: xfp-fallback`.
- Fallback includes only bounded focus / terminal / resume summary data.
- UI user bubble and persisted user message remain `继续`.
- No full Recent Activity dump is included.

### 5. Attachment Prompt

Prompt:

```text
看下这张图的问题
```

Attach an image or file.

Expected:

- User bubble preserves the attachment.
- Runtime prompt observation has `hasFileAttachments: true`.
- The text part does not contain `[Field Context]` or `[Xuanpu Field Fallback]`
  unless the prompt is field-sensitive and the runtime needs bounded fallback.

### 6. Legacy OpenCode Baseline

Prompt:

```text
这里为什么挂？
```

Expected:

- OpenCode may still show `mode: legacy-injection`.
- This is expected for the current infra cycle.
- Do not treat OpenCode legacy injection as a blocker for this PR.

## Pass Criteria

- Claude Code and Codex routine prompts do not receive full Field Context.
- Field-sensitive prompts still have a path to current workbench state.
- XFP Inspector can explain which path was used for each turn.
- User-authored messages, titles, and timeline readback remain clean.
- Attachments survive prompt start and agent runtime transitions.
