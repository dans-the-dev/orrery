# Orrery design: Mainspring

Orrery's visual direction is **Mainspring** (chosen by the owner on
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
then the social icons, a thin divider and an outlined "Connect wallet". The mark is "Orbit O" (owner's pick on 2026-11-15 from three
concepts in `design/mainspring/logo/`): a cut serif O with its stress tilted, one orbit crossing in front of it through
a gap masked out of the O, and a body riding the orbit. Every illustration is an HD photograph of a piece of a fine watch,
made like the hero plate (ElevenLabs `flux-3-image` with the plate as style reference, two variations each, sources in
`design/mainspring/hd/`, picks and processing in `design/art/hd_art.py`). Square views are cut out (ElevenLabs
birefnet) and float on transparency on light and dark sections; the three 400x300 cards are full photographs. Plot sets
a bound on the dial with a ruby stop, Pay turns the gear train and releases a coin, Read is a watchmaker's loupe, Sign
the caseback seal; the caps are three chronograph registers, the delay a timing bezel, allowed calls a route of
jewels; ORRY pages show the hourglass (burn), two trains winding one barrel (claim), the balance wheel with coins
(earn), baton markers (leaderboard) and the wound mainspring (stake). Vector drafts of the same set stay in
`design/art/vector/` (`build_art.py`). Pages never crop or mask any of them.

Signature object: the hero plate `services/packages/web/public/art/orrery-plate.webp`, a photographed rose gold orrery
(ElevenLabs `flux-3-image`, source in `design/mainspring/plates/`), with the live reading console in smoked glass over it.

Files:

- `services/packages/web/app/styles/mainspring.css` holds the theme, loaded last.
- `services/packages/web/components/Brand.tsx` draws the header mark (Orbit O); `public/art/mark.svg`, `app/icon.png` and
  `app/apple-icon.png` are the same mark on a navy tile.
- `design/art/build_art.py` writes every illustration in `services/packages/web/public/art/*.svg`.
- `public/og.png` is the share image (plate, headline, rose gold band).
