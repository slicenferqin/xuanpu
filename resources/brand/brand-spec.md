# Xuanpu Brand Spec

> Date: 2026-04-28
> Direction: Folded Doorway / Hidden Garden Entrance
> Asset mode: v11 curated AI i2i source, pinned in `resources/brand/v11/final/icon-source.png`, then locally derived into platform assets.

## Positioning

Xuanpu is an AI-native desktop workbench for builders. It is not an IDE skin or a chat sidebar. The brand should express one product truth:

```text
Xuanpu opens a focused field for coding agents.
```

The icon system should therefore feel like an entrance into a structured work field, not a diagram of
product features.

## Core Assets

| Asset                | Path                                                              | Use                                       |
| -------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| Final source artwork | `resources/brand/v11/final/icon-source.png`                       | Active curated source selected for v11    |
| Source icon artwork  | `resources/icon-source.png`                                       | Active source for desktop platform icons  |
| macOS icon           | `resources/icon.icns`                                             | electron-builder mac target               |
| Windows icon         | `resources/icon.ico`                                              | electron-builder win target               |
| Linux icon           | `resources/icon.png`                                              | electron-builder linux target             |
| Renderer icon        | `src/renderer/src/assets/icon.png`                                | In-app brand display                      |
| Mobile icon          | `mobile/public/icon.svg`                                          | Mobile web/PWA shell                      |
| Mobile PNG icons     | `mobile/public/icon-192.png`, `mobile/public/icon-512.png`        | Manifest fallback icons                   |
| README banner        | `resources/banner.png`                                            | GitHub README hero                        |
| README banner source | `resources/brand/banner-v11/final/banner.png`                     | Pinned AI-generated 3:1 banner extended to 2064x512 |
| DMG background       | `resources/dmg-background.png`, `resources/dmg-background@2x.png` | macOS installer Finder window background  |
| DMG background source | `resources/brand/dmg-v11/final/background-base.png`              | Pinned no-text AI base with local installer overlay |
| App empty background | `src/renderer/src/assets/onboarding-bg.png`, `src/renderer/src/assets/onboarding-bg-dark.png` | Empty session and onboarding wizard background |
| App empty background source | `resources/brand/onboarding-v11/final/onboarding-bg.png`   | Pinned Catppuccin Latte AI source |
| App empty dark background source | `resources/brand/onboarding-v11/final/onboarding-bg-dark.png` | Pinned Catppuccin Mocha AI source |
| Social preview       | `docs/social-preview.png`                                         | Repository/social sharing image           |
| Social preview source | `resources/brand/social-v11/final/social-preview.png`            | Pinned AI-generated social preview        |
| Vector mark          | `resources/brand/icon-mark.svg`                                   | Documentation and future design use       |
| Horizontal lockup    | `resources/brand/lockup-horizontal.svg`                           | Docs, release notes, website              |
| Palette              | `resources/brand/palette.json`                                    | Canonical color tokens                    |

## Palette

| Token            | Hex       | Role                                       |
| ---------------- | --------- | ------------------------------------------ |
| Porcelain        | `#F7F3EA` | Light product tile, README background      |
| Porcelain Warm   | `#EFE7D5` | Warm depth and paper-like shading          |
| Porcelain Shadow | `#CFC8B8` | Tile edge and subtle platform boundary     |
| Jade Mist        | `#DCEBE2` | Soft field background, social gradients    |
| Field Jade       | `#7FB69A` | Primary field/context signal               |
| Field Jade Deep  | `#30463D` | Core glyph, small-size contrast            |
| Field Jade Dark  | `#1E2B27` | Brand wordmark and high-emphasis text      |
| Ink              | `#111827` | Dark UI anchor and fallback text           |
| Ink Soft         | `#27302C` | Secondary high-contrast text               |
| Muted            | `#66766F` | Supporting copy                            |
| Line             | `#C8D0C5` | Fine structural lines                      |
| Signal Gold      | `#D7B96C` | Occasional editorial warmth, not core mark |

## Mark Logic

The symbol has three parts:

- A folded doorway: the product opens into a focused working field.
- A pale inner void: the agent's local operating space remains calm and legible.
- A compact angular fold mark: motion and entry are implied without becoming a literal arrow, branch,
  clock, magnifier, notebook, or workflow diagram.

The app icon should read first as a macOS object with a quiet "洞天入口" feeling, not as a literal
Chinese character or a feature diagram. Supporting assets may show "玄圃" as the wordmark, but the
icon itself should stay structural and compact.

The current app icon preserves AI 11's frosted jade / matte lacquer surface with a restrained edge
highlight. Dock, Finder, Launchpad, GitHub, and release pages all reward the clear silhouette; the
light porcelain tile gives the mark product-level presence without falling back to generic AI
gradients, stars, or chat motifs.

## App Empty State

The in-app empty and onboarding backgrounds should follow the active Catppuccin UI surfaces instead
of the warmer repository/installer art direction. Use Latte/Mocha base colors, quiet lavender and
teal edge traces, and only edge-positioned folded-panel hints. The center must stay visually empty
without a glow, spotlight, or illustration subject so the product copy sits on the same calm surface
as the rest of the app.

## Typography

Use the platform system stack in product UI. Brand images generated on macOS use:

```text
Chinese display: STHeiti / system CJK fallback
Latin mono: SF Mono
Latin/body: SF Pro system fallback
```

## Usage Rules

- Keep slogans, multi-word text, and literal UI widgets out of the app icon.
- Keep Field Jade as the primary signal; reserve Signal Gold for occasional editorial accent, not the core logo.
- Use the light porcelain field for app and repository presence; keep dark ink for product UI context.
- Preserve the pinned v11 source crop and padding. Do not run smart crop, subject crop, or a second
  100px app-icon inset over this source.
- Platform icons must be generated from `resources/icon-source.png` via `scripts/generate-icon.py`
  in the default `final` source mode.
- The app icon must remain recognizable at 16px.

## Avoid

- Full landscape ink painting as the app icon.
- Generic AI stars, magic wands, chat bubbles, or robot heads.
- Glowing agent nodes, branching network diagrams, or orbit dots in the core logo.
- A literal terminal prompt as the primary mark.
- Literal Chinese-glyph icons that collapse into unreadable strokes below 32px.
- Generic git-branch or network-node marks that could belong to any developer tool.
- Double app-icon backplates caused by feeding a generated full tile into another icon mask.
- Low-contrast pale green on pale backgrounds.
- Reintroducing the removed gold line into the core icon or SVG fallback.
- Reinterpreting the icon as a page, notebook, clock, magnifier, scanner, route map, or node graph.

## Regeneration

Run:

```bash
python3 scripts/generate-brand-assets.py
python3 scripts/generate-icon.py
```

The first command syncs `resources/brand/v11/final/icon-source.png` into `resources/icon-source.png`,
copies `resources/brand/banner-v11/final/banner.png` into `resources/banner.png`, derives the DMG
background from `resources/brand/dmg-v11/final/background-base.png`, copies the pinned Catppuccin app
empty backgrounds, copies `resources/brand/social-v11/final/social-preview.png`, then regenerates docs
icons, mobile SVG, and palette assets. The second command derives all platform desktop icons, renderer
PNG, and mobile PNG icons from the active source icon artwork without applying the old artwork inset.
