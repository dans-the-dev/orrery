# Orrery design: Observatory

Orrery is a rebrand of Runcore with the same functions. Its visual direction is **Observatory**: an agent's spending
is a body on a fixed orbit, the operator sets that orbit, and a merchant takes a reading of the payer.

| Token | Value | Role |
| :--- | :--- | :--- |
| Night | `#161b45` (deep `#0d1030`, glow `#262d6b`) | Hero, nav rail, dark sections, illustration ground |
| Brass | `#d8b25c` (soft `#f1dca4`, ink `#8a6417`) | Rings, ticks, kickers, wallet button on the rail, primary action on dark |
| Violet | `#5b45c9` | The primary action on light ground, focus ring |
| Rose | `#e07a7f` | The cap ring in illustrations |
| Ground | `#e9e9f2` (paper `#f6f5fa`) | Reading sections and product workspaces |
| Ink | `#171a33` (muted `#5b5f7c`) | Text on light ground |

Type: **Jost** 300 to 500 for display (a geometric face, like the lettering on a planetarium dial), **Albert Sans**
for text and controls, **IBM Plex Mono** for addresses, amounts and timers.

Material: a night sky ground with a sparse star field (`--sky` in `observatory.css`), brass hairlines instead of hard
borders, pill buttons, soft shadows. Every illustration is an eyepiece view (a night disc with a brass dial ring) or a
star plate (a night panel), so pages never crop or mask them.

Signature object: the hero orrery (`services/packages/web/components/motion/OrreryHero.tsx`), three agents on their
orbits around a brass sun inside a dashed rose cap ring. Planets move with SMIL and rest under reduced motion.

Files:

- `services/packages/web/app/styles/observatory.css` holds the theme, loaded last.
- `design/art/build_art.py` writes every illustration in `services/packages/web/public/art/*.svg`.
