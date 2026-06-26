# Yumlog — "Hearth" Brand Guide

A branding uplift for **Tim & Zoe's Yumlog**. Same warm terracotta-and-sage soul,
pushed toward an **editorial cookbook** feel: a real display serif, deepened earthy
colour, paper-warm surfaces, and considered detailing. No photography — type, colour,
and whitespace carry the personality.

This document is the source of truth for visual design. Implement it by editing the
existing files; **keep all current functionality and markup structure** — styling and
branding only, not a rewrite.

---

## 0. Stack context (don't fight it)

- Astro 6 + Tailwind CSS 4 + Supabase. Tailwind tokens are defined in
  `src/styles/global.css` inside `@theme { … }`.
- **Most of the uplift is a token swap.** Because components already use semantic
  utilities (`bg-primary`, `text-on-surface`, `bg-surface-low`, `rounded-2xl`, …),
  changing the values in `@theme` re-skins the whole app for free. Do that first,
  then apply the component-level refinements in §4.
- Keep the existing CSS variable **names**. Only change values and add the few new
  tokens noted below.

---

## 1. Typography

Two families. A characterful display serif for anything brand-facing (wordmark,
headings, recipe titles, eyebrow accents); a warm, legible grotesk for body and UI.

| Role | Family | Weights | Notes |
| --- | --- | --- | --- |
| Display / headings | **Newsreader** | 400, 500, 600, 700 + **italic** | Editorial serif. Use the italic for emphasis and "accent" words. |
| Body / UI | **Hanken Grotesk** | 400, 500, 600, 700 | Friendly humanist grotesk; tabular-nums for amounts. |

### Loading the fonts
Prefer self-hosting via Fontsource (works offline, no layout shift):

```bash
npm i @fontsource-variable/newsreader @fontsource-variable/hanken-grotesk
```

```ts
// src/layouts/Layout.astro — in the frontmatter or a shared import
import '@fontsource-variable/newsreader';
import '@fontsource-variable/newsreader/wght-italic.css';
import '@fontsource-variable/hanken-grotesk';
```

(Or, if you'd rather not self-host, drop the equivalent Google Fonts `<link>` in
`<head>`.)

### Wire into `@theme`
```css
--font-serif: 'Newsreader Variable', 'Newsreader', Georgia, serif;
--font-sans:  'Hanken Grotesk Variable', 'Hanken Grotesk', system-ui, -apple-system, sans-serif;
```

### Type rules
- Headings & recipe titles: `font-serif`, weight **600**, `letter-spacing:-0.01em`
  (tighten more on the big recipe title: `-0.015em`), `line-height` ~1.05–1.1.
- **Italic accents.** The hero's second line, "Tip" labels, and small flavour text
  use Newsreader *italic* in `text-primary` or `text-on-surface-muted`. This is the
  signature move — use it sparingly and it reads as "cookbook", overuse it and it
  reads as "wedding invite".
- **Eyebrows.** Small section/kicker labels: `font-sans`, 11px, weight 700,
  `uppercase`, `letter-spacing:0.14–0.16em`, in `text-primary` or `text-secondary`.
- Body copy: `font-sans`, 14–15px, `line-height:1.6`.
- Numbers (amounts, quantities, times): add `tabular-nums`.

---

## 2. Colour — deepened & warmed

Drop-in replacements for the existing `@theme` block. The hues are the same family,
just richer and earthier; surfaces shift to a warmer "paper" cream.

```css
@theme {
  /* Clay — Primary (deepened terracotta) */
  --color-primary:               #A8472B;
  --color-primary-container:     #F4DAC8;
  --color-on-primary:            #FFF1E6;   /* warm cream, not pure white */
  --color-on-primary-container:  #4A1606;

  /* Sage — Secondary (deeper, more olive) */
  --color-secondary:             #566B4E;
  --color-secondary-container:   #DCE5CF;
  --color-on-secondary:          #FFF1E6;
  --color-on-secondary-container:#27341F;

  /* Ochre — NEW accent (use sparingly: wordmark dot, tiny highlights) */
  --color-accent:                #C58A2E;
  --color-accent-container:      #F6E6CC;
  --color-on-accent:             #3A2606;

  /* Surface — warm paper */
  --color-surface:               #FBF4EA;
  --color-surface-low:           #F6ECE0;
  --color-surface-container:     #F0E4D5;
  --color-surface-high:          #E9DACA;

  /* Text */
  --color-on-surface:            #2C1D14;   /* warm near-black */
  --color-on-surface-muted:      #6E5C4F;

  /* Outline */
  --color-outline:               #A8957F;
  --color-outline-soft:          #EBDDCC;
}
```

