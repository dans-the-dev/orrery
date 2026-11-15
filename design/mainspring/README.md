# Orrery design style: Mainspring

Chosen by the owner on 2026-11-15 from the saved set (`Design Styles 2026-11-12/08-mainspring`), then redrawn for
Orrery with ElevenLabs (`gpt-image-2`, 4 variations, about 740 credits, flow `1sTSNiAXs5abXLokn7wK`, node
`7i3RJCWWBMMw35mTz8QA`). Applied to the site on 2026-11-15 (see `design/README.md`).

- `mockups/orrery-mainspring-1..4.png` (1280 x 720), `sheet-orrery-mainspring.jpg` with all four.
- Best: **1** (clear sun and ruby planet, card reads cleanly). Runner up: 2. All four spell every word as prompted.

## Header, revised 2026-11-15

The owner asked for a more professional header. Variation 1 was edited (`gpt-image-2` with the mockup as reference,
4 variations, about 1,680 credits): `mockups/orrery-header-1..4.png`, `sheet-orrery-header.jpg`,
`header-before-after.jpg`. Best: **header 1** (runner up 4). It is now the reference for the whole page.

- Full-width bar flush with the top, same navy as the page, one silver hairline under it. No floating pill, no shadow.
- Content aligned to the headline's left margin and the orrery's right edge.
- Left: brand mark (thin rose gold ring, one dot on the orbit, a dot at the centre) and the spaced serif wordmark.
- Centre: Product, Dashboard, Readings, Docs in a small sans at 75 percent; the current page in white with a short
  rose gold underline.
- Right: X icon, a thin vertical hairline, a slim outlined "Connect wallet" button with softly rounded corners.

## Tokens

| Role | Value |
|---|---|
| Ground | midnight navy `#0F1A2E` with a fine guilloché wave engraving |
| Ink | silver white `#E9ECEF` |
| Brand | rose gold `#D9967A`, only on the primary button and headline line two |
| Hero object | mechanical orrery built like a watch movement: rose gold rings with Geneva stripes, blued steel planets, one ruby planet |
| Display | light high-contrast serif, line two italic |
| Text | clean sans |
| Nav | full-width bar, silver hairline under it, ring mark plus spaced serif wordmark, outlined "Connect wallet" (see Header) |
| Facts strip | rose gold marquee, navy text, middle dots |

## Applying it to the site

Build the hero as a text-free plate of the orrery (left 45 percent empty for the headline) and set type and tokens in
code. The card value ("Research agent", "inside its orbit") is illustrative: the live card shows real state only.

## Prompt

The exact prompt is in `prompt.md`.
