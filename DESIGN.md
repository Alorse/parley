# Parley — design system: "Afterglow"

This document records the visual identity chosen for Parley and the
reasoning behind it. It replaces the initial build, which — by design brief
at the time — closely followed the "the reference app" reference screenshots (cream
background, orange blob, floating pill nav). That look was rejected as a
literal copy of the reference rather than an identity of its own. The
pre-rewrite state is tagged `design/reference-v1` in git history.

## The brief, restated

Parley is a voice-first English tutor for a Spanish-speaking adult, used on
a phone in short daily sessions — often quietly, one-handed, at whatever
point in the day there's a spare few minutes. The identity has to earn its
keep in that context: calm enough not to feel like one more demanding app,
warm enough to make speaking out loud to a phone feel low-pressure, and
alive enough that the live audio reactivity — the actual best part of the
product — reads as the main event rather than a decoration.

## The direction: a voice glowing in the quiet

The concept is **dusk and afterglow**: a calm, warm-dark canvas — the kind
of low-glare, private moment a person might actually open this app in — with
the tutor's/learner's voice rendered as the one warm, living, unpredictable
thing on screen. Everything else stays quiet and structured so attention has
nowhere else to go. This is the opposite of the reference's bright,
cheerful, cream-and-citrus daytime palette, and it's a deliberate choice for
*this* product: a tool for a private, sometimes self-conscious act (speaking
a language you're still learning, out loud, to a machine) benefits from
feeling intimate rather than perky.

## Color

| token | hex | role |
|---|---|---|
| `--bg` | `#181320` | page background — warm dusk, not pure black/blue-black |
| `--surface` | `#241D2C` | raised cards, sheets, pills |
| `--surface-sunk` | `#2C2436` | inactive fills, meter tracks |
| `--ink` | `#F3ECE6` | primary text — warm ivory, never used as a background |
| `--ink-soft` | `#B2A2AC` | secondary text |
| `--ink-faint` | `#7C6E78` | tertiary text, legends |
| `--ember` | `#E2637A` | primary interactive accent — buttons, active nav, links |
| `--ember-deep` | `#C94D66` | pressed/deep ember variant |
| `--gold` | `#F0B860` | secondary accent — hero's warm end, high scores |
| `--violet` | `#8571C4` | tertiary accent — hero's cool end, "thinking" state |
| `--card-rose/plum/moss/amber` | `#3D2531` / `#332C4A` / `#2A372F` / `#3C3226` | deep, muted Themes card tones (one per category) |

Why this, specifically, and not the defaults: a warm cream background with a
terracotta accent (near `#F4F1EA` + `#D97757`) is the single most common
AI-generated "warm and friendly" default — it's also almost exactly what the
reference screenshots used, which is precisely what got rejected. A
near-black background with one bright neon accent is the other common
default; we avoid that too by keeping the base *warm* (a plum-tinted dark,
not a desaturated near-black) and by using **three** accent hues in
distinct, non-interchangeable roles (ember does interactive work, gold and
violet live mostly inside the voice) rather than one flat "brand color"
reused everywhere.

## Type

Two families, self-hosted as woff2 (`public/fonts/`, latin + latin-ext,
variable weight ranges, no runtime Google Fonts request):

- **Fraunces** (variable, 300–900, optical sizing) — reserved for the
  tutor's spoken line, the empty-state prompt, and screen headlines
  ("What's on your mind?", "Your words."). A warm, slightly characterful
  serif with real personality but not a stiff Times-style formality — it
  gives the *tutor's own words* a distinct, considered voice, separate from
  the interface around them. Used at a restrained size (see below): it
  carries warmth, not volume.
- **Manrope** (variable, 400–800) — everything else: nav, buttons, body
  copy, labels, card titles, the learner's own transcript line, settings.
  Clean, geometric-humanist, legible at small sizes, and structurally
  distinct from the reference build's the previous font (which is rounder and
  bubblier — appropriate for a cheerful daytime app, less so for this one).

The rule is simple and meaningful rather than arbitrary: **Fraunces speaks,
Manrope organizes.** The tutor's voice and the learner's own words are never
set in the same face — a small, deliberate way of making the interface
itself feel like a conversation between two distinct voices.

### Scale (mobile-first)