Notes:
- `--color-on-primary` is a **warm cream (#FFF1E6)**, not `#FFFFFF`. This keeps text
  on terracotta from feeling cold. Same for on-secondary.
- The **ochre accent is a seasoning, not a main**. Use it for the wordmark dot, a
  rare highlight, focus rings — never large fills. Don't introduce a fourth hue.
- Keep saturation restrained on the off-whites; the paper tones above are intentional.

### Elevation & radius (add to `@theme`)
Tailwind 4 reads `--shadow-*` and `--radius-*` from `@theme`. Add a soft, warm card
shadow and standard radii so cards feel lifted but gentle:

```css
--shadow-card: 0 1px 2px rgba(60,40,20,.05), 0 18px 40px -28px rgba(60,40,20,.28);
--shadow-soft: 0 1px 2px rgba(60,40,20,.04);
```

Use `shadow-card` on primary surfaces (hero, recipe cards, login card), `shadow-soft`
or none on nested list cards. Radii: cards `rounded-2xl` (16px) to `rounded-[20px]`,
chips/pills `rounded-full`, inputs `rounded-xl`/`rounded-[13px]`.

---

## 3. The wordmark

A serif **"Yumlog"** preceded by a rounded clay medallion holding a cream serif "Y",
with a small ochre dot as a full stop. Replace the current text-only logo in
`src/layouts/Layout.astro`.

```astro
<a href="/" class="flex items-center gap-2.5 shrink-0 group" aria-label="Yumlog home">
  <span
    class="grid place-items-center w-8 h-8 rounded-[10px] bg-primary text-on-primary
           font-serif font-semibold text-xl leading-none shadow-[inset_0_-2px_4px_rgba(0,0,0,.12)]"
  >Y</span>
  <span class="font-serif font-semibold text-2xl tracking-tight text-on-surface leading-none">
    Yumlog<span class="text-accent">.</span>
  </span>
</a>
```

- The inset shadow on the medallion gives it a subtle "pressed clay" depth — keep it.
- Login / empty states can use a larger medallion (48px, `text-3xl`).
- Favicon: the existing flame `favicon.svg` is perfect for "Hearth" — leave it, or
  recolour the path fill to `#A8472B` for the light-scheme version.

---

## 4. Components & screens

General card recipe used everywhere:
> paper (`bg-surface` / `#FBF4EA`), `border border-outline-soft`, `rounded-2xl`,
> `shadow-card`. Nest plain list cards (`bg-surface` border, no shadow) inside.

### 4.1 Top bar — `Layout.astro`
- Background `bg-surface-low`, bottom `border-outline-soft`.
- Wordmark from §3.
- Nav items are pills: active = `bg-primary-container text-on-primary-container`,
  inactive = `text-on-surface-muted hover:bg-surface-container`, `rounded-full`,
  13px, weight 600. (Structure already exists — just confirm the active style.)

### 4.2 Homepage — `index.astro`
- **Hero card.** Wrap the hero in the paper card recipe (`shadow-card`). Inside:
  - Eyebrow "Tim & Zoe's kitchen" → `text-primary`, uppercase, tracked (§1).
  - Headline in `font-serif` 600, ~34px. **Second line italic in `text-primary`**:
    `Everything we cook,` / *`all in one place.`*
  - Replace the paper-plane SVG with a quiet serif count, e.g. *"52 recipes"* in
    italic muted serif, top-right. (The send icon doesn't fit cooking — drop it.)
  - Search field: `bg-surface` inset, `border-outline-soft`, `rounded-[13px]`,
    magnifier icon in `text-outline`. Filter button: square 44px, same border.
- **Featured (3 cards).** Alternate fills for rhythm: card 1 & 3
  `bg-primary-container` (title `text-on-primary-container`), card 2
  `bg-secondary-container` (title `#27341F`). Eyebrow category label up top
  (uppercase tracked, in `text-primary`/`text-secondary`), serif title below,
  `min-height` so they align. `rounded-2xl`, `p-4/5`.
- **All recipes.** Put the list inside a paper list-card (`border-outline-soft`,
  `rounded-2xl`, row dividers `divide-outline-soft`). Each row: title
  `font-medium text-on-surface`; right side category chip
  (`bg-primary-container text-on-primary-container`, `rounded-full`, 11px) +
  time in `text-on-surface-muted tabular-nums`.

### 4.3 Recipe detail — `recipes/[slug].astro`
- Back link: small chevron + "All recipes", `text-on-surface-muted hover:text-primary`.
- Edit / Add-to-shopping buttons: outline pills. Edit =
  `text-primary border-primary-container`; Add = `text-secondary border-secondary-container`.
- Title: `font-serif` 600, ~40px, `tracking-[-0.015em]`.
- Meta row: category chip + protein + time (muted, `tabular-nums`).
- **Two-column body on desktop** (`grid grid-cols-[300px_1fr] gap-10`), stacking on
  mobile:
  - **Ingredients** (left). Amount in `text-primary font-semibold tabular-nums`,
    right-aligned fixed width (~58px); name in `text-on-surface`.
  - **Method** (right). Numbered steps with a **circular step badge**
    (`bg-primary-container text-primary`, `font-serif` 600, 26px circle) instead of
    a bare "1.". Bold the leading label (`Mix:`, `Bake:`) in `font-semibold`.
- **Tip / Substitution callout:** soft `bg-secondary-container`, `rounded-2xl`, with
  an italic serif "Tip" label in `#27341F` and body in a darker sage. This is the
  recurring "aside" style.

### 4.4 Shopping list — `shopping.astro`
- Page title `font-serif` 600 ~32px; "Clear done" action in `text-primary`.
- **Aisle headers** = eyebrow labels in `text-secondary` (uppercase tracked).
- Each aisle is a paper list-card; rows have a 20px rounded checkbox.
  - Unchecked: `border-outline-soft` box.
  - **Checked: filled `bg-secondary` (sage) with a cream check**, label
    `text-on-surface-muted line-through`, quantity muted. (Sage = "done" is the
    semantic — keep terracotta for active/primary only.)
  - Quantity right-aligned, `tabular-nums`.

### 4.5 Login — `login.astro`
- Centered card (max-w ~400px) on the paper background, `shadow-card`.
- Top: large clay medallion (48px) → `font-serif` "Welcome back" → italic serif
  subtitle *"Sign in to cook together."*
- Fields: label (12px, 600, muted) over `bg-surface` inset inputs
  (`border-outline-soft`, `rounded-xl`).
- Primary full-width "Log in" button: `bg-primary text-on-primary`, inset-shadow,
  `rounded-xl`.
- Footnote, muted: *"Sign-ups are disabled — this kitchen is just for Tim & Zoe."*

---

## 5. Do / Don't

**Do**
- Lead with type and colour; let warm paper + whitespace do the work.
- Use Newsreader italic as the recurring accent (hero line, Tip labels, subtitles).
- Keep terracotta for primary/active, sage for secondary/"done", ochre as a rare dot.
- Use `tabular-nums` on every amount, quantity, and time.
- Keep the existing responsive behaviour, sticky hero, filters, and mobile bottom nav.

**Don't**
- No photography or illustrated food imagery. (Explicit request.)
- No new hues beyond clay / sage / ochre / paper.
- Don't use pure white text on terracotta — use the warm cream `--color-on-primary`.
- Don't add gradients, heavy drop-shadows, or rounded-corner-with-left-accent-border
  card tropes.
- Don't restructure components or routes — this is a re-skin.

---

## 6. Suggested order of work
1. `global.css`: swap `@theme` colour values, add accent + shadow tokens, wire fonts.
2. Load Newsreader + Hanken Grotesk (Fontsource) in `Layout.astro`.
3. `Layout.astro`: new wordmark + confirm nav pill styles.
4. `index.astro`: hero card, italic accent line, featured rhythm, list card.
5. `recipes/[slug].astro`: two-column body, numbered step badges, tip callout.
6. `shopping.astro`: sage checked-state, aisle eyebrows.
7. `login.astro`: medallion + serif welcome.
8. Sweep for `tabular-nums`, italic accents, and any remaining `#FFFFFF`-on-primary.
