# Chinese Agent Fork Roadmap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the current localized Hive fork into a self-use-first, team-ready Chinese-native agent desktop tool that can be installed and recommended internally.

**Architecture:** Keep the proven local-first Electron/React worktree + session architecture intact, and build a forked product layer on top of it in phases. Do not rewrite the core shell. First make it a stable internal distribution, then add Chinese-developer-specific workflow advantages, then gradually decouple from upstream product assumptions.

**Tech Stack:** Electron 33, React 19, TypeScript 5.7, Zustand, SQLite, electron-builder, pnpm, native Ghostty addon, GitHub fork workflow.

---

## Phase Goals

### Phase 1: Daily Driver

**Goal:** Make the fork feel better than upstream for personal daily use.

**Success criteria:**
- Chinese UI is effectively complete for high-frequency flows.
- IME / input / shortcuts / proxy / model defaults feel sane.
- Local unsigned build can be produced and installed reliably.

### Phase 2: Team-Ready Internal Tool

**Goal:** Make the fork stable enough to hand to 3-10 colleagues without hand-holding every install.

**Success criteria:**
- One-command internal build flow exists.
- Internal install guide exists.
- Product identity is no longer ambiguous with upstream.
- Common failure cases have readable Chinese guidance.

### Phase 3: Product Divergence

**Goal:** Build a Chinese-developer-native agent workspace rather than a translated clone.

**Success criteria:**
- Chinese collaboration / review / prompt workflows are opinionated.
- Domestic provider / network support is better than upstream.
- Release cadence and roadmap are owned locally.

---

### Task 1: Fork Product Baseline

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `package.json`
- Modify: `electron-builder.yml`
- Modify: `resources/*` (icons / branding assets when ready)
- Create: `docs/plans/2026-03-26-chinese-agent-fork-roadmap.md`

**Objective:** Stop treating this branch as an upstream contribution and define it as an internal product fork.

**Steps:**
1. Add a short fork positioning note to the docs.
   - Clarify: this fork optimizes for Chinese developers and internal productivity, not upstream parity.
2. Define branch policy.
   - `upstream/main` is now an input source, not the primary destination.
   - `origin/codex/i18n-foundation` is the working product branch until a dedicated product branch is introduced.
3. Freeze product assumptions in writing.
   - Non-goals for now: cloud sync, plugin marketplace, team SaaS, rewriting the session core.
4. Prepare branding migration.
   - Keep code functional first.
   - Rebrand package / app metadata before wider internal rollout to avoid confusion with official Hive.

**Verification:**
- Review `README.zh-CN.md` and `README.md` for a clear fork statement.
- Confirm `package.json` and `electron-builder.yml` are the only sources of app/package identity before rename work starts.

**Commit suggestion:**
```bash
git add README.md README.zh-CN.md package.json electron-builder.yml docs/plans/2026-03-26-chinese-agent-fork-roadmap.md
git commit -m "docs: define chinese fork roadmap"
```

---

### Task 2: Internal Build and Install Pipeline

**Files:**
- Modify: `package.json`
- Modify: `electron-builder.yml`
- Modify: `scripts/install.sh` (if retained)
- Create: `scripts/build-local-cn.sh`
- Create: `docs/internal-install.md`
- Check: `src/native/build/Release/ghostty.node`

**Objective:** Make local installable builds reproducible for personal use and internal sharing.

**Steps:**
1. Standardize the local build path.
   - Required commands today:
   ```bash
   pnpm install
   pnpm build:native
   pnpm build:mac:unsigned
   ```
2. Add a wrapper script so nobody has to remember the exact order.
   - `scripts/build-local-cn.sh` should:
     - verify dependencies
     - build native addon
     - run unsigned mac build
     - print output artifact paths
3. Document artifact expectations.
   - Output directory: `dist/`
   - Expected artifacts: `.dmg`, `.zip`, or unpacked `.app`
4. Add internal install notes.
   - unsigned build behavior
   - Gatekeeper / right-click open
   - quarantine clearing if needed

**Verification:**
- Run:
```bash
pnpm install
pnpm build:native
pnpm build:mac:unsigned
```
- Confirm `dist/` contains installable macOS artifacts.
- Smoke-test launching the built app.

**Commit suggestion:**
```bash
git add package.json electron-builder.yml scripts/build-local-cn.sh docs/internal-install.md
git commit -m "build: add internal mac build workflow"
```

---

### Task 3: Personal Daily-Driver UX

**Files:**
- Modify: `src/renderer/src/i18n/messages.ts`
- Modify: `src/renderer/src/stores/useSettingsStore.ts`
- Modify: `src/renderer/src/components/settings/SettingsGeneral.tsx`
- Modify: `src/renderer/src/components/settings/SettingsShortcuts.tsx`
- Modify: `src/renderer/src/components/settings/SettingsModels.tsx`
- Modify: `src/renderer/src/components/sessions/SessionView.tsx`
- Modify: `src/renderer/src/components/layout/QuickActions.tsx`
- Modify: `src/renderer/src/components/file-viewer/FileViewer.tsx`
- Test: `test/settings-i18n.test.tsx`

**Objective:** Optimize the app for your actual day-to-day use, not generic completeness.

