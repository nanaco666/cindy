# Design System Inspired by Ollama

## 1. Visual Theme & Atmosphere

Ollama's interface is radical minimalism taken to its logical conclusion — a pure-white void where content floats without decoration, shadow, or color. The design philosophy mirrors the product itself: strip away everything unnecessary until only the essential tool remains. This is the digital equivalent of a Dieter Rams object — every pixel earns its place, and the absence of design IS the design.

The entire page exists in pure grayscale. There is zero chromatic color in the interface — no brand blue, no accent green, no semantic red. The only colors that exist are shades between pure black (`#000000`) and pure white (`#ffffff`), creating a monochrome environment that lets the user's mental model of "open models" remain uncolored by brand opinion. The Ollama llama mascot, rendered in simple black line art, is the only illustration — and even it's monochrome.

What makes this system distinctive is the combination of a single geometric sans-serif (Inter) with an exclusively pill-shaped geometry (9999px radius on everything interactive). The clean letterforms + rounded buttons + rounded containers create a cohesive "softness language" that makes a developer-oriented tool feel approachable and friendly rather than intimidating. This is minimalism with warmth — not cold Swiss-style grid minimalism, but the kind where the edges are literally softened.

**Key Characteristics:**

- Pure white canvas with zero chromatic color — completely grayscale
- Inter as the single sans family, carrying both display headlines and body text
- Tight border-radius system: 8px (inner controls) / 12px (containers) / 9999px (pill) — three values, nothing else
- Zero shadows — depth comes exclusively from background color shifts and borders
- Pill-shaped geometry on all interactive elements (buttons, tabs, inputs, tags)
- The Ollama llama as the sole illustration — black line art, no color
- Extreme content restraint — the homepage is short, focused, and uncluttered

## 2. Color Palette & Roles

> **多主题架构注意**:本节列出的色值是 **Default Light / Default Dark**(默认主题,设计灵感来自 Ollama 官网)的具体值,作为视觉规范的参考样本。运行时**每个色值都通过 token 引用**(见第 10 节 Theme System & Token Reference),所以同一组件在其它主题(如 Eclipse / One Dark Pro / Monokai Pro)下会自动呈现该主题的对应色。**实现组件时永远写 token 不写 hex**——具体规则见 CLAUDE.md 规则 #18。

### Primary Text

- **Pure Black** (`#000000`): Primary headlines, primary links, and the darkest text in Light Mode. The only "color" that demands attention. **Never used as a background** — reserved exclusively for text and icons.
- **Near Black** (`#262626`): Button text on light-colored surfaces, secondary headline weight.

### Layer System (Light & Dark)

The interface is built from a three-tier layer system that applies symmetrically to both modes — **Surface** as the base, **Card** as the elevated layer, and **Board** as the hairline divider. This is the foundation of every page in every mode.


| Role        | Light Mode | Dark Mode | Usage                                                                                                                                                                              |
| ----------- | ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Surface** | `#f8f8f6`  | `#1f1f1e` | The primary page background — every page starts here. In full-window app layouts, this is the single flat background. In centered-card layouts, this is the page beneath the card. |
| **Card**    | `#ffffff`  | `#2c2c2a` | The elevated layer sitting on top of Surface — login cards, modals, panels, raised containers, and any element that needs to visually lift off the page.                           |
| **Board**   | `#d7d7d4`  | `#3c3c3a` | The hairline divider color — 1px borders between sections, card outlines, and any separator line within the same layer.                                                            |


**Layer rule — flat vs. elevated:**

- **Full-window applications** (e.g. main workspace, chat interface, dashboards): use **Surface** as a single flat background for the entire window — no Card layer at the page-structure level. Section boundaries (sidebar, toolbar, content area) are drawn with 1px **Board** dividers, never with background color shifts.
- **Centered-card layouts** (e.g. login, modal, empty-state card on a blank page): use **Surface** as the page background and **Card** as the lifted card. The color difference between Surface and Card is what makes the card read as "lifted" — no shadow needed. The card outline is drawn in **Board**.

> **Important — element-level vs. page-level:** The "flat Surface" rule in full-window layouts applies only to the **overall page structure**, not to individual widgets. Lifted widgets *within* a full-window layout — inputs, chat input boxes, raised cards, modal overlays, panel popups — still use **Card** color per their component rules (see Section 4). A full-window chat interface can have a flat Surface page *and* a Card-colored chat input box at the same time; those are two different scopes. "Surface flat" means "don't split the page into Page+Card layers," not "every element on the page must be Surface color."

### Chip & Button Neutrals

Small interactive chips (button backgrounds, tag pills, avatar fills, selected-nav pills) sit outside the layer system — they're foreground elements, not background layers.

- **Light Gray** (`#e5e5e5`): Chip/button backgrounds in Light Mode — the workhorse neutral for pressed states, filled pills, tag backgrounds, and avatar fills.
- **Dark Chip** (`#2c2c2a`): Chip/button backgrounds in Dark Mode — equal to Dark Card; the lifted-pill color against a `#1f1f1e` Surface. (In Dark Mode, the Card layer color and the chip color collapse to the same value — both represent "one step lifted off Surface.")

> ~~**Border Light** (`#d4d4d4`)~~ —— 已废弃(2026-06,G2)。原称"white-button 专用边框色",但全仓库无真实组件使用(只有 experimental 视图裸 hardcode)。White Pill 次按钮边框统一走 **Board**(`--border-default` `#d7d7d4`)。

### Neutrals & Text

- **Stone** (`#737373`): Secondary body text, footer links, and de-emphasized content. The primary "muted" tone.
- **Mid Gray** (`#525252`): Emphasized secondary text, slightly darker than Stone.
- **Silver** (`#a3a3a3`): Tertiary text and deeply de-emphasized metadata. **不要用作 placeholder**——太显眼、读着像已填(见 §4 Inputs + §13 G3,placeholder 走 `--text-placeholder` `#c4c4c4`)。

> ~~**Button Text Dark** (`#404040`)~~ —— 已废弃(2026-06,G1)。原称"white-surface 按钮文字专用色",但全仓库无真实按钮使用(只有 experimental 视图裸 hardcode)。White Pill 次按钮文字统一走 **Near Black**(`--text-primary` `#262626`)。

### Semantic & Accent

The grayscale rule is near-absolute. The following are the **only** sanctioned non-gray colors in the system — each tightly scoped to a specific surface. New semantic colors must not be introduced without being recorded here first.

- **Ring Blue** (`#3b82f6` at 50%): Tailwind's default focus ring, used exclusively for keyboard accessibility. Never visible in normal interaction flow.
- **Thinking Orange** (`#EA6B17`,设计定稿 2026-07-17 取代 `#FF6600` 冻结红线): Used exclusively for the Running Status Bar in ChatView when the Claude Code SDK is actively processing (streaming / tool_use). Applies only to the sparkles icon and status text (e.g. `Spelunking...`); no background fill, no use outside this surface. Reference: `doc/design_docs/cc-agent-view.pen` Running Status Bar.

