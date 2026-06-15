<!-- SEED: re-run /impeccable document once there's code to capture the actual tokens and components. -->

---
name: Inca Import
description: B2B import distribution for fuel stations and convenience stores in La Réunion
---

# Design System: Inca Import

## 1. Overview

**Creative North Star: "The Island Warehouse"**

A trusted import hub that feels as precise as a shipping manifest and as alive as La Réunion itself. Clean, warm, purposeful. The visual language of a company that knows exactly what it stocks, where it comes from, and who needs it. Every design decision defers to clarity and confidence over decoration.

The system rejects three failure modes: the templated Shopify look (no default grid patterns, no hero-CTA-pricing-footer scaffolding); the promotional FMCG machine (no countdown timers, no badge overload, no aggressive discount hierarchy); and the cold luxury museum (no hyper-minimal whitespace with nothing to say, no product photography as the only content). Inca Import is warm but working. Premium but grounded. A B2B platform that gérants trust with their inventory.

The surface is pure white. The burnt-orange primary carries all the warmth — the sun of La Réunion pressed into a stamp. An ocean-teal accent grounds functional states (status, availability, action confirmation). The system has one voice, one accent color, and one rule about each. The rest steps back.

**Key Characteristics:**
- Pure white ground with a single warm-coral/burnt-orange primary
- Clean geometric-humanist sans typography, weight-driven hierarchy
- Flat by default — depth conveyed through tonal layering and subtle shadow on hover/focus
- Responsive motion: state-change transitions and feedback, no scroll choreography
- Mobile-first ergonomics throughout (44px minimum touch targets, generous tap areas)
- B2B precision: prices, quantities, and availability always scannable at a glance

## 2. Colors

A committed single-primary palette — burnt orange stakes the brand identity on a pure white field, ocean teal performs functional work.

### Primary
- **La Réunion Coral** (`oklch(0.568 0.149 45.9)` — warm coral / burnt orange): The brand stamp. Used on primary CTAs, active navigation states, selected filters, focus rings, and brand accent marks. White text on all filled applications. Rarity is the point — when this color appears, it means "act here" or "this is ours."

### Secondary
- **Ocean Deep** (`oklch(0.295 0.088 210)` — deep ocean teal): Functional accent. Used for availability indicators, status pills (in stock, confirmed), informational badges, and secondary links. White text. Never decorative — only appears when information needs to be distinguished from the primary brand color.

### Neutral
- **Pure White** (`oklch(1.000 0.000 0)`): Page background. Not off-white, not warm-tinted — literal white. The primary carries the warmth.
- **Warm Whisper** (`oklch(0.975 0.004 45.9)` — barely-tinted warm surface): Cards, panels, sidebar backgrounds, table alternating rows. The ghost of the primary hue.
- **Warehouse Ink** (`oklch(0.148 0.020 45.9)` — near-black with warm undertone): All body text and headings. Warm but never brown.
- **Dock Mist** (`oklch(0.440 0.010 45.9)` — medium warm gray): Secondary text, captions, timestamps, helper text. Minimum 3.5:1 contrast against white.

### Named Rules
**The Import Mark Rule.** La Réunion Coral appears on ≤15% of any given screen. Its rarity makes it an instruction: "act here" or "this is the brand." Never scatter it as decoration.

**The Surface-Only Warmth Rule.** The page background is pure white (`oklch(1.000 0.000 0)`). Warmth belongs to the primary color, not the ground. If the bg feels cold, increase primary usage; never tint the background.

## 3. Typography

**Display / Heading Font:** `[geometric-humanist sans — to be chosen at implementation]` (Inter, Plus Jakarta Sans, or DM Sans are reference-tier fits)
**Body Font:** same family as display, or a companion humanist sans
**Mono / Label:** system monospace for quantities, SKUs, prices (`ui-monospace, "Cascadia Code", monospace`)

**Character:** Weight-driven hierarchy within a single sans family. The system speaks in one typeface but at different volumes — ultra-bold headings, medium body, tabular mono for catalog numbers. No decorative font pairing; legibility is the elegance. Geometric enough to feel precise, humanist enough to feel approachable.

