# Orrery design: Mainspring

Orrery is a rebrand of Runcore with the same functions. Its visual direction is **Mainspring** (chosen by the owner on
2026-11-15 from the saved style set, then redrawn for Orrery: `design/mainspring/`). An agent's spending is a body on a
fixed orbit, shown as a mechanical orrery built like a watch movement; the operator sets the orbit, and a merchant takes
a reading of the payer.

| Token | Value | Role |
| :--- | :--- | :--- |
| Night | `#0f1a2e` (deep `#0a1222`, glow `#18294a`) | Header, hero, dark sections, illustration ground |
| Silver | `#e9ecef` | Ink on dark ground, header links, outlined wallet button |
| Rose gold | `#d9967a` (soft `#ebc2ae`, ink `#9a5b42`) | The primary action, headline line two, facts band, rings in illustrations |
| Ruby | `#c2384b` | The cap ring in illustrations, one jewel in the plate |
| Ground | `#eceef1` (paper `#f6f7f8`) | Reading sections and product workspaces |
| Ink | `#0f1a2e` (muted `#586377`) | Text on light ground |

Type: **Instrument Serif** for display (light, line two of the hero in italic), the spaced uppercase wordmark and
headings; **Hanken Grotesk** for text and controls; **IBM Plex Mono** for addresses, amounts and timers.

Material: a navy ground with a faint guilloché engraving (`--engrave` in `mainspring.css`), silver hairlines, 8 px
radius buttons, a rose gold primary action with navy text. Header: a full-width bar flush with the top, one hairline
under it, the ring mark and spaced wordmark on the left, links in the middle (the current page underlined in rose gold),
then the social icons, a thin divider and an outlined "Connect wallet". Every illustration is an eyepiece view (a navy
disc with a rose gold dial ring) or a plate (a navy panel), so pages never crop or mask them.

Signature object: the hero plate `services/packages/web/public/art/orrery-plate.webp`, a photographed rose gold orrery
(ElevenLabs `flux-3-image`, source in `design/mainspring/plates/`), with the live reading console in smoked glass over it.

Files:

- `services/packages/web/app/styles/mainspring.css` holds the theme, loaded last.
- `services/packages/web/components/Brand.tsx` draws the header mark; `public/art/mark.svg`, `app/icon.png` and
  `app/apple-icon.png` are the same mark on a navy tile.
- `design/art/build_art.py` writes every illustration in `services/packages/web/public/art/*.svg`.
- `public/og.png` is the share image (plate, headline, rose gold band).