| role | size | weight | face |
|---|---|---|---|
| Tutor's spoken line / empty prompt | `clamp(19px, 5.5vw, 23px)` | 560 | Fraunces |
| Screen headline (Themes/Words) | `clamp(24px, 7vw, 30px)` | 600 | Fraunces |
| Translation (under tutor's line) | 15px, italic | 400 | Fraunces |
| Learner's own line ("you said...") | 15px | 500 | Manrope |
| Body / card titles | 15–16px | 600–700 | Manrope |
| Labels, nav, legends | 11–13px | 600 | Manrope |

This is a substantial reduction from the original build (tutor line was
`clamp(30px, 9vw, 44px)`, effectively a full-screen headline every turn).
At the new size the hero, the full transcript, the score meter and the
controls all fit at 390×844 without scrolling, and the tutor's line is
still clearly the largest, warmest text on screen — just not so large it
crowds out everything around it.

## Shape and motion: the voice

The hero — "the voice" — is the one place all of the studio's boldness is
spent; everything else is intentionally quiet. Concretely:

- **An asymmetric ink-blot, not a circle.** The silhouette is a closed
  spline through seven points with deliberately *uneven* base radii
  (`[1.0, 0.7, 1.16, 0.82, 1.05, 0.62, 0.93]`), so it reads as an organic,
  lopsided form — like ink diffusing through water — even at rest with zero
  audio input. A small per-page-load jitter on top means no two sessions
  look quite identical. This directly answers the feedback that the
  original orb was "exageradamente redondo" (too perfectly round) with no
  idle character.
- **No orbiting bodies.** The reference design had two concentric rings
  with satellite dots circling them — "como si fuera un sol." Both are
  gone. All of the form's "aliveness" now comes from the blob's own
  silhouette, its glow, and its color — nothing circles it.
- **A genuine multi-hue gradient from the very first frame**, idle
  included: gold at the highlight, through ember, into violet at the
  outer edge, always present — never a flat single color, and never
  something that only appears once the tutor starts talking.
- **A brighter inner core that intensifies with real audio level** — the
  voice literally glows more as it speaks or as the learner speaks into the
  mic, on top of the silhouette's own distortion. This is the detail that
  makes it feel alive rather than decorative.
- **State behavior, still fully driven by real `AnalyserNode` data** (the
  mic's level while listening, the tutor's own playback level while
  speaking — never a fake timer):
  - *idle* — slow, small breathing, gentle swirl, muted glow.
  - *listening* — reacts to the mic level: quick jitter, a slight
    contraction (the shape "leans in" to listen), the core flickers.
  - *thinking* — the gradient itself slowly turns like ink swirling, and
    the palette cools toward violet — a color-temperature shift stands in
    for "processing" instead of an expanding ring.
  - *speaking* — reacts to the tutor's own playback level: larger silhouette
    swings, the warm core brightens substantially, gold/ember dominate.
- **The halo is a radial gradient that reaches exact zero alpha well inside
  the canvas**, not a blurred shape that can bleed past the canvas edge and
  get hard-clipped — this is what caused the visible rectangular seam in
  the previous build, and the fix is structural (a gradient can't overflow
  its own defined radius) rather than a size tweak that could regress.

Everywhere else, shape stays quiet and disciplined: soft rounded
rectangles (20px radius, down from the reference's 28px) for cards, sheets
and inputs, thin hairline borders instead of drop shadows, and a plain
horizontal meter (not another circle) for the turn score — the blob is the
only organic, circular-adjacent form in the whole app, so it's never
visually confused with anything else.

## Layout

- Mobile-first, single column, safe-area aware, unchanged in structure from
  the working build (Talk / Themes / Words + settings and score sheets) —
  the *skeleton* that changed is specifically the one the reference brief
  called out:
- **Bottom navigation is now a flush tab bar** (full-width, hairline top
  border, no shadow, no rounded pill, no inset margin) instead of the
  reference's floating rounded pill — a quieter, more native-feeling
  structural device, and a clear departure from the reference app's own nav language.
  Active tab is indicated by an ember-colored icon/label and a small dot
  above it, not a filled pill background.
- No tracked-out all-caps "eyebrow" labels above headings (the reference
  had "A PLACE TO BEGIN" and "LITTLE BY LITTLE · ENGLISH") — these are
  exactly the kind of templated chrome that reads as generated rather than
  designed, and they added nothing the heading + subtitle didn't already
  say. Removed outright rather than restyled.
- Talk screen content is split into two natural-height groups
  (`.talk-top`, `.talk-bottom`) with `justify-content: space-between` on
  the screen, so any leftover viewport height becomes one deliberate gap
  between them rather than stretching internal elements apart — this also
  carries over from the earlier robustness pass and still holds with the
  smaller type.

## Principles (for future changes)

1. The voice is the only bright, unpredictable, alive thing on screen —
   protect that contrast. Don't add a second saturated, animated element
   competing for attention.
2. No orbit, no perfect circles, no symmetrical rings anywhere in the app.
   Organic/asymmetric form is reserved *exclusively* for the voice.
3. Fraunces speaks, Manrope organizes — never mix them within a single
   line of text, and don't introduce a third family.
4. Dark, warm, low-glare canvas for quiet one-handed use. Never stark
   white, never a desaturated near-black.
5. When adding a new accent use, reach for ember first (it's the
   functional color); reserve gold and violet for moments connected to the
   voice itself, so they keep reading as "hers," not generic UI paint.