### Hierarchy
- **Display** (800–900, `clamp(2.5rem, 6vw, 4rem)`, line-height 1.05, tracking −0.03em): Marketing hero headings, landing section titles. Text-wrap: balance.
- **Headline** (700, `clamp(1.5rem, 3.5vw, 2.25rem)`, line-height 1.15): Page titles, category headings, modal headings.
- **Title** (600, `1.125rem` / `1.25rem`, line-height 1.3): Section headers, card headings, sidebar labels.
- **Body** (400, `1rem`, line-height 1.6, max 65ch): All prose, product descriptions, helper text. Never below 1rem (16px) on any device.
- **Label** (500–600, `0.8125rem`, line-height 1.4, letter-spacing 0.01em): Form labels, table headers, navigation items, filter tags. Never all-caps — tracked caps are the eyebrow reflex.
- **Mono** (400, `0.875rem`, line-height 1.5, tabular-nums): SKUs, quantities, prices, order numbers. Mono ensures numeric columns align.

### Named Rules
**The One-Size-Minimum Rule.** Body text is never below 16px (`1rem`) on any surface, including mobile. The gérant is at the counter. Legibility is not a premium feature.

**The No-Eyebrow Rule.** Uppercase tracked kicker labels above section headings are prohibited. If a section needs a label, use a Title or Label-weight inline with the heading, not a tiny all-caps line above it.

## 4. Elevation

Flat by default. Depth is conveyed through tonal layering — the Warm Whisper surface (`oklch(0.975 0.004 45.9)`) read against Pure White creates a lift without a shadow. Interactive elements (cards, buttons, dropdowns) use a single ambient shadow that appears on `:hover` and `:focus` as a state response, not a static decoration.

### Shadow Vocabulary
- **Resting Lift** (`0 1px 3px oklch(0.148 0.020 45.9 / 0.08), 0 1px 2px oklch(0.148 0.020 45.9 / 0.06)`): Cards and panels at rest. Subtle. Most surfaces use tonal layering instead.
- **Interactive Hover** (`0 4px 12px oklch(0.148 0.020 45.9 / 0.12), 0 2px 6px oklch(0.148 0.020 45.9 / 0.08)`): Appears on hover for clickable cards and elevated containers. Signals interactivity.
- **Dropdown / Overlay** (`0 8px 24px oklch(0.148 0.020 45.9 / 0.14)`): Menus, popovers, datepicker panels.

### Named Rules
**The Flat-At-Rest Rule.** No element carries a shadow at rest unless it needs to communicate "above the page" (overlays, dropdowns). Interactive cards and containers earn their shadow on hover only.

## 5. Components

No components documented yet — this is a seed file. Re-run `/impeccable document` once there's code.

## 6. Do's and Don'ts

### Do:
- **Do** use `oklch(0.568 0.149 45.9)` (La Réunion Coral) for primary CTAs, active states, and selected UI — white text on all filled applications.
- **Do** use tabular mono for all numeric content: prices, quantities, SKUs, order totals. Numbers must column-align.
- **Do** set minimum 44px touch targets on all interactive elements — the gérant ordering on a phone at the counter is the primary use case.
- **Do** show prices, quantities, and availability without ambiguity on every screen that involves ordering. Clarity is the trust signal.
- **Do** use tonal layering (Pure White vs. Warm Whisper) before reaching for shadows. Flat reads as premium here.
- **Do** add `:hover` and `:focus-visible` state changes to every interactive element — state feedback is the micro-motion strategy.
- **Do** respect `prefers-reduced-motion`. Every transition must have a reduced-motion fallback (crossfade or instant).

### Don't:
- **Don't** use a warm-tinted, off-white, or cream/sand background. The brief explicitly names "generic Shopify/WooCommerce" as an anti-reference; warm-bg templates are that aesthetic's most identifiable tell.
- **Don't** add countdown timers, "% off" badges stacked on product images, or flash-sale visual hierarchy. Inca Import is a trusted partner, not a FMCG promo machine.
- **Don't** go hyper-minimal — no product photography as the only content, no large whitespace fields with nothing in them. The gérant needs information, not mood.
- **Don't** use uppercase tracked kicker labels ("PRODUCTS · CATALOG · ABOUT") as section eyebrows. This is the AI scaffold reflex.
- **Don't** use `border-left` (> 1px) as a colored stripe accent on cards, list items, or callouts. Replace with full borders, background tints, or nothing.
- **Don't** apply gradient text (`background-clip: text` with a gradient fill). Single solid color only.
- **Don't** use La Réunion Coral on more than ~15% of any screen. Rarity is how it retains meaning.
- **Don't** place body text below 16px on any device. Legibility is a B2B requirement, not a luxury.