> **Additional narrowly-scoped exceptions** (documented in their respective component specs, do NOT generalize as system semantic colors):
>
> - **Toast Info / Success / Warning / Error** — `#417CDD` / `#2AAE5B` / `#F3A115` / `#D91F37`(E5D 定稿 2026-07-17 扩簇,Toast 豁免解除)used ONLY on the 16×16 lucide icon inside Toast pill notifications. The pill body (background, text, border, close icon) remains strictly grayscale. info 蓝 #417CDD 与 focus-ring/Auto Approval 同值(原 #3B82F6 2026-07-14 增,现定稿);success/warning/error 与全局状态色同值(done 绿/状态 error/warning 前景)。 See `doc/prod_docs/xdt-maker-通用提示条.md` V0.3 F7.
> - **ConfirmDialog Danger** — `#EF4444` used ONLY on the confirm button background in the Danger variant. The cancel button and rest of the dialog remain grayscale. See `doc/prod_docs/xdt-maker-通用确认弹窗.md` V0.2 F4.
> - **Permission Selector Mode Highlights** — selected risky permission modes may color only the option text/icon/checkmark and the collapsed trigger text/icon. The selected row background remains grayscale. Auto Approval uses `#417CDD` in both modes(设计定稿 2026-07-17 扩簇,light/dark 同值;取代 light #000050/dark #00D9C5). Full Access uses Heart Orange `#EA6B17` in both modes(随 warning-accent 自动跟随,定稿 2026-07-17). These hex values are the **default-theme palette only** — other themes may override `--perm-auto-selected-text` and `--perm-bypass-selected-text` with their own accent colors, provided both modes remain color-coded, distinguishable from each other, and visually distinct from neutral text. Tokens: `--perm-auto-selected-text` and `--perm-bypass-selected-text` in `apps/desktop/src/renderer/styles/globals.css`.
> - **Diff Add Green / Diff Del Red** — GitHub-standard diff syntax colors, used on the `+` / `-` symbol glyph, the changed-line text foreground, **and the full row background** inside code-diff renderings. Applied in three places: (1) the Edit-tool DiffView card (F-MSG-6), (2) markdown ````diff` fenced code blocks in the message stream, and (3) `.diff` / `.patch` files opened in TextLightbox (the document previewer) — there hljs `.hljs-addition` / `.hljs-deletion` are forced `display: block` so the background fills to the right edge instead of stopping at the last glyph. Line-number gutter and ctx (unchanged) lines remain strictly grayscale per the layer system. **Foreground** — Add: `#22863a` Light / `#7ee787` Dark; Del: `#b31d28` Light / `#ff7b72` Dark. **Background** — Add: `#f0fff4` Light / `#033a16` Dark; Del: `#ffeef0` Light / `#67060c` Dark. Tokens: `--diff-add-fg/-bg` and `--diff-del-fg/-bg` in `apps/desktop/src/renderer/styles/globals.css`. Updated 2026-04-21: backgrounds switched from grayscale → GitHub red/green for full-row fill so additions / deletions are unambiguous at a glance. Reference frame: `doc/design_docs/cc-agent-view.pen` "Light/Dark Mode - Markdown Diff Code Block".

*Dark Mode text uses softened neutrals to reduce eye strain: **Soft Gray** (`#d4d4d4`) for primary text, Stone (`#737373`) for secondary, Silver (`#a3a3a3`) for tertiary. Pure White (`#ffffff`) is reserved for button labels and high-contrast UI elements on dark backgrounds.*

### Gradient System

- **None.** Ollama uses absolutely no gradients. Visual separation comes from flat color blocks and single-pixel borders. This is a deliberate, almost philosophical design choice.

## 3. Typography Rules

### Font Family

- **Display / Body / UI**: `Inter`, with fallbacks: `system-ui, -apple-system, "Segoe UI", sans-serif`
- **Monospace**: `JetBrains Mono`, with fallbacks: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`

*Note: The entire interface uses a single sans font — Inter — for both display headlines and body text. Inter is chosen for (a) its neutral, geometric character that stays out of the way, (b) its excellent legibility at small sizes, and (c) its wide availability in both web and design tooling (including the Pencil .pen editor). A single font keeps the hierarchy clean — separation comes from size and weight, not typeface contrast.*

### Hierarchy


| Role            | Font           | Size           | Weight  | Line Height  | Letter Spacing                         | Notes                                                                                                                                                                                                                                                        |
| --------------- | -------------- | -------------- | ------- | ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Display / Hero  | Inter          | 48px (3rem)    | 500     | 1.00 (tight) | normal                                 | Maximum impact headline                                                                                                                                                                                                                                      |
| Section Heading | Inter          | 36px (2.25rem) | 500     | 1.11 (tight) | normal                                 | Feature section titles                                                                                                                                                                                                                                       |
| Sub-heading     | Inter          | 30px (1.88rem) | 400–500 | 1.20 (tight) | normal                                 | Card headings, feature names                                                                                                                                                                                                                                 |
| Card Title      | Inter          | 24px (1.5rem)  | 400     | 1.33         | normal                                 | Medium emphasis headings                                                                                                                                                                                                                                     |
| Body Large      | Inter          | 18px (1.13rem) | 400–500 | 1.56         | normal                                 | Hero descriptions, button text                                                                                                                                                                                                                               |
| Body / Link     | Inter          | 16px (1rem)    | 400–500 | 1.50         | normal                                 | Standard body text, navigation                                                                                                                                                                                                                               |
| Caption         | Inter          | 14px (0.88rem) | 400     | 1.43         | normal                                 | Metadata, descriptions                                                                                                                                                                                                                                       |
| Small           | Inter          | 12px (0.75rem) | 400     | 1.33         | normal                                 | Smallest sans-serif text                                                                                                                                                                                                                                     |
| Micro Label     | Inter          | 10–13px        | 400–500 | 1.20–1.40    | optional 0.5–1px tracking on uppercase | **Auxiliary / non-reading** labels only — sidebar tree section heads (13px), tree row counts, frontmatter field names, scope chips, tag pills, status badges, breadcrumb segments. Never used for body text or anything the user reads sentence-by-sentence. |
| Code Body       | JetBrains Mono | 16px (1rem)    | 400     | 1.50         | normal                                 | Inline code, commands                                                                                                                                                                                                                                        |
| Code Caption    | JetBrains Mono | 14px (0.88rem) | 400     | 1.43         | normal                                 | Code snippets, secondary                                                                                                                                                                                                                                     |
| Code Small      | JetBrains Mono | 11–12px        | 400–500 | 1.40–1.63    | normal                                 | Tags, labels, in-tree paths                                                                                                                                                                                                                                  |


### Principles

- **Single sans family**: Inter carries both display headlines and body text — no typeface switching between hierarchy levels. Size and weight alone create hierarchy, keeping the typographic system maximally simple.
- **Weight restraint**: Only two weights matter — 400 (regular) for body and 500 (medium) for headings. No bold, no light, no black weight. This extreme restraint reinforces the minimal philosophy.
- **Tight display, comfortable body**: Headlines compress to 1.0 line-height, while body text relaxes to 1.43–1.56. The contrast creates clear hierarchy without needing weight contrast.
- **Monospace for code only**: JetBrains Mono is reserved for inline code, terminal commands, and code blocks — never used for UI chrome.

## 4. Component Stylings

### Buttons

**Gray Pill (Primary)**

- Background: Light Gray (`#e5e5e5`)
- Text: Near Black (`#262626`)
- Padding: 10px 24px
- Border: thin solid Light Gray (`1px solid #e5e5e5`)
- Radius: pill-shaped (9999px)
- The primary action button — understated, grayscale, always pill-shaped

**White Pill (Secondary)**

- Background: Pure White (`#ffffff`) — `--surface-elevated`
- Text: Near Black (`#262626`) — `--text-primary`
- Padding: 10px 24px
- Border: thin solid Board (`1px solid #d7d7d4`) — `--border-default`
- Radius: pill-shaped (9999px)
- Secondary action — visually lighter than Gray Pill

**Black Pill (CTA)**

- Background: Pure Black (`#000000`)
- Text: Pure White (`#ffffff`)
- Radius: pill-shaped (9999px)
- Inferred from "Create account" and "Explore" buttons
- Maximum emphasis — black on white

### Cards & Containers

- Background: Card (`#ffffff` Light / `#2c2c2a` Dark) or Surface (`#f8f8f6` Light / `#1f1f1e` Dark) depending on layer context
- Border: thin solid Board (`1px solid #d7d7d4` Light / `1px solid #3c3c3a` Dark) when needed
- Radius: comfortably rounded (12px) — the container radius (see §5 three-tier scale; 8px is reserved for inner controls like textareas / dropdown rows, pill for interactive elements)
- Shadow: **none** — zero shadows on any element
- Hover: likely subtle background shift or border darkening

### Inputs & Forms

- Background: Card (`#ffffff` Light / `#2c2c2a` Dark)
- Border: `1px solid` Board (`#d7d7d4` Light / `#3c3c3a` Dark)
- Radius: pill-shaped (9999px) — single-line search inputs and form fields are pill-shaped. **多行输入框(textarea)套不了胶囊**(高框会变形),改用 8px 内层圆角(见 §5 三档圆角)。
- Focus: Ring Blue (`#3b82f6` at 50%) ring
- Placeholder: **`--text-placeholder`** slot — **Faded Light** (`#c4c4c4`) Light / **Mid Gray** (`#525252`) Dark — must read as clearly empty, not pre-filled. Silver (`#a3a3a3`) is too prominent against either Card surface (≈5:1 in Dark, ≈2.6:1 in Light) and reads as real input. **所有输入面的 placeholder(chat / ask / settings / plan-action-fb)统一收口于此 slot**(2026-06 G3);非默认主题通过 override `text-placeholder` 表达各自的 placeholder 色。

### Select & Dropdown

- **Trigger**: 同单行输入 —— pill(9999px),Card bg,1px Board 边框,承载当前值 + chevron。
- **弹出面板**: 是个容器 —— 12px 圆角,Card bg(`--surface-elevated`),1px Board 边框,无阴影(靠 overlay / 层色分隔),内边距 6–8px。
- **面板宽度必须绑定 trigger 宽度** —— 不许比触发它的控件更窄或更宽。Radix Select 用 `position="popper"` + `width: var(--radix-select-trigger-width)`;其它原语则取 trigger 实测宽度对齐。(反复踩的点:下拉宽度要跟上方一致。)
- **选项行**: 选中 / 悬浮的高亮底色用 **8px 内层圆角**(见 §5 —— 面板是 12px 容器,行高亮是内层 8px,内层必须比面板小才嵌套协调)。高亮 bg 走 `--surface-hover` / Radix `data-[highlighted]`;选中行给 chip 填充,未选中行透明。

### Dialog & Modal

参照实现 `components/ui/confirm-dialog.tsx`(通用确认弹窗);新建弹窗沿用它的结构,不另起一套。

- **Overlay**: 全屏遮罩走 `--overlay-modal` token(ConfirmDialog 现用 `neutral-900/40` 硬编码 pair 是历史遗留,**新弹窗一律走 token**,别照抄)。
- **容器**: 是个容器 —— 12px 圆角(`rounded-xl`),`--confirm-bg`,`--confirm-shadow`,16px 内边距(`p-4`),居中。宽度:确认 / 提示类 ≈ 400px(`max-w-[400px]`);带输入 / 表单的可放宽到 ≈ 460px 并随视口收窄(`min(460px, 100vw-32px)`)。
- **标题 / 描述**: `--confirm-title` / `--confirm-desc`,medium 字重。
- **按钮**: pill(9999px);主按钮 = 实心 CTA(`--confirm-btn-primary-*`),次按钮 / 取消 = 描边(`--confirm-btn-secondary-*`,透明底 + Board 边框);底部 `justify-end`。
- **打开时焦点**: 落在该弹窗的**主输入或主按钮**,不要默认停在取消键(见 §14.2 + ConfirmDialog 的 `autoFocusConfirm` / `onOpenAutoFocus`)。

### Navigation

- Clean horizontal nav with minimal elements
- Logo: Ollama llama icon + wordmark in black
- Links: "Models", "Docs", "Pricing" in black at 16px, weight 400
- Search bar: pill-shaped with placeholder text
- Right side: "Sign in" link + "Download" black pill CTA
- No borders, no background — transparent nav on white page

### Image Treatment

- The Ollama llama mascot is the only illustration — black line art on white
- Code screenshots/terminal outputs shown in bordered containers (12px radius)
- Integration logos displayed as simple icons in a grid
- No photographs, no gradients, no decorative imagery

### Distinctive Components

**Tab Pills**

- Pill-shaped tab selectors (e.g., "Coding" | "OpenClaw")
- Active: Light Gray bg; Inactive: transparent
- All pill-shaped (9999px)

**Model Tags**

- Small pill-shaped tags (e.g., "ollama", "launch", "claude")
- Light Gray background, dark text
- The primary way to browse models

**Terminal Command Block**

- Monospace code showing `ollama run` commands
- Minimal styling — just a bordered 12px-radius container
- Copy button integrated

**Integration Grid**

- Grid of integration logos (Codex, Claude Code, OpenCode, LangChain, etc.)
- Each in a bordered pill or card with icon + name
- Tabbed by category (Coding, Documents & RAG, Automation, Chat)

## 5. Layout Principles

### Spacing System

- Base unit: 8px
- Scale: 4px, 6px, 8px, 9px, 10px, 12px, 14px, 16px, 20px, 24px, 32px, 40px, 48px, 88px, 112px
- Button padding: 10px 24px (consistent across all buttons)
- Card internal padding: approximately 24–32px
- Section vertical spacing: very generous (88px–112px)

### Grid & Container

- Max container width: approximately 1024–1280px, centered
- Hero: centered single-column with llama illustration
- Feature sections: 2-column layout (text left, code right)
- Integration grid: responsive multi-column
- Footer: clean single-row

### Whitespace Philosophy

- **Emptiness as luxury**: The page is remarkably short and sparse — no feature section overstays its welcome. Each concept gets minimal but sufficient space.
- **Content density is low by design**: Where other AI companies pack feature after feature, Ollama presents three ideas (run models, use with apps, integrations) and stops.
- **The white space IS the brand**: Pure white space with zero decoration communicates "this tool gets out of your way."

### Border Radius Scale

三档圆角,**仅此三档**:

- **Inner control (8px)**: 窄第三档,**只**给"做不成胶囊"的小交互件:多行输入框(textarea)、下拉 / 菜单的选中行高亮、段内小单元格。实现为 Tailwind `rounded-lg`(8px)。
- **Container (12px)**: 盒子圆角 — 代码块、卡片、面板、弹窗。实现为 Tailwind `rounded-xl`(12px)。
- **Pill (9999px)**: 能套胶囊的所有交互件 — 按钮、Tab、单行输入、标签、徽标。

*没有 4px / 6px / 10px,也不开放任意圆角。绝大多数元素仍只在 12px 容器和 pill 里二选一;8px 是给"塞不进胶囊的小控件"的窄例外。注意嵌套:8px 行高亮套在 12px 面板里时,内层圆角必须比容器小才协调(所以是 8 而非 12),做成胶囊则会变成药丸、做成 12px 会显得鼓。*

## 6. Depth & Elevation


| Level              | Treatment                                                                 | Use                                            |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Flat (Level 0)     | No shadow, no border                                                      | Surface background, most content               |
| Bordered (Level 1) | `1px solid` Board (`#d7d7d4` Light / `#3c3c3a` Dark)                      | Cards, code blocks, dividers, section outlines |
| Lifted (Card)      | Card fill (`#ffffff` Light / `#2c2c2a` Dark) + optional 1px Board outline | Login cards, modals, raised panels             |


**Shadow Philosophy**: Ollama uses **zero shadows**. This is not an oversight — it's a deliberate design decision. Every other major AI product site uses at least subtle shadows. Ollama's flat, shadowless approach creates a paper-like experience where elements are distinguished purely by background color and single-pixel borders. Depth is communicated through **content hierarchy and typography weight**, not visual layering.

## 7. Do's and Don'ts

### Do

- Use Surface (`#f8f8f6` Light / `#1f1f1e` Dark) as the page background — every page starts here
- Use pill-shaped (9999px) radius on all interactive elements — buttons, tabs, inputs, tags
- Use 12px radius on all non-interactive containers — code blocks, cards, panels
- Use 8px radius only for inner controls that can't be a pill — multi-line inputs, dropdown/menu rows (see §5)
- Keep the palette strictly grayscale — no chromatic colors except the blue focus ring
- Use Inter at weight 500 for display headings — hierarchy comes from size + weight, not typeface switching
- Maintain zero shadows — depth comes from borders and background shifts only
- Keep content density low — each section should present one clear idea
- Use monospace for terminal commands and code — it's primary content, not decoration
- Keep all buttons at 10px 24px padding with pill shape — consistency is absolute

### Don't

- Don't introduce any chromatic color — no brand blue, no accent green, no warm tones
- Don't invent arbitrary radii — only three values exist: 8px (inner controls), 12px (containers), 9999px (pill). Nothing in between, nothing else.
- Don't add shadows to any element — the flat aesthetic is intentional
- Don't use font weights above 500 — no bold, no black weight
- Don't add decorative illustrations beyond the llama mascot
- Don't use gradients anywhere — flat blocks and borders only
- Don't overcomplicate the layout — two columns maximum, no complex grids
- Don't use borders heavier than 1px — containment is always the lightest possible touch
- Don't add decorative or large-motion animation — no bounce, parallax, looping, or gratuitous movement. Short **functional** state transitions (color / background / opacity, ≤150ms) are fine and expected — see §14.4.

## 8. Responsive Behavior

### Breakpoints


| Name          | Width       | Key Changes                                      |
| ------------- | ----------- | ------------------------------------------------ |
| Mobile        | <640px      | Single column, stacked everything, hamburger nav |
| Small Tablet  | 640–768px   | Minor adjustments to spacing                     |
| Tablet        | 768–850px   | 2-column layouts begin                           |
| Desktop       | 850–1024px  | Standard layout, expanded features               |
| Large Desktop | 1024–1280px | Maximum content width                            |


### Touch Targets

- All buttons are pill-shaped with generous padding (10px 24px)
- Navigation links at comfortable 16px size
- Minimum touch area easily exceeds 44x44px

### Collapsing Strategy

- **Navigation**: Collapses to hamburger menu on mobile
- **Feature sections**: 2-column → stacked single column
- **Hero text**: 48px → 36px → 30px progressive scaling
- **Integration grid**: Multi-column → 2-column → single column
- **Code blocks**: Horizontal scroll maintained

### Image Behavior

- Llama mascot scales proportionally
- Code blocks maintain monospace formatting
- Integration icons reflow to fewer columns
- No art direction changes

## 9. Agent Prompt Guide

### Quick Color Reference

- Primary Text: "Pure Black (#000000)" Light / "Soft Gray (#d4d4d4)" Dark
- **Surface** (page bg): "Light Surface (#f8f8f6)" / "Dark Surface (#1f1f1e)"
- **Card** (elevated layer): "Pure White (#ffffff)" / "Dark Card (#2c2c2a)"
- **Board** (1px dividers/borders): "Light Board (#d7d7d4)" / "Dark Board (#3c3c3a)"
- Secondary Text: "Dark Gray (#525252)" Light / "Silver (#a3a3a3)" Dark
- Tertiary Text: "Stone (#737373)" Light / "Stone (#737373)" Dark
- Near Black: (#262626) — Light primary reading text
- Chip/Button Background: "Light Gray (#e5e5e5)" Light / "Dark Chip (#2c2c2a)" Dark

### Example Component Prompts

- "Create a hero section on Surface (#f8f8f6) with an illustration centered above a headline at 48px Inter weight 500, line-height 1.0. Use Pure Black (#000000) text. Below, add a black pill-shaped CTA button (9999px radius, 10px 24px padding) and a gray pill button."
- "Design a code block with a 12px border-radius, 1px solid Board (#d7d7d4 Light / #3c3c3a Dark) border on Card background. Use JetBrains Mono at 16px for the terminal command. No shadow."
- "Build a tab bar with pill-shaped tabs (9999px radius). Active tab: Light Gray (#e5e5e5) background, Near Black (#262626) text. Inactive: transparent background, Stone (#737373) text."
- "Create an integration card grid. Each card is a bordered pill (9999px radius) or a 12px-radius card with 1px solid Board (#d7d7d4) border. Icon + name inside. Grid of 4 columns on desktop."
- "Design a navigation bar: transparent background, no border. Ollama logo on the left, 3 text links (Pure Black, 16px, weight 400), pill search input in the center, 'Sign in' text link and black pill 'Download' button on the right."

### Iteration Guide

1. Focus on ONE component at a time
2. Keep all values grayscale — "Stone (#737373)" not "use a light color"
3. Always specify radius from the three tiers — pill (9999px) / container (12px) / inner control (8px, only for textareas & dropdown rows). Nothing else.
4. Shadows are always zero — never add them
5. Weight is always 400 or 500 — never bold
6. If something feels too decorated, remove it — less is always more for Ollama

## 10. Theme System & Token Reference

### 架构

Cindy 桌面端用 **VSCode 风格的 ColorRegistry + Theme override** 模型管理颜色。所有颜色都通过 CSS variable 以 token 形式被组件消费,**永远不允许在组件里硬编码 hex / rgba**(违反规则会让该组件在非默认主题下无法切色)。

源码:`apps/desktop/src/renderer/themes/`
- `color-registry.ts` — `ColorRegistry` 单例和 `registerColor(id, defaults, description)` API
- `colors.ts` — 注册全部 token(目前 352 个:40 semantic slot + 228 alias + 84 singleton),按"semantic slot 在前,alias 和 singleton 在后"组织
- `theme-service.ts` — `applyTheme(theme)` 把所有 token 序列化成 `:root{}` 注入 `<style id="theme-vars">`
- `builtin/ollama-light.ts` / `ollama-dark.ts` / `taptap-dark.ts` — 三套内置主题对象
- `registry.ts` — `builtinThemes` 注册表 + `listThemesByType('light' | 'dark')`

切主题:`useTheme.ts` 提供 `theme`(System / Light / Dark mode) + `lightThemeId` / `darkThemeId`(具体哪套主题)。Settings → Appearance 是 UI 入口。

### Token 分层

**Tier 1 — Semantic slot (39 个)**:跨语境复用的核心语义槽,加新主题时这一层是 override 的主战场。

| 类目 | Slot | Ollama Light | Ollama Dark | 主要用途 |
|---|---|---|---|---|
| **Surface (12)** | `--surface` | `#f8f8f6` | `#1f1f1e` | 页面 Surface(hex 形式) |
| | `--surface-hsl` | `60 12.5% 97%` | `60 2% 12%` | 同上 HSL 形式,`hsl(var(--xxx))` 消费 |
| | `--surface-elevated` | `#ffffff` | `#2c2c2a` | Card 抬一层 / 弹窗 / popover |
| | `--surface-elevated-soft` | `#e5e5e5` | `#2c2c2a` | Disabled 状态 Card |
| | `--surface-card-ivory` | `#faf9f5` | `#2c2c2a` | Settings 微暖 ivory Card |
| | `--surface-chip` | `#e5e5e5` | `#3c3c3a` | Chip / pill / 选中行 |
| | `--surface-chip-alt` | `#e5e5e5` | `#2c2c2a` | Chip 暗态塌缩到 Card 变体 |
| | `--surface-hover` | `#e5e5e5` | `#3c3c3a` | 通用 hover bg |
| | `--surface-hover-soft` | `#f8f8f6` | `#3c3c3a` | 柔和 hover bg |
| | `--surface-hover-hsl` | `0 0% 90%` | `60 2% 17%` | hover HSL 形式 |
| | `--surface-on-card` | `#ffffff` | `#1f1f1e` | CTA / checked icon 深色前景 |
| **Border (4)** | `--border-default` | `#d7d7d4` | `#3c3c3a` | DESIGN.md Board 1px 边框 |
| | `--border-default-hsl` | `60 3% 84%` | `60 2% 23%` | Board HSL 形式 |
| | `--border-shadcn-hsl` | `0 0% 90%` | `30 4% 28%` | shadcn input/border HSL |
| | `--border-transparent-mixed` | `transparent` | `#3c3c3a` | progress track 等单边边框 |
| **Text (16)** | `--text-primary` | `#262626` | `#d4d4d4` | 主标题 / 主正文 |
| | `--text-primary-hsl` | `0 0% 9%` | `0 0% 83%` | Primary HSL 形式 |
| | `--text-primary-on-dark` | `#262626` | `#ffffff` | 反相文本(stop button icon 等) |
| | `--text-primary-emphasis` | `#1a1a1a` | `#d4d4d4` | Plan 强调主文字 |
| | `--text-primary-inv` | `#1a1a1a` | `#ffffff` | Plan-action approve text |
| | `--text-primary-body-strong` | `#525252` | `#d4d4d4` | Plan content body 加重 |
| | `--text-secondary` | `#737373` | `#a3a3a3` | Secondary 文字 / icon |
| | `--text-secondary-cross` | `#a3a3a3` | `#a3a3a3` | 跨主题更浅 secondary |
| | `--text-secondary-mid` | `#525252` | `#a3a3a3` | Muted body 文字 |
| | `--text-tertiary` | `#a3a3a3` | `#737373` | Placeholder / tertiary |
| | `--text-tertiary-stone` | `#737373` | `#737373` | Stone 跨主题三级 |
| | `--text-tertiary-mid` | `#525252` | `#737373` | Mid-gray tertiary |
| | `--text-tertiary-hsl` | `0 0% 45%` | `0 0% 45%` | Tertiary HSL |
| | `--text-disabled` | `#d4d4d4` | `#525252` | Disabled / failed |
| | `--text-disabled-tertiary` | `#a3a3a3` | `#737373` | Disabled placeholder 变体 |
| | `--text-placeholder` | `#c4c4c4` | `#525252` | 统一 placeholder slot(比 tertiary 更淡,读着像空);chat/ask/settings/plan-action-fb 输入框 placeholder 均收口于此 |
| **Accent (7)** | `--accent-cta-bg` | `#262626` | `#ffffff` | 反相 CTA bg(TapTap → teal) |
| | `--accent-cta-bg-pure` | `#000000` | `#ffffff` | Pure CTA bg |
| | `--accent-emphasis` | `#262626` | `#d4d4d4` | settings primary button 等 |
| | `--accent-soft` | `#262626` | `#ffffff` | Soft accent(folder btn 等) |
| | `--accent-hover` | `#262626` | `#e5e5e5` | CTA pressed/hover |
| | `--accent-pure-cta-fg` | `#ffffff` | `#000000` | CTA 文字 pure 反相 |
| | `--accent-fg-on-pure` | `#ffffff` | `#1f1f1e` | CTA 文字 light 白 / dark 沉 |

**Tier 2 — Alias (228 个)**:大量 component-scoped token(如 `--cmd-palette-bg`、`--msg-tool-card-text`、`--settings-input-border`)的 default 改写为 `var(--slot)`。浏览器自动 forward-resolve。组件不感知,**继续直接消费 alias 名字即可**。

**Tier 3 — Singleton (84 个)**:真独立的色值,无法收敛到 slot:语义豁免色(`--destructive` / `--diff-add-*` / `--status-bar-accent` 等)、平台特定色、splash 时长、`--radius` 等非颜色 token。

### 语义豁免色(跨主题不变)

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `--destructive` (HSL) | `0 84% 60%` | `0 72% 63%` | 通用 destructive 文本/边 |
| `--login-error-text` 等 5 个 | `#ef4444` | `#ef4444` | 错误文本 |
| `--error-bg/-border/-fg/-fg-strong` | (red) | (red) | Error alert 卡片子系统 |
| `--diff-add-fg/-bg`, `--diff-del-fg/-bg` | GitHub palette | GitHub palette | Diff 渲染 |
| `--status-bar-accent` | `#EA6B17` | `#EA6B17` | Thinking Orange,跨主题统一(定稿 2026-07-17) |
| `--plan-action-approve-icon-bg` | `#EA6B17` | `#EA6B17` | Plan approve,同 thinking 语义(随 warning-accent,定稿 2026-07-17) |
| `--perm-bypass-selected-text` | `#EA6B17` | `#EA6B17` | Heart Orange,permission 语义(var(--warning-accent) 自动跟随,定稿 2026-07-17) |
| `--settings-integration-warning` | `#EA6B17` | `#EA6B17` | warning 语义(var(--warning-accent) 自动跟随,定稿 2026-07-17) |
| `--warning-bg-soft` | rgba(255,102,0,0.12) | rgba(255,102,0,0.18) | Warning alpha surface |
| `--focus-ring` / `--focus-ring-soft` | `#417CDD` / @50% | 同左 | a11y 焦点 ring,定稿 2026-07-17(取代 #3b82f6),跨主题统一 |
| `--shadow-menu` / `--cmd-palette-shadow` / `--confirm-shadow` | rgba | rgba(更深) | Shadow,跨主题统一 |
| `--overlay-modal` / `--overlay-lightbox` | rgba | rgba(更深) | Modal / lightbox backdrop |
| `--perm-auto-selected-text` | `#417CDD` | `#417CDD` | Auto Approval accent,定稿 2026-07-17(light/dark 同值,取代 #000050/#00D9C5) |
| Toast `#417CDD / #2AAE5B / #F3A115 / #D91F37` | (在 Toast.tsx hardcode,已导出 VARIANT_MAP) | 同左 | E5D 定稿 2026-07-17(Toast 豁免解除,并入状态色族) |

实现组件时**永远不要在硬编码 hex 上自由发挥这些语义色**——必须走对应 token。

### 内置主题

当前实现以 `apps/desktop/src/renderer/themes/registry.ts` 的 `builtinThemes` 为准,新增/移除主题不要求同步本文档。默认的 light/dark 主题(基础主题)就是本文 §2 列的色值。

### 新主题怎么加(完整流程)

1. 新建 `apps/desktop/src/renderer/themes/builtin/<id>.ts`,导出 `Theme` 对象:
   ```ts
   export const myTheme: Theme = {
     id: 'my-theme',
     name: 'My Theme',
     type: 'light' | 'dark',
     colors: {
       // 只 override 跟基础主题不同的 token,空对象 {} 也合法(完全等于基础主题)
       'surface': '#xxx',
       'text-primary': '#xxx',
       // ... 大概率只需要 override 30-90 个 token
     },
   };
   ```
2. 注册到 `themes/registry.ts` 的 `builtinThemes`
3. 设置页 Appearance 的 Light/Dark Theme dropdown 自动 pick up

参考 `themes/builtin/` 下任一已存在的非默认主题作为模板。

### Token 命名约定

- **slot**:`{category}-{subkind}[-{variant}]`,如 `text-primary-emphasis` / `surface-chip-alt`。`-hsl` 后缀表示 HSL 三元组形式。
- **alias**:沿用历史 component-scoped 命名(`--cmd-palette-bg` / `--settings-back-text` 等),无前缀。
- **singleton**:语义清晰即可,通常带 component 前缀。

CSS variable 名一律 kebab-case。点号风格(如 VSCode 的 `sidebar.itemActive`)由于 CSS variable 不支持暂未采用。

### 实现新 UI 时的 token 选择规则

1. **先 grep `colors.ts`**:你的 UI 类型常对应已有 slot/alias(card bg = `--cmd-palette-bg` / `--surface-elevated`,等)
2. **slot 优先**:能用 slot 就别用 component-scoped alias(slot 跨主题表现更可控)
3. **HSL token 必须 wrap**:`hsl(var(--background))` 不能写成 `var(--background)`(后者会得到原始 HSL 字符串,不是合法 CSS color)
4. **找不到合适 token 时,不要硬塞**:跟用户讨论是否要新增 slot/singleton
5. **不接受** `bg-[#xxx] dark:bg-[#xxx]` 这种硬编码 pair——这是 P2 前的反模式,已经全量迁移过一次,新代码不允许引入

详见 CLAUDE.md 规则 #18。

## 11. Voice & Content（微文案规范）

> **状态:草案**,2026-06 引入(参考 Vercel Geist `design.md` 的 Voice & Content 一节)。本节规定**界面文案怎么写**,与 CLAUDE.md 规则 #18(i18n 体系)配套——#18 管"文案必须 4 语言对齐、走 token",本节管"每条文案本身的语气/措辞"。本节不新增任何 UI 字符串,只约束写法。

Cindy 的产品气质和视觉一致:**克制、直接、不自夸**。文案是工具的一部分,不是营销。

### 11.1 语言无关原则(zh-CN / en / ja / ko 全部适用)

- **动作 = 动词 + 宾语,不要裸动词**。按钮/菜单项说清"对什么做什么":`Deploy Project` / `删除会话` / `セッションを削除`,**禁止** `Confirm` / `OK` / `确定` / `提交` 这类无宾语的孤立动词(确认弹窗的主按钮尤其要带宾语,让用户脱离上下文也能看懂)。
- **错误信息 = 发生了什么 + 怎么办**。只报"出错了 / Failed"不合格;要给出下一步("连接超时,检查网络后重试")。对应规则 #13:IPC 错误码是给代码用的,面向用户的那句话必须人话 + 可操作。
- **进行中态 = 现在进行时 + 省略号**。`Deploying…` / `正在部署…` / `デプロイ中…`。我们 ChatView 的 Thinking 状态栏(`Spelunking…`,Thinking Orange)已是这个范式,新增加载/处理态沿用。
- **结果反馈点名对象、不说"成功"**。Toast 说"变了什么"而不是"操作成功了":`会话已删除` 而非 `删除成功`;`Project deleted` 而非 `Deleted successfully`。**禁止** "successfully / 成功了" 这类废话词。(Toast 的视觉规范见 §2,本条只管文案。)
- **空状态指向第一个动作**,别只画一句"暂无数据"——告诉用户现在能做什么("还没有会话,点 + 新建一个")。
- **不卑不亢,但分语言**:英文不写 "Please"(界面不是在求用户)。**中文的"请"是地道礼貌用法,不在此列**——"请输入…""请先授权""请选择文件"这类该保留,不要为了套规则把中文改得生硬。两种语言都不写营销级形容词("强大的 / 极致 / 全新")。

### 11.2 各语言的大小写与标点(语言相关,不可照搬)

- **English**:标签 / 按钮 / 标题 / Tab 用 **Title Case**(`Deploy Project`);正文 / 帮助文字 / Toast 用 **sentence case**(只首字母大写)。用弯引号 `" "` 和省略号字符 `…`,不用 `"` 和 `...`。
- **zh-CN**:**没有 Title Case 概念**,不要逐词首字母大写、不要给中文塞英文式标点;中英混排时英文术语保留原样(`部署 Project`)。句末 Toast / 标签不加句号。
- **ja / ko**:同样无 Title Case;遵循各自的助词/敬体习惯,术语译法没把握时先查证(对应规则 #18:ja/ko 不许硬凑)。
- **数字 / 单位**:四语言都用阿拉伯数字 + 半角,数字与单位间距按各语言习惯。

### 11.3 自查清单(改动文案时)

- [ ] 动作按钮带宾语,不是裸 `确定` / `OK`
- [ ] 错误文案给了"怎么办",不是只报错
- [ ] 没有 "successfully / 成功" 废话词
- [ ] 进行中态是"现在进行时 + …"
- [ ] 4 个 `common.json` 都补齐且符合本语言的大小写/标点(规则 #18)

## 12. Component Spec(结构化样板 — 待定)

> **状态:样板,待你 review。** 本节是把 §4 组件散文规格改写成 **Vercel `design.md` 那种「可机读 / 可执行」结构化键值**的试点,先做 Buttons / Inputs / Cards 三个。**确认采用后,就地替换 §4 的散文描述并删除本节**;不采用则整节删掉,§4 不受影响。
>
> 读法:`字段  →  token  →  Default Light / Default Dark 解析值`。token 名以 §10 表为准;`⚠` 标记"规范里有值但 §10 暂无对应 token / 字段在 §4 未定义"的缺口——这正是结构化格式相对散文的价值:把隐性缺口显性化。

```
button/primary  (Gray Pill — 主按钮)
  fill      --surface-chip        #e5e5e5 / #3c3c3a
  text      --text-primary        #262626 / #d4d4d4
  border    1px solid --surface-chip   (同 fill)
  radius    9999px (pill)
  padding   10px 24px
  height    ⚠ §4 未定义(§4 仅给 padding)

button/secondary  (White Pill — 次按钮)
  fill      --surface-elevated    #ffffff / #2c2c2a
  text      --text-primary        #262626 / #d4d4d4   (G1 已解决:原 #404040「Button Text Dark」是漂移)
  border    --border-default      #d7d7d4 / #3c3c3a   (G2 已解决:原 #d4d4d4「Border Light」是漂移)
  radius    9999px (pill)
  padding   10px 24px

button/cta  (Black Pill — 最高强调)
  fill      --accent-cta-bg-pure  #000000 / #ffffff
  text      --accent-pure-cta-fg  #ffffff / #000000
  radius    9999px (pill)
  padding   10px 24px

input/text
  fill        --surface-elevated  #ffffff / #2c2c2a
  text        --text-primary      #262626 / #d4d4d4
  border      --border-default    #d7d7d4 / #3c3c3a
  radius      9999px (pill)
  focus       --focus-ring        #3b82f6 @50%(双层带缝 ring 见外部讨论 ③,待定)
  placeholder --text-placeholder   #c4c4c4 / #525252   (G3 已解决:新增统一 slot,4 个输入面 alias 全部收口)

card/container
  fill      --surface-elevated    #ffffff / #2c2c2a   (页面级 flat 布局下改用 --surface,见 §2 layer rule)
  border    1px solid --border-default   #d7d7d4 / #3c3c3a   (需要分隔时才加)
  radius    12px (Tailwind rounded-xl,直接量) — 容器档圆角(三档之一,见 §5;8px 仅内层控件 textarea / 下拉行,pill 给交互件)
            ⚠ 不要用 §10 的 --radius:那是 shadcn 原语用的 0.5rem(8px),与本 12px 容器圆角是两回事
  shadow    none
  hover     --surface-hover       #e5e5e5 / #3c3c3a   (§4 原文是「likely」,此处给出可用 token)
```

## 13. Known Spec / Token Gaps（跟踪中）

> §12 结构化重写过程中暴露的设计系统欠债。本节**持久存在**(独立于 §12 是否被采用),每条解决后打勾并把结论并入 §2 / §4 / §10。下列"现状"均已 grep 源码核实(以源码为准),非臆测。涉及新增/改 token 的(G3 / G4)按规则 #16 须先与 owner 确认再动 `colors.ts`。

- [x] **G1 — 白底次按钮文字 `#404040`「Button Text Dark」是文档漂移,非真 token**(已解决 2026-06)
  现状:§2 / §4 称其"专用于白底按钮文字",但全仓库只有 `features/maker-experimental/MakerExperimentalView.tsx`(实验视图,裸 hardcode)出现 #404040,**无任何真实次按钮**用它做文字色;§10 也无对应 token。
  处理:§2 标废弃、§4 White Pill 文字改引 `--text-primary`(#262626)。未动 token,纯文档。

- [x] **G2 — 次按钮边框 `#d4d4d4`「Border Light」同为漂移**(已解决 2026-06)
  现状:§4 称白底按钮边框 `1px solid #d4d4d4`,但无真实组件这么用;#d4d4d4 的线上出现要么在实验视图(裸 hardcode),要么是**暗色主文字**(`--text-primary` dark = #d4d4d4,如 SchedulerPage CTA 注释),与"边框"无关。真边框 token 是 `--border-default`(#d7d7d4)。
  处理:§2 标废弃、§4 White Pill 边框改引 `--border-default`(#d7d7d4)。纯文档。

- [x] **G3 — placeholder token 碎片化 + 取值自相矛盾(真欠债)**(已解决 2026-06)
  现状:4 个 per-surface alias 无统一 slot,且取值打架——`--settings-input-placeholder` = #c4c4c4(§4 认证的"淡到读着像空"),但 `--chat-input-placeholder` = `var(--text-tertiary)` = **#a3a3a3(Silver)**,而 §4 白纸黑字说 Silver **太显眼、读着像已填、不可做 placeholder**。即聊天输入框 placeholder 实际违反了我们自己的 §4 规范。
  处理:`colors.ts` 新增语义 slot `--text-placeholder`(#c4c4c4 / #525252),4 个 alias(chat/ask/settings/plan-action-fb)default 收口为 `var(--text-placeholder)`;7 套非默认主题原 `settings-input-placeholder` override 就地改名为 `text-placeholder`(沿用原常量,避免回退,符合规则 #16 对每套主题的评估)。默认主题下 chat placeholder 由 #a3a3a3 修正为 #c4c4c4。2 套亮色主题(atom-one-light / solarized-light)的 `text-placeholder` 进一步从 tertiary 改用各自 **disabled 档**(更淡)——亮色背景下 tertiary≈2.6:1 命中 §4 禁用 Silver 的对比度,placeholder 须更淡才读着像空(2026-06 review 反馈)。**本地/复制主题兼容**:slot 引入前创建的本地主题快照只冻结了旧 per-surface placeholder key、无 `text-placeholder`,加载期 `mapWireTheme` 经 `local-themes-normalize.ts` 归一化——缺 `text-placeholder` 时从旧 `settings-input-placeholder`(或任一 per-surface 值)播种并丢弃 4 个旧 per-surface override,使四个输入面统一走新 slot(不改写盘上 JSON、幂等;2026-06 review 反馈)。

- [x] **G4 — `--radius`(8px)与容器圆角同名不同义(已解决 2026-06)**
  现状:`--radius` 实为 `0.5rem`(8px,shadcn 原语用);容器 12px 圆角实际靠 Tailwind `rounded-xl` 直接量实现。
  处理:**圆角体系正式从"二元"改为"三档"**(8px 内层控件 / 12px 容器 / 9999px pill,见 §5 + §7 + §1)。8px 这一档窄范围限定多行输入框、下拉 / 菜单选中行、段内小单元,实现为 `rounded-lg`;shadcn `--radius`(8px)与这个内层档数值相同但语义独立(原语专用),容器仍走 `rounded-xl`(12px)。**本次纯文档,未动 token**。是否进一步 token 化为 `--radius-inner`(8px)/ `--radius-container`(12px)/ `--radius-pill`(9999px),收益偏低、**暂缓**,要做走规则 #16。

> **旁注(不在本次范围,仅记录)**:`MakerExperimentalView.tsx` 通篇裸 hardcode hex(#404040 / #d4d4d4 / #262626 / #333),违反规则 #16。因是 experimental 视图、且非本次任务,**不在此清理**,仅备忘。

## 14. Interaction Conventions(交互约定)

> 2026-06 引入。DESIGN.md 此前只规范"长什么样"(色 / 圆角 / 字体 / 间距),不规范"怎么交互"——文本能不能选中、弹窗开了焦点落哪、回车是发送还是换行,这些反复要靠人逐个指出。本节把这些**非视觉的交互行为**钉成全局约定,与 §11(文案语气)互补。能用代码统一保证的就别靠人记(对应 CLAUDE.md 规则 #9)。

### 14.1 文本可选性(user-select)

- **正文内容可选**:消息气泡正文、代码块、文档预览、用户会"读句子 / 想复制"的文字 —— 默认可选,不要动。
- **Chrome 不可选**:按钮、菜单项、标签 / chip、状态条、徽标、工具条、侧栏项这类**界面骨架文字**一律 `select-none`。它们是控件不是内容,能被选中只会碍事(典型:goal 状态 chip 的文字)。
- 判断标准:用户会想"复制这段话"吗?会 → 可选;不会(它只是个控件)→ `select-none`。

### 14.2 焦点管理(focus)

- 弹窗 / 抽屉 / popover 打开时,焦点落到**首要输入框**(没有输入框则落主按钮),**不要**默认停在"取消"上。Radix 默认会聚焦第一个可聚焦元素 / Cancel —— 用 `onOpenAutoFocus`(`preventDefault()` + 手动 `focus()`)或 ConfirmDialog 的 `autoFocusConfirm` 覆盖。
- 关闭后焦点归还触发它的元素(Radix 默认行为,别破坏)。

### 14.3 键盘与输入法(发送型文本框)

适用于"敲完就发"的提交型文本框:聊天 composer、目标输入、ask 输入等。**不含**普通设置项里的单行编辑框 —— 那种 Enter 不应触发提交。

- **Enter = 提交**,**Shift+Enter = 换行**。
- **输入法组字期间的 Enter 不触发提交** —— 判 `event.nativeEvent.isComposing`(中 / 日 / 韩用户选字按的回车不能被当成发送)。
- 这套逻辑用代码统一,不要每个框各写一遍导致行为漂移(对应规则 #9)。

### 14.4 动效与过渡(motion)

- 允许**功能性状态过渡**:hover / 选中 / 展开等的颜色、背景、透明度变化,时长 **≤150ms**,目的是让状态变化不突兀(全 app 的 `transition-colors` 即此类,合规)。
- **禁止装饰性 / 大幅位移动画**:无意义的位移、缩放、弹跳、视差、循环动画。交互仍应"快、直接"(承接 §1 / §7 的克制气质 —— 把原先"零过渡"修正为"零装饰性动效",功能性过渡是允许的)。


## 15. CINDY 皮肤族(品牌化可选 family)

> 本节为 CINDY 皮肤族的规范记录,**不改写 §1-7 默认皮肤规范**。值的权威来源:
> `skin-docs/10-specs/` 桌面端体系、`skin-docs/30-mobile/2026-07-18-m0-color-mapping.md`
> 移动端勘误版,以及 2026-07-18 双端验收后的用户最终口头定稿。实现时零自由裁量。

### 15.1 色板(Figma 文本节点提取)

| 语义 | Light | Dark |
|---|---|---|
| 品牌红 | `#DF0C27` | `#DF0C27` |
| 品牌深红(hover/pressed) | `#A61629` | `#A61629` |
| 背景 | `#EDEDED` | `#2A2828` |
| 卡片/输入框 | `#F8F8F8` | `#312F2F` |
| 边框 | `#DCDFE3` | `#434343` |
| 二级信息 | `#9A9DA3` | `#6F6F6F` |
| 正文 | `#3C3F43` | `#D4D4D4` |
| 纯白 | `#FFFFFF` | `#FFFFFF` |

### 15.2 三份红 exact map(品牌红边界)

- **BRAND_RED_EXPECTED_BY_ID**(必须等于品牌红/深红):`accent-cta-bg`/`accent-cta-bg-pure`/`accent-emphasis`/`confirm-btn-primary-bg`/`migration-bar-fill`/`perm-allow-btn-bg`/`update-btn-border`/`update-btn-text`(均 `#DF0C27`);`primary`/`sidebar-item-active`(HSL `352.3 89.8% 46.1%`,RGB 归一等价品牌红)。
- **BRAND_RED_ALLOWED_IDS**(允许含红全集 = EXPECTED ∪ 派生):上述 + `accent-soft`/`accent-hover`/`drop-overlay-bg`/`confirm-btn-primary-hover`/`settings-btn-primary-bg`/`settings-btn-primary-border`/`settings-btn-primary-hover-bg`。
- **CTA_FOREGROUND_WHITE_IDS**(红底白前景):`accent-pure-cta-fg`/`confirm-btn-primary-text`/`perm-allow-btn-text`/`primary-foreground`/`settings-btn-primary-text`。

单向禁止:`ALLOWED` 之外任何 token 出现 `#DF0C27`/`#A61629` = 测试红。

### 15.3 插值表(sRGB 每通道 `round(A+(B-A)*t)`)

详见决策表 §2。Light/Dark 各 20/40/65/75% 档已冻结精确值进单测(`#EFEFEF/#F1F1F1/#F4F4F4/#F5F5F5`、`#2B2929/#2D2B2B/#2F2D2D/#2F2D2D`)。

### 15.4 豁免(不纳入 CINDY 覆盖,跨主题统一)

- 语义色:`warning-accent` `#EA6B17`(定稿 2026-07-17,取代 `#FF6600`)/ `annotation-accent` `#FF3B30`(图片标注烧录笔迹色,语义豁免,不改)/ `status-bar-accent`(alias warning orange,自动跟随)。
- 状态四色(设计定稿 2026-07-17,取代冻结红线;全局 light/dark 同值,9 主题无 override 自动跟随):running `#EA6B17` / awaiting `#19D2C1` / error(状态族)`#D91F37` / done `#2AAE5B`;warning 前景 `warning-fg` `#F3A115`(与 Toast amber `#F59E0B` 解耦,Toast 维持 B 组现状)。
- `focus-ring` `#417CDD`(蓝,E5D 定稿 2026-07-17 取代 #3b82f6,不染红);diff 红绿;modal scrim/阴影;`overlay-lightbox`;Toast 四色定稿(豁免解除)。
- `destructive`/`search-match-bg` 语义色不纳入 HSL_FORMAT_IDS 覆盖。
- **hljs 语法高亮色**(light=highlight.js/styles/github.css;dark=globals.css `.dark .hljs-*` mirror github-dark):hljs 主题色为 default 代码块底设计,CINDY 代码块底(surface-elevated #F8F8F8/#312F2F)接近 default(#ffffff/#2c2c2a),边缘不达标(light -keyword 4.31/-built_in 3.29/-name 4.36;dark -punctuation 2.47/-tag 2.99/-section 2.87)是 hljs 既有折损(用 design surface 而非 github 默认 #ffffff/#0d1117),非 CINDY 引入——default 同源也不达标。CINDY 不补 [data-theme] 整改(与 default 同源,补整改值需重新过用户关卡);落档见 cindyCodeBlockContrast.test.ts(≥2 基线 + text ≥4.5 守卫)。
**双门槛口径(D 裁决 2026-07-17)**:hljs 语法高亮色属辅助性视觉编码,对齐 selection/边界 3:1 口径——语法色 ≥3:1、正文文本 ≥4.5:1。CINDY 代码块底(surface-elevated)接近 default,hljs 主题色为 github 默认底(#ffffff/#0d1117)设计,固有折损非 CINDY 引入(default 同源)。
- light:语法色全 ≥3(4.31/3.29/4.36),<4.5 但 ≥3 门槛通过,**不整改**,逐项落豁免档(default 同源折损);
- dark:`.hljs-section` #1f6feb × #312F2F = 2.87 <3,补 `[data-theme="cindy-dark"] .hljs-section` 提亮 `#2573ec`(保持蓝 H212 S84% L52→53.5%,× #312F2F=3.00 ≥3);`.hljs-punctuation`/`.hljs-tag` github-dark "purposely ignored" 无显式色,dark 继承 .dark .hljs text `#c9d1d9`(× #312F2F=8.62 ≥3 达标),补 `[data-theme="cindy-dark"]` 显式覆盖 `#c9d1d9` 防御性(D 裁决三项覆盖,值同 text 不降对比度)。
- model-budget 光谱条 / GhostTool shimmer:显式豁免(中性 shimmer,跨主题统一)。

### 15.5 U2 显式例外记录(二级信息色忠于 Figma 原值)

- token:`text-secondary` / `text-secondary-cross`(light `#9A9DA3` / dark `#6F6F6F`)。
- 实测对比度(WCAG):× surface `2.32/2.92:1`、× elevated `2.56/2.65:1`、× chip `2.41/2.72:1`,均低于普通文本 AA `4.5:1`。
- 裁决:用户 **U2(2026-07-16 拍板)=(b) 忠于 Figma 原值**,接受可读性折损,作为记录在案的显式偏离。
- 约束:**不得擅自调深**(如 `#686B72` 已证伪且仅存档备查),改值须重新过用户关卡。
- 反向冻结单测:`cindyThemes.test.ts` 第 ⑦ 组断言该值必须恰等 Figma 原值,注入 `#686B72` 必须变红。

### 15.6 HSL 格式合约

42 个 `HSL_FORMAT_IDS` 必须 HSL 三元组(`h s% l%`,`h∈[0,360)`、灰色 `hue=0`、1 位小数);其余 token 走 hex/rgba。round-trip HSL→RGB 通道误差 ≤1。HSL_FORMAT_IDS 之外不得误填 HSL 三元组。

### 15.7 logo 资产(品牌 wordmark)

cindy-light 用黑字版(`cindy-logo-light.png`)、cindy-dark 用白字版(`cindy-logo-dark.png`),经 `theme.logo` 机制注入(`logoScale=1` 对齐默认 logo 视觉大小;NewMakerDraftRoute/欢迎页按 `theme.logo ?? defaultLogoForTheme` 消费)。

> logo 资产红 `#F70121` 是官方品牌资产固有色(WORD MARK frame 红箭头符号),与 UI 品牌红 `#DF0C27` **并存、不同值**——logo 是图片资产不进 token 体系,保持原色不改色。后人勿误改为 `#DF0C27`。
### 15.8 status-badge-fg(§7 必炸点,用户确认 2026-07-17)

橙徽章(bg `status-bar-accent` `#EA6B17`,设计定稿 2026-07-17 取代 `#FF6600`)此前借用 `accent-pure-cta-fg`(白字)→ `#FFFFFF`×`#FF6600`=2.94:1 不达标(历史值,旧橙 #FF6600)。拆独立 `status-badge-fg`:
- **default 镜像 `accent-pure-cta-fg`**(light 白 / dark 黑),既有 9 主题行为零变化;
- **CINDY 两模式 override `#1F1F1F`**(深色近黑),× `status-bar-accent` `#EA6B17` = **5.19:1 ≥4.5**(用户亲批方案 #1F1F1F;设计定稿 2026-07-17 新橙 #EA6B17 实算 5.19:1,取代旧 #FF6600×5.61:1;不达 4.5 则加深 #000000);
- 覆盖数组 115→116(`cindyDecisionData` 注明 D2 期新增,源自 §7 必炸点方案);
- 消费点(`ContactsListPane:150`)从 `accent-pure-cta-fg` 切到 `status-badge-fg`;红 CTA 上的 `surface-on-card` 消费者(`RolePillDropdown:543/544`、`SkillhubDetailView:504`)迁到 `accent-pure-cta-fg`(白),`surface-on-card` 保留中性反相(Fast toggle thumb)。

### 15.9 markdown-editor.css CINDY 覆盖(B 裁决 2026-07-17)

`[data-theme="cindy-light/dark"] .mdxeditor-host` 覆盖 MDXEditor 色阶用 CINDY token(var 引用,light/dark 自动解析)。锚点按文件顶部 Token map 注释,中间档按序:①语义对上决策表插值 token 的复用;②对不上的 sRGB `round(A+(B-A)*t)` 从相邻锚点算(本映射中间档均复用 token,无 sRGB 插值)。文本档实算对比度 ≥4.5:1。

| --blue-* | CINDY token | 规则 |
|---|---|---|
| --blue-1 | `var(--surface)` | 锚点(Surface) |
| --blue-2 | `var(--surface-hover-soft)` | ①复用插值 token |
| --blue-3 | `var(--surface-elevated)` | 锚点(Card) |
| --blue-4 | `var(--surface-hover)` | ①复用 |
| --blue-5 | `var(--surface-chip)` | ①复用(Chip) |
| --blue-6 | `var(--border-default)` | 锚点(Board) |
| --blue-7 | `var(--border-default)` | ①复用(同 6) |
| --blue-8 | `var(--text-tertiary)` | ①复用(中间灰) |
| --blue-9 | `var(--text-primary)` | 锚点(primary) |
| --blue-10 | `var(--text-primary-emphasis)` | ①复用(深字) |
| --blue-11 | `var(--text-primary)` | ①复用(文字档,× surface-elevated ≥4.5:light #3C3F43×#F8F8F8=9.97,dark #D4D4D4×#312F2F=8.98) |
| --blue-12 | `var(--text-primary-emphasis)` | ①复用(文字档) |

`--slate-*` 同理对应中性档。`--base*`/`--accent*` 按 Token map。`:root`/`.dark` 原两套一字不动。

### 15.10 E1D 红色体系重构(用户批准 2026-07-17)

常规主操作不再用品牌红,改反相中性(light 底 `#3C3F43`/字 `#FCFCFC`,dark 底 `#EEEEEE`/字 `#252222`;WCAG 10.32/13.60:1)。红色仅限语义例外:
- **A 类(保留红)**:`brand-login-bg`/`brand-login-error-border`/`brand-login-error-text`(品牌海报/错误);
- **C 类(保留红)**:`migration-bar-fill`(进度)、`sidebar-item-active`(light `#DF0C27`/dark `#A61629` 选中);~~`drop-overlay-bg` 红10%~~ 已于 2026-07-19 撤红(用户实机否决:整窗红罩语义似警报,回落 default 中性灰遮罩);
- **语义色**:`destructive`/delete、`error-*`、warning、diff 红、status 点;
- **B 类(改中性 11 项)**:`accent-cta-bg`/`-pure`/`-emphasis`/`-soft`/`-hover`、`update-btn-border`/`-text`、`confirm-btn-primary`、`perm-allow-btn`、`primary`、`settings-btn-primary`(alias)、`accent-pure-cta-fg`/`settings-btn-primary-text`(中性字);
- **C 类裁决**:confirm(普通中性,danger 另设)、perm-allow(中性,警示橙 chip)、primary(中性)、sidebar-item-active(light 红胶囊/dark 深红)、migration-bar-fill(保留红)、drop-overlay(原保留红10%,2026-07-19 撤红改中性)、brand-login-cta(不动);
- **中性按钮四态**:light 底`#3C3F43`/字`#FCFCFC`、hover`#2E3237`、pressed`#25282C`;dark 底`#EEEEEE`/字`#252222`、hover`#E2E2E2`、pressed`#D4D4D4`。
- **send-btn 族纳入值表(E1D 扩,lead 裁决 2026-07-17)**:`send-btn-bg`(default alias `--accent-cta-bg`)/`-icon`/`-hover-bg`/`-pressed-bg`/`-disabled-bg`/`-disabled-icon` CINDY override 全族走上述四态反相中性 + disabled 灰 `#444242`/`#585555`(R4 D1 实证);hover/pressed 为 E1D 新增 token(default 同 bg,默认皮肤维持 opacity-85 hover,膘叔 E3 组件层消费 var() 即全局生效);全族入 cindyDecisionData REQUIRED_IDS + CINDY_EXPECTED,③ 断言守。
- **侧栏颜色层级整改(E1D 扩,用户并排指错 2026-07-17,lead 钉死 light/dark 同套)**:
  - 正文(会话标题)= `text-foreground`(=`text-primary` light `#3C3F43`/dark `#D4D4D4`,不动);
  - 二级暗灰(行首图标普通态/时间戳/meta/分组标签)= light `#9A9DA3`/dark `#6F6F6F`(与 `text-secondary` 同值);CINDY override `sidebar-muted`/`sidebar-action-icon`(HSL `220.0 4.7% 62.2%`/`0 0% 43.5%`)+ 新增 `cmd-palette-item-meta` CINDY override(hex);
  - 选中胶囊 = `sidebar-item-active`(light `#DF0C27`/dark `#A61629`,E1D 第 4 项裁决)反白前景 = 新增 `sidebar-item-active-foreground` token(light `#FCFCFC`/dark `#D4D4D4`,× 红底 5.33/4.91 ≥4.5);SessionItem/SessionCard isActive 容器+title+time+RemoteProjectIcon 条件切反白;
  - 强调行(running)行首箭头 = 品牌红系 `sidebar-item-active`(light `#DF0C27`/dark `#A61629`,D4-1 Figma 三态实证),VendorIcon running 从 `status-bar-accent`(橙)切 `hsl(var(--sidebar-item-active))`;**与 E5D 状态点新橙 `#EA6B17` 解耦——状态点归橙,行首强调箭头归红**。
  - 断言:③ CINDY_EXPECTED 守 4 token 值;⑦ 新增层级断言(二级暗灰 contrast 明显弱于正文 + 选中胶囊前景×红底 ≥4.5)。
- **backlog(R2 §4.3 五点差异,lead 裁决 2026-07-17 本轮不做,入 backlog)**:Project_List 三态拆分(active-task-pill/project-card/flat-list-row 不共用 `sidebar-item-active`);项目 header/list card 选中应中性底(#312F2F/#F6F6F6 非 #DF0C27 大红);去 Project_List 选中组 `focus-ring-soft` 蓝 ring,改 card stroke #DCDFE3/#434343;小箭头 #A61629 强调(非整行红底)。详见 `2026-07-17-r2-ui-specs.md` §4.3。本轮收敛不扩战线,后续另开。

三份新 map(`NEUTRAL_PRIMARY_EXPECTED_BY_ID`/`FOREGROUND` + `RED_EXCEPTION_ALLOWED_IDS`)替代旧 `BRAND_RED_*`。D2T ⑤/⑦/⑧ 改用新 map(中性 exact + 红例外白名单 + 中性对比度 + 可证伪)。

### 15.11 caret-accent 光标(用户二次改稿 2026-07-18 定稿:蓝,跨端规则)

> 决策史:07-18 日间"光标品牌红 #DF0C27"→ 07-18 晚**红 caret 定稿已被用户覆盖为蓝 `#417CDD`,双端一致**。以下为现行有效版本,历史文档中"caret 品牌红"表述一律作废。

- 全部可编辑输入面的光标(caret)统一消费 `--caret-accent` token——globals.css 已全局接管(原生 `caret-color` + ProseMirror 伪光标),**组件内不许另设 caret-color**。
- 取值:default 主题 = `var(--accent-cta-bg)`(中性反相,随主题走);**CINDY 两模式 override `#417CDD`**(与 focus ring 同值的信息蓝;已从 `RED_EXCEPTION_ALLOWED_IDS` 红例外白名单移除,`cindyDecisionData.ts` 断言锁值)。
- **易踩点**:①光标不再是红——红色白名单里没有光标,不要把 caret 接任何红 token;②虽然值与 `--focus-ring` 相同,**不要**把 caret 直接接 `--focus-ring`——语义不同,光标唯一合法出口仍是 `caret-accent`(便于日后独立调整)。
- **跨端对齐**:移动端(`apps/mobile` `src/theme/tokens.ts` 的 `inputCaret`)同值 `#417CDD` 双模式,RN 侧经 TextInput `cursorColor`/`selectionColor` 消费,`themeTokens.test.ts` 锁值。

### 15.12 毛玻璃(vibrancy)体系(用户定稿 2026-07-18,macOS)

- **唯一半透面 token**:`surface-translucent-sidebar`——CINDY light `rgba(255, 255, 255, 0.85)` / dark `rgba(18, 15, 15, 0.75)`(default 主题下 = `var(--surface)` 不透明,非 CINDY 主题零影响)。左侧栏(`aside.bg-sidebar`)与 splash 根容器共用同一 token(用户裁决"一劳永逸");后续新增半透明表面**默认复用此 token**,不另造 rgba 值。
- **透壁纸三重管线,缺一即死黑**(2026-07-18 实机 A/B 实证,详证据见换肤工程 sidebar-glass 补编终稿追记):
  1. **窗口创建期**即设 `backgroundColor: '#00000000'` + vibrancy(`bootstrap-electron.ts` / `vibrancyConfig.ts`);运行时再 setBackgroundColor 改 alpha 不可靠。
  2. CINDY 主题下**根容器让路**:globals.css 把 `.h-screen.bg-content-area`(及 splash 在场垫层)置 transparent,否则整窗不透明垫底挡死。
  3. **禁止 CSS `backdrop-filter`**——它会把透明窗背衬渲染成黑箱;壁纸模糊完全由原生 vibrancy 材质负责,CSS 层只铺半透底色。
- 材质经 `XDT_VIBRANCY_MATERIAL` 环境旋钮选择(缺省 sidebar;用户实测定稿 **hud**)。Windows 无 vibrancy 等价物,降级为不透明 `--surface`(backlog)。
- 半透面上**不叠渐变覆盖层**——浅色红渐变层 2026-07-18 经用户确认设计稿无此元素,已整层砍除;splash 的渐变辉光层同样未实现(backlog 待用户表态)。
- `surface-translucent-sidebar` 的 alpha 是主题冻结区**唯一开放的观感旋钮**,调整必须三处同步(`cindy-light.ts` / `cindy-dark.ts` / `cindyDecisionData.ts`)且 themes 套件跑绿。

### 15.13 CINDY 双端换肤定稿规则(2026-07-18)

本节是后续桌面端 / 手机端 UI 更新的执行规则。若本节与上方历史小节有冲突,以后续用户验收定稿为准;不要按早期红 CTA / 红 caret 口径回退。出处见 `skin-docs/10-specs/`、`skin-docs/30-mobile/2026-07-18-m0-color-mapping.md`、`skin-docs/30-mobile/2026-07-18-m3-chat-tasksheet-impl-plan.md`。

#### 红色边界

- 品牌红 `#DF0C27` 只用于品牌展示 / splash、破坏性操作、运行 / 思考状态强调、列表 active glyph。列表 active glyph 在 dark 使用 `#A61629`。
- 普通 CTA、FAB、发送钮、确认类主操作一律使用中性反相:light 底 `#3C3F43` / 字 `#FCFCFC`,dark 底 `#EEEEEE` / 字 `#252222`。禁止把这些操作染成品牌红。
- 红色白名单不包含输入光标、focus ring、普通按钮、普通选中态背景。新增红色消费必须先写明语义并进入对应 token / 测试白名单;不能在组件中硬编码。

#### 光标与焦点

- 所有输入光标 `cursorColor` / `selectionColor` 统一为蓝 `#417CDD`,等于 `permAutoAccent` / Mac `caret-accent`;light / dark 同值。
- focus ring、Auto Approval、信息蓝同属 `#417CDD` 体系。Figma 旧蓝 `#426BF2` 不采用。
- 禁止红色系光标。备注:2026-07-18 早前红 caret 口径已于同日晚被用户最终定稿覆盖。

#### 双端颜色同构

- 手机端颜色语义必须与桌面端 token 决策表同构:主背景、正文、二级信息、边框等基础层级按 CINDY desktop 语义直映,不要为移动端另造一套相同含义的颜色。
- 移动端专用 token 只承载移动端特有层级或几何语境:

| Mobile token | Light | Dark | 用途 |
|---|---|---|---|
| `surfaceListRow` | `#F6F6F6` | `#312F2F` | list 项目行 / 任务行 |
| `surfaceListExpanded` | `#EAEAEA` | `#2A2828` | list 展开块 |
| `activeGlyph` | `#DF0C27` | `#A61629` | list 行首 active glyph |
| `chatCodeSurface` | `#F8F8F8` | `#353333` | chat / task code card |
| `chatCodeBorder` | `#DCDFE3` | `#3C3C3C` | chat / task code card 边框 |
| `inputCaret` | `#417CDD` | `#417CDD` | 所有输入光标 |
| `sheetSurface` | `rgba(248,248,248,0.95)` | `rgba(59,59,59,0.95)` | bottom sheet root |
| `sheetActionSurface` | `#F6F6F6` | `rgba(59,59,59,0.5)` | sheet action group / row |
| `sheetActionBorder` | `#DCDFE3` | `#505050` | sheet action group / row 边框 |
| `sheetActionText` | `#3C3F43` | `#C1C1C1` | sheet action row label |
| `sheetGrabber` | `#DCDFE3` | `#6F6F6F` | sheet / composer grabber |

#### 图标规范

- 会话 / 品牌 glyph 统一使用 `BrandArrow`,Mac 与移动端同源资产;不要再各端各画一套箭头。
- 模型选择按 model brand 出图。Mac 已替换过的品牌图标,移动端直接复用同源资产;其余使用现有图标库(lucide)中语义等价的图形。
- 发送语义统一使用填充纸飞机 `Send`,颜色跟随中性反相 CTA token;不要用红色发送按钮或红色发送图标表达普通发送。

#### 排版与布局要点

- List 页采用卡片化密度:20pt gutter、60pt 行高、12pt 圆角、55pt FAB。不要回退到旧的松散列表或红色普通 CTA。
- Chat 顶栏使用毛玻璃 / 半透明玻璃体系:优先复用 `BlurBackdrop` 与专用 chat header token;未接线 blur 的位置使用半透明实色 token + hairline,不要新增未经验证的 blur 接入点。
- Sheet 系统一致使用 sheet token。共享 `SheetSurface` 等组件改新样式时默认走 variant 隔离,只让设计稿覆盖到的 tasksheet / `SessionActionSheet` / `SessionMenuSheet` 使用新样式;ContextSheet、ModelPicker、info sheet 等未覆盖页面不自动跟随。
- 展开块内部使用 hairline 分隔:非末行有线,末行无线;边框颜色走对应 token,不要写死。

#### 流程门禁

- 新增 / 修改颜色必须走 token,桌面端走 ColorRegistry / CSS variable,移动端走 `ThemeColors` / `useTheme`;组件里禁止硬编码 hex / rgba。
- `hardcoded-color-audit` 必须全绿才允许合入。若因资产固有色或平台语义确需例外,必须登记白名单并说明原因。
- 设计稿与既有 token 冲突时,先在规格或 PR 说明中列出"待拍板"并请求裁决;不得自行定案或用相近色偷换。
- 共享组件样式改动默认用 variant / prop 隔离影响面。设计稿没有覆盖的页面、状态、平台,默认保持现状。