**Workstreams:**

**A. Chinese-first UX**
- Finish remaining high-frequency Chinese UI gaps.
- Reduce mixed English/Chinese terminology.
- Keep proper nouns and technical model names in English where appropriate.

**B. Input ergonomics**
- Ensure Chinese IME behavior is correct.
- Revisit message-send ergonomics only after IME stability is locked.
- Keep shortcuts discoverable in Chinese.

**C. Default settings**
- Set sane defaults for:
  - locale
  - model/provider presets
  - update behavior
  - shortcut behavior
  - terminal/editor defaults if needed

**Verification:**
- Run:
```bash
pnpm exec tsc --noEmit --pretty false
pnpm exec eslint src/renderer/src/components src/renderer/src/stores src/renderer/src/i18n/messages.ts
pnpm exec vitest run test/settings-i18n.test.tsx
```
- Manual smoke checks:
  - add project
  - open worktree
  - start session
  - send Chinese message with IME
  - open diff
  - save file

**Commit cadence:**
- Commit every 1-3 related surfaces, not one giant i18n diff.

---

### Task 4: China-Ready Provider and Network Layer

**Files:**
- Modify: `src/renderer/src/stores/useSettingsStore.ts`
- Modify: `src/renderer/src/components/settings/SettingsModels.tsx`
- Modify: `src/renderer/src/components/settings/SettingsGeneral.tsx`
- Modify: `src/renderer/src/components/settings/SettingsSecurity.tsx`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/main/ipc/settings-handlers.ts`
- Modify: `src/main/services/agent-sdk-manager.ts`
- Modify: `src/main/services/opencode-service.ts`
- Modify: `src/main/services/codex-models.ts`
- Modify: `src/main/services/settings-detection.ts`

**Objective:** Make the fork meaningfully better for Chinese developers under real network and provider constraints.

**Priority order:**
1. Proxy UX
   - make HTTP/SOCKS proxy behavior visible and configurable
   - reduce manual env friction
2. Provider presets
   - expose better presets for models actually used in China
3. Error clarity
   - turn provider/network failures into readable Chinese guidance
4. Future provider abstraction
   - leave room for domestic provider integrations without rewriting the UI again

**Verification:**
- Manual test matrix:
  - no proxy
  - HTTP proxy
  - unavailable provider
  - invalid key
  - slow connection / timeout path

**Commit suggestion:**
```bash
git add src/renderer/src/stores/useSettingsStore.ts src/renderer/src/components/settings src/preload src/main/ipc/settings-handlers.ts src/main/services
git commit -m "feat: improve china-ready provider and proxy flows"
```

---

### Task 5: Internal Team Rollout

**Files:**
- Create: `docs/internal-install.md`
- Create: `docs/internal-faq.md`
- Create: `docs/internal-feedback.md`
- Modify: `README.zh-CN.md`
- Optionally create: `scripts/release-internal.sh`

**Objective:** Make the fork easy to recommend to colleagues without live support every time.

**Steps:**
1. Write a 10-minute onboarding doc.
   - install
   - add project
   - choose model
   - start session
   - common shortcuts
2. Write an internal FAQ.
   - proxy
   - unsigned app install
   - missing native addon
   - OpenCode / model connection failures
3. Define feedback intake.
   - lightweight markdown template is enough
   - collect only: pain point, repro, expected behavior, environment
4. Pilot with 2-3 developers first.
   - do not broaden rollout before fixing the top repeated failures

**Exit criteria:**
- A colleague can install and start using the app from docs alone.

---

### Task 6: Long-Term Product Separation

**Files:**
- Create: `docs/product-direction.md`
- Create: `docs/upstream-sync-policy.md`
- Modify later: `package.json`
- Modify later: `electron-builder.yml`
- Modify later: `resources/*`

**Objective:** Avoid getting trapped as a forever-fork with no product identity.

**Steps:**
1. Define what remains upstream-compatible and what becomes fork-owned.
2. Separate “borrowed shell” from “owned product decisions”.
3. Schedule brand rename before broad distribution.
4. Decide sync policy:
   - monthly upstream merge
   - only security / bugfix cherry-picks
   - no expectation of upstream PR acceptance

**Recommended rule:**
- Upstream changes are merged when they improve your product.
- Your roadmap is not blocked by upstream priorities.

---

## Immediate Execution Order

1. Task 2 first: internal unsigned build pipeline.
   - Without an installable build, this is still a dev fork, not a usable tool.
2. Task 3 second: self-use UX bar.
   - Finish the last high-frequency UX friction points while usage is fresh.
3. Task 5 third: small-team rollout.
   - Only after install + core flows are stable.
4. Task 4 in parallel when personal usage reveals actual provider/network pain.
5. Task 6 after the fork becomes sticky enough that branding and roadmap separation matter.

## Recommended Next Coding Move

The next implementation session should focus on **Task 2**:

1. Create `scripts/build-local-cn.sh`
2. Verify `pnpm build:native`
3. Produce `pnpm build:mac:unsigned`
4. Write `docs/internal-install.md`

That is the fastest path from “good fork” to “installable product I can use and hand to coworkers”.
