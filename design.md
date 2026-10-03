# BannerBye · design system

Locked on 2026-10-02, approved by Robin on the homepage mockup. One system, every
page. Do not re-pick per page — Hallmark's diversification rule inverts for
multi-page sites: here consistency *is* the goal.

## Picks

| | |
|---|---|
| Genre | modern-minimal |
| Theme | BannerBye brand, preserved (cream / ink / ember / smoke) |
| Display face | Space Grotesk 500/600/700 |
| Body face | Inter 400/500/600 |
| Mono face | JetBrains Mono 500 |
| Macrostructure — marketing pages | 15 · Split Studio (diptych, alternating) |
| Macrostructure — document pages | prose column, hairline-ruled |
| Nav | N9 · edge-aligned minimal |
| Footer | Ft5 · statement |
| Comparison | F3 · tabular spec sheet |
| Step sequence | F4 · 01/02/03, horizontal flow |
| Motion | 3 primitives: settle-on-load, hover-shift, open/close |

## Rules that are not negotiable

1. **No re-drawn browser chrome.** No fake address bars, traffic-light dots, or
   mock banner overlays. The hero proof is the pure-CSS *refusal ledger*: what a
   site asks on the left, the answer on the right. (Hallmark gate 47.)
2. **No eyebrow on every section.** Section labels live in the heading itself.
3. **No 3-column feature-card grid.** Lists are ruled rows; the comparison is a
   real table.
4. **No invented metrics.** Every number on the site carries its source line.
   The three stats and their sources are fixed; do not add a fourth.
5. **Headings never run past ~17ch** (`.head h2`), with the lede in the right
   half of the diptych. This is what stops 5-line headings with an empty column.
6. **The wordmark is one word.** `Banner<em>Bye</em>` inside a single `<span>` —
   never two flex children, or the gap splits it into "Banner Bye".
7. **Install buttons follow the visitor's browser** via `data-install` +
   `install.js`. Markup degrades to Chrome without JS.

## Tokens

All tokens live in `system.css` under `:root`. Colours are OKLCH. Spacing is a
4pt-derived scale. Type uses `clamp()` for the two display sizes only.

Brand anchors, unchanged from the pre-redesign site:
`cream #FAF7F0` · `ink #0E1116` · `ember #E85A2C` · `smoke #6B7077`

## Page inventory

| File | Shape | Notes |
|---|---|---|
| `index.html` | Split Studio, 9 bands | All 11 FAQs kept verbatim — they match the FAQPage schema 1:1 |
| `vs/*.html` (4) | Split Studio, short | FAQPage + BreadcrumbList schema per page |
| `privacy.html` | prose column | Apple-reviewed permission wording — never reword |
| `fixed.html` | prose + live list | Fetches `/api/fixed`; JS untouched |
| `404.html` | minimal centred | |
| `admin.html` | **left alone** | Internal, behind ADMIN_TOKEN, still on `styles.css` |

## Stylesheets

Public pages load `/system.css` only. The old compiled Tailwind build
(`styles.css`) stays in the repo because `admin.html` still uses it.

## Copy discipline

Redesign means *re-dress*, not rewrite. Every sentence, every FAQ answer, every
source line from the pre-redesign site is carried over. The only text removed
were the decorative mono eyebrows ("The problem", "Questions", …), which are
navigational labels, not substance. Schema.org answers must keep matching the
visible FAQ text — Google requires it.
