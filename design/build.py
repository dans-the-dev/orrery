from pathlib import Path
from html import escape

ROOT = Path(__file__).parent
DIRS = [
    dict(slug='01-needlehouse', name='Needlehouse', register='A dark spend instrument rendered like a precision control room.', brand='#ff6845', light='#f0f0e9', dark='#101c22', ink='#17252a', on='#171b1b', success='#326e42', warning='#ffbd59', danger='#b52a27', hair='#a7b6b0', display='Montserrat', text='Cantarell', mono='JetBrains Mono', hero='Your agent spends.\nThe needle holds.', lead='Set the range your agent can spend. Every payment address carries a readable policy and a fresh signed check.', object='gauge'),
    dict(slug='02-red-seal', name='Red Seal', register='A modern notary desk where each paying address resolves into a signed certificate.', brand='#ab2845', light='#f5f0e6', dark='#241d20', ink='#31272a', on='#fff7ed', success='#287a62', warning='#9c641d', danger='#a92342', hair='#c5b9ac', display='Caladea', text='Carlito', mono='JetBrains Mono', hero='A payment arrives.\nThe proof follows.', lead='Read the authority behind the paying address. Caps, live endpoints, and a signed answer arrive together.', object='seal'),
    dict(slug='03-current-limit', name='Current Limit', register='A kinetic payment circuit that makes the spending boundary physical.', brand='#3152e9', light='#eef2ec', dark='#111c39', ink='#18213b', on='#ffffff', success='#167b62', warning='#a46013', danger='#d33542', hair='#aab5ca', display='Comfortaa', text='Adwaita Sans', mono='JetBrains Mono', hero='Let agents move.\nKeep spend in range.', lead='Money flows through public limits. Check the address that paid you and receive a signed answer.', object='circuit'),
]

def svg_object(kind):
    if kind == 'gauge':
        ticks=''.join(f'<line x1="300" y1="70" x2="300" y2="{91 if i%5==0 else 81}" transform="rotate({i*6} 300 300)" />' for i in range(60))
        return f'''<svg class="signature gauge" viewBox="0 0 600 600" role="img" aria-label="Spend gauge with a marked daily cap"><defs><radialGradient id="dial"><stop stop-color="#33464b"/><stop offset=".7" stop-color="#172b31"/><stop offset="1" stop-color="#0d171b"/></radialGradient><filter id="sh"><feDropShadow dx="12" dy="20" stdDeviation="18" flood-opacity=".5"/></filter></defs><circle cx="300" cy="300" r="257" fill="#0b151a" stroke="#718080" stroke-width="2" filter="url(#sh)"/><circle cx="300" cy="300" r="226" fill="url(#dial)" stroke="#738680" stroke-width="3"/><g stroke="#bad0c7" stroke-width="2">{ticks}</g><path d="M130 440 A220 220 0 0 1 476 145" fill="none" stroke="#88a69d" stroke-width="12" opacity=".5"/><path class="gauge-progress" d="M130 440 A220 220 0 0 1 360 89" fill="none" stroke="var(--brand)" stroke-width="13" stroke-linecap="round"/><line x1="300" y1="300" x2="453" y2="138" stroke="#ff6845" stroke-width="9" class="needle"/><circle cx="300" cy="300" r="26" fill="#bdc5ba"/><circle cx="300" cy="300" r="11" fill="#17262b"/><text x="300" y="377" text-anchor="middle" fill="#eef2e9" font-size="38" font-family="JetBrains Mono">12.40</text><text x="300" y="409" text-anchor="middle" fill="#a6b9b2" font-size="15" font-family="JetBrains Mono">OF 50 USDG TODAY</text><text x="86" y="507" fill="#e7ece4" font-size="14" font-family="JetBrains Mono">0</text><text x="490" y="507" fill="#ff6845" font-size="14" font-family="JetBrains Mono">CAP</text></svg>'''
    if kind == 'seal':
        return '''<div class="signature certificate" role="img" aria-label="Layered signed check certificate"><div class="paper-back"></div><div class="paper-main"><div class="paper-top"><span>Orrery / check</span><span>Signed answer</span></div><div class="paper-address">Payer address<br><b>0x7B42…9aE1</b></div><div class="paper-rule"></div><div class="paper-value">Authority, made visible.</div><div class="paper-rows"><span>Per payment <b>10 USDG</b></span><span>Daily cap <b>50 USDG</b></span><span>Endpoint <b>Live</b></span></div><div class="wax"><span>R</span><small>CHECKED</small></div><div class="paper-foot">Orrery signed check / EIP-712</div></div></div>'''
    return '''<svg class="signature circuit" viewBox="0 0 680 520" role="img" aria-label="Payment current meeting a spend limiter"><defs><linearGradient id="tube" x2="1" y2="1"><stop stop-color="#9bd0ff"/><stop offset="1" stop-color="#3152e9"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="8"/></filter></defs><path class="trace-bg" d="M-20 143 H145 Q190 143 190 188 V241 H315 M-20 311 H100 Q150 311 150 370 H315 M-20 425 H90 Q185 425 185 356 H315 M365 282 H520 Q570 282 570 216 H700"/><path class="trace-flow" d="M-20 143 H145 Q190 143 190 188 V241 H315 M-20 311 H100 Q150 311 150 370 H315 M-20 425 H90 Q185 425 185 356 H315 M365 282 H520 Q570 282 570 216 H700"/><circle cx="339" cy="281" r="137" fill="#162766" stroke="#7899ff" stroke-width="5"/><circle cx="339" cy="281" r="103" fill="#304bea" stroke="#adbcff" stroke-width="2"/><path d="M339 187 V375 M255 281 H423" stroke="#c9d1ff" stroke-width="16" stroke-linecap="round"/><rect x="305" y="246" width="68" height="68" rx="16" fill="#f3f4dd"/><path d="M330 279 l8 8 18-20" fill="none" stroke="#3152e9" stroke-width="7" stroke-linecap="round"/><text x="338" y="108" fill="#1d2d5c" text-anchor="middle" font-size="18" font-family="JetBrains Mono">CAP 50 USDG / DAY</text><text x="547" y="337" fill="#1d2d5c" font-size="17" font-family="JetBrains Mono">CHECKED</text><circle class="packet" cx="0" cy="143" r="13" fill="#3152e9"/></svg>'''

def nav(d, active='Home'):
    links=f'<a href="index.html" {"aria-current=page" if active=="Home" else ""}>Home</a><a href="app.html" {"aria-current=page" if active=="Operator" else ""}>Operator</a><a href="signer.html" {"aria-current=page" if active=="Signer" else ""}>Signer lookup</a>'
    return f'<nav class="nav"><a class="wordmark" href="index.html">orrery<span class="wm-mark">●</span></a><div class="nav-links">{links}</div><div class="nav-actions"><a class="x-link" href="https://x.com/orrerytech" aria-label="Orrery on X">X</a><button class="wallet" type="button">Connect wallet</button></div></nav>'

def footer():
    return '<footer><div class="wordmark">orrery<span class="wm-mark">●</span></div><p>Public limits for agent payments.</p><div><a href="https://x.com/orrerytech">@orrerytech</a><a href="https://orrery.tech">orrery.tech</a></div></footer>'

def check_widget():
    return '''<div class="check-widget" aria-label="Live paying address check"><div class="check-head"><span>Paying address check</span><span class="check-time">Checked just now</span></div><div class="check-lookup"><label for="payer">Payer address</label><div><input id="payer" type="text" value="0x7B42…9aE1" aria-label="Payer address"><button class="lookup" type="button">Check</button></div></div><div class="check-status"><span class="status-orb"></span><strong>Active policy</strong><span>Endpoints live</span></div><div class="check-grid"><div><small>Per payment</small><strong>10 <em>USDG</em></strong></div><div><small>Today</small><strong><span class="tick-value">12.40</span> <em>/ 50 USDG</em></strong><span class="mini-track"><i></i></span></div><div><small>Float ceiling</small><strong>20 <em>USDG</em></strong></div></div><div class="check-signed"><span>Signed check ready</span><span class="check-count">Valid for 09:59</span></div></div>'''

def card_art(kind):
    if kind=='gauge':
        return ['<div class="card-art art-bars"><i></i><i></i><i></i><i></i><span>CAP</span></div>','<div class="card-art art-lock"><span>⏱</span><b>01:00</b></div>','<div class="card-art art-target"><span>◎</span><i></i><i></i></div>']
    if kind=='seal':
        return ['<div class="card-art art-bars"><div class="ledger-lines"><i></i><i></i><i></i></div><span>50 USDG</span></div>','<div class="card-art art-lock"><span>✶</span><b>1 hour</b></div>','<div class="card-art art-target"><span>✓</span><i></i><i></i></div>']
    return ['<div class="card-art art-bars"><i></i><i></i><i></i><i></i><span>CAP</span></div>','<div class="card-art art-lock"><span>⧖</span><b>1 h</b></div>','<div class="card-art art-target"><span>⌁</span><i></i><i></i></div>']

def landing(d):
    a=card_art(d['object'])
    title=d['hero'].split('\n')
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orrery · {d['name']}</title><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="site.css"></head><body class="landing {d['object']}"><div class="hero-shell">{nav(d)}<main><section class="hero"><div class="hero-copy"><p class="intro">Agent spending, legible at a glance.</p><h1>{escape(title[0])}<br><span>{escape(title[1])}</span></h1><p class="lead">{d['lead']}</p><div class="hero-actions"><a class="primary" href="app.html">Set an agent policy</a><a class="secondary" href="signer.html">Check a signer</a></div></div><div class="hero-object" id="hero-object">{svg_object(d['object'])}</div>{check_widget()}</section></main></div><div class="marquee" aria-label="Product facts"><div class="marquee-track"><span>Per payment caps</span><i></i><span>Daily limits</span><i></i><span>Float ceilings</span><i></i><span>Call allowlists</span><i></i><span>Signed checks</span><i></i><span>One hour minimum for increases</span><i></i><span>Per payment caps</span><i></i><span>Daily limits</span><i></i></div></div><section class="benefits section-light"><div class="section-heading"><p class="section-kicker">Boundaries you can read</p><h2>Every permission has a shape.</h2><p>The operator sets the policy. Anyone receiving a payment can inspect the paying address.</p></div><div class="feature-layout"><article class="feature feature-one">{a[0]}<h3>Spend stays in range.</h3><p>Per payment, per day, and float caps are visible together.</p></article><article class="feature feature-two">{a[1]}<h3>Increases take time.</h3><p>Every increase waits at least one hour before it applies.</p></article><article class="feature feature-three">{a[2]}<h3>Calls stay scoped.</h3><p>Allowlisted targets define the calls an agent may make.</p></article></div></section><section class="mechanism section-dark" id="mechanism"><div class="section-heading"><p class="section-kicker">The path of a payment</p><h2>One address. A complete answer.</h2></div><div class="flow-diagram"><div class="flow-line"></div><div class="flow-node"><div class="node-art art-operator"><span>⌘</span></div><strong>Operator sets caps</strong><p>A public policy sets the range.</p></div><div class="flow-node"><div class="node-art art-agent"><span>◎</span></div><strong>Agent pays</strong><p>USDG moves from its signer address.</p></div><div class="flow-node"><div class="node-art art-merchant"><span>⌕</span></div><strong>Merchant checks</strong><p>The payer address resolves to its policy.</p></div><div class="flow-node"><div class="node-art art-answer"><span>✓</span></div><strong>Signed answer</strong><p>Caps and endpoint status arrive together.</p></div></div></section><section class="sdk section-light"><div><p class="section-kicker">For the receiving side</p><h2>Ask about the address that paid you.</h2><p>Use the TypeScript SDK to request a signed check. The response includes the policy, spend today, and endpoint status.</p><a class="text-link" href="signer.html">Explore a signer record</a></div><pre><code><span class="code-comment">// The address on the payment</span>\nconst check = await orrery.checkPayer(payer);\n\nconsole.log(check.caps);\nconsole.log(check.endpointsLive);\nconsole.log(check.validUntil);</code></pre></section><section class="pricing section-dark"><div><p class="section-kicker">Pricing</p><h2>Checks are paid for when you use them.</h2><p>Buy credits with USDG. Each signed check uses one credit. Operators pay once to verify an agent.</p></div><div class="price-art"><span>1</span><p>credit per signed check</p><a class="primary" href="app.html">Open the operator app</a></div></section>{footer()}<script src="../../live.js"></script></body></html>'''

def app(d):
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orrery · Operator</title><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="site.css"></head><body class="product-page {d['object']}">{nav(d,'Operator')}<main class="app-main"><div class="app-top"><div><p class="section-kicker">Operator workspace</p><h1>Keep every agent in range.</h1><p>Set public spending authority for each signer.</p></div><button class="primary" type="button">Add agent</button></div><div class="app-shell"><aside class="agent-rail"><div class="rail-title"><strong>Agents</strong><span>2 active</span></div><button class="agent-item selected" type="button"><span class="agent-icon">A</span><span><strong>Atlas</strong><small>0x7B42…9aE1</small></span><i class="state-mark"></i></button><button class="agent-item" type="button"><span class="agent-icon">M</span><span><strong>Meridian</strong><small>0x4E90…31cB</small></span><i class="state-mark"></i></button><div class="rail-note">Signer addresses are the public key to each policy.</div></aside><section class="editor"><div class="editor-head"><div><p class="section-kicker">Atlas / policy</p><h2>Spending authority</h2></div><span class="status-label">Active</span></div><div class="spend-panel"><div><span>Spent today</span><strong>12.40 <small>/ 50 USDG</small></strong></div><div class="spend-track"><i></i></div><p>37.60 USDG available today</p></div><div class="editor-section"><div class="row-heading"><h3>Token caps</h3><button class="quiet-button" type="button">Add token</button></div><div class="token-row"><div class="token-name"><span class="coin-shape">$</span><strong>USDG</strong></div><label>Per payment<input type="number" value="10" min="0"><small>USDG</small></label><label>Per day<input type="number" value="50" min="0"><small>USDG</small></label><label>Float ceiling<input type="number" value="20" min="0"><small>USDG</small></label></div></div><div class="editor-section"><div class="row-heading"><h3>Allowed calls</h3><button class="quiet-button" type="button">Add target</button></div><div class="target-row"><span class="target-art">⌁</span><div><strong>Payment router</strong><small>0x6A12…c941 / pay(bytes)</small></div><button class="quiet-button" type="button">Edit</button></div></div><div class="editor-section editor-two"><label>Policy expiry<input type="date" value="2027-12-31"></label><label>Increase delay<select><option>1 hour minimum</option><option>6 hours</option><option>24 hours</option></select></label></div><div class="pending"><div class="pending-symbol">⏳</div><div><strong>Increase pending</strong><p>Daily cap to 75 USDG becomes available in <span id="countdown">00:42:18</span>.</p></div><button class="quiet-button" type="button">Review</button></div><div class="editor-actions"><button class="primary" type="button">Save policy</button><button class="secondary" type="button">Pause agent</button><button class="danger-button" type="button">Revoke session</button></div></section></div></main>{footer()}<script src="../../live.js"></script></body></html>'''

def signer(d):
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orrery · Signer</title><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="site.css"></head><body class="product-page {d['object']}">{nav(d,'Signer')}<main class="signer-main"><div class="signer-top"><p class="section-kicker">Public signer record</p><h1>0x7B42…9aE1</h1><p>The payment address for Atlas. Its current authority is visible here.</p></div><div class="signer-layout"><section class="signer-overview"><div class="overview-head"><span class="big-symbol">✓</span><div><span class="status-label">Active</span><h2>Policy in force</h2><p>Endpoints live · Last check <span class="last-check">just now</span></p></div></div><dl class="identity-list"><div><dt>Agent</dt><dd>Atlas</dd></div><div><dt>Account</dt><dd>0x93A1…fF20</dd></div><div><dt>Signer</dt><dd>0x7B42…9aE1</dd></div><div><dt>Increase delay</dt><dd>1 hour</dd></div></dl><button class="primary" type="button">Request signed check</button></section><section class="signer-caps"><div class="row-heading"><h2>Current caps</h2><span>USDG</span></div><div class="cap-row"><span>Per payment</span><strong>10 USDG</strong></div><div class="cap-row"><span>Per day</span><strong>50 USDG</strong></div><div class="cap-row"><span>Float ceiling</span><strong>20 USDG</strong></div><div class="cap-row"><span>Spent today</span><strong>12.40 USDG</strong></div><div class="spend-track"><i></i></div><div class="targets"><h3>Allowed calls</h3><div class="target-row"><span class="target-art">⌁</span><div><strong>Payment router</strong><small>0x6A12…c941 / pay(bytes)</small></div></div></div></section></div><div class="signer-bottom"><span>Bound account confirmed</span><span>Policy expiry · 31 Dec 2027</span><span>Last check · <span class="last-check">just now</span></span></div></main>{footer()}<script src="../../live.js"></script></body></html>'''

def tokens(d):
    return f'''/* {d['name']} design tokens */
:root {{
  --ground-light:{d['light']}; --ground-dark:{d['dark']}; --ink:{d['ink']}; --brand:{d['brand']}; --brand-on:{d['on']};
  --success:{d['success']}; --warning:{d['warning']}; --danger:{d['danger']}; --hairline:{d['hair']};
  --display:"{d['display']}",sans-serif; --text:"{d['text']}",sans-serif; --mono:"{d['mono']}",monospace;
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:24px; --space-6:32px; --space-7:48px; --space-8:64px; --space-9:96px;
  --radius-sm:4px; --radius-md:12px; --radius-lg:28px; --radius-nav:30px;
  --shadow-nav:0 12px 35px rgba(0,0,0,.14); --shadow-object:0 36px 80px rgba(0,0,0,.28); --shadow-paper:14px 20px 0 rgba(0,0,0,.09);
  --motion-fast:160ms; --motion-base:360ms; --motion-slow:900ms; --ease-out:cubic-bezier(.2,.8,.2,1); --ease-in-out:cubic-bezier(.65,0,.35,1);
  --font-hero:clamp(3.1rem,6.2vw,6.5rem); --font-h2:clamp(2.3rem,4vw,4.5rem); --font-h3:clamp(1.4rem,2vw,2rem); --font-body:1.06rem; --font-small:.84rem;
}}
[data-theme="dark"] {{ --page-ground:var(--ground-dark); --page-ink:var(--ground-light); --page-hairline:color-mix(in srgb,var(--ground-light) 28%,transparent); }}
[data-theme="light"] {{ --page-ground:var(--ground-light); --page-ink:var(--ink); --page-hairline:var(--hairline); }}
@media(max-width:600px) {{ :root {{ --font-hero:clamp(2.8rem,11vw,4.4rem); --font-h2:2.5rem; --font-h3:1.5rem; --font-body:1rem; --font-small:.8rem; --space-9:64px; }} }}
'''

def style_guide(d):
    notes={'gauge':'A large machined dial rises from behind the check widget. Pointer movement rotates the needle by a few degrees; scroll moves the dial in depth. The ticked spend value and validity timer update visibly.','seal':'Two overlapping sheets and an embossed wax seal make the signed answer the hero object. Pointer movement tilts the paper; scroll lifts the top sheet. The check widget remains separate and live.','circuit':'Three electric traces converge on a physical limiter. A packet moves through the trace; pointer position offsets the gate and scroll shifts its depth. Motion stops off screen.'}
    diff={'gauge':'The rejected Agent Console used a flat terminal and thin monospaced headline. Needlehouse uses a full machined dial, a heavy condensed display, dense instrument readings, and warm red limit marks.','seal':'The rejected Notary Vault used a single flat report on a brown ground. Red Seal uses layered paper, an embossed seal, a dramatic serif headline, a cream opening, and a real live check beside the certificate.','circuit':'The rejected Signal Grid and Lattice Field used quiet line geometry. Current Limit makes the circuit itself a large physical gate with moving payment current, bold rounded type, and cobalt on a pale ground.'}
    return f'''# {d['name']}

**Register:** {d['register']}

## Palette

| Token | Hex | Role |
| :--- | :--- | :--- |
| Ground light | `{d['light']}` | Reading sections and product workspaces |
| Ground dark | `{d['dark']}` | Mechanism and closing section |
| Ink | `{d['ink']}` | Text on light ground |
| Brand | `{d['brand']}` | Primary action and the second hero line |
| Brand on | `{d['on']}` | Primary button label |
| Success | `{d['success']}` | Active policy and live endpoint |
| Warning | `{d['warning']}` | Pending increases |
| Danger | `{d['danger']}` | Revoke and cap marks |
| Hairline | `{d['hair']}` | Rules and table separators |

## Type

Display: **{d['display']}** 700 for hero and 600 for section headings. Text: **{d['text']}** 400 for prose, 700 for controls. Mono: **{d['mono']}** 500 for addresses, values, timers, and code. Desktop hero `clamp(3.1rem, 6.2vw, 6.5rem)`, H2 `clamp(2.3rem, 4vw, 4.5rem)`, H3 `clamp(1.4rem, 2vw, 2rem)`, body `1.06rem`, small `.84rem`. Mobile hero `clamp(2.8rem, 11vw, 4.4rem)`, H2 `2.5rem`, H3 `1.5rem`, body `1rem`, small `.8rem`. Figures use tabular numerals.

## Geometry and depth

Spacing scale: `4, 8, 12, 16, 24, 32, 48, 64, 96px`. Radii: small `4px`, medium `12px`, large `28px`, floating nav `30px`. Shadows: nav `0 12px 35px rgba(0,0,0,.14)`; object `0 36px 80px rgba(0,0,0,.28)`; paper `14px 20px 0 rgba(0,0,0,.09)`. Use rules for dense data and shadow only to separate physical layers.

## Signature object and motion

{notes[d['object']]} Interaction: `160ms` for controls, `360ms` for state shifts, `900ms` for the artifact, ease `cubic-bezier(.2,.8,.2,1)` out and `cubic-bezier(.65,0,.35,1)` in-out. The dark mechanism uses a moving line that traces operator caps, agent payment, merchant lookup, and signed answer. Pause off screen with IntersectionObserver. Under `prefers-reduced-motion`, all decorative motion stops; timers and status text still update.

## Component anatomy

- **Nav:** rounded floating rail, typeset wordmark, three text links, X link, neutral Connect wallet control. On mobile, keep the wordmark and wallet action visible; move links to a second row.
- **Buttons:** one brand fill for the primary action, clear text link or outlined secondary, distinct danger treatment for revoke. Minimum 44px hit area.
- **Inputs:** label above, value in a sturdy field, units inside or beside the control; focus ring uses brand colour. Number fields are explicit about per payment, per day, and float.
- **Policy editor rows:** token identity at left; three aligned cap fields; target list and policy timing below. Spend today has a proportional bar against the daily cap.
- **Check result:** paying address at the top; effective status and endpoint liveness next; caps in one readable cluster; signed state and validity timer at the foot.
- **Data tables:** open rows separated by hairlines, left aligned labels and right aligned tabular values. Avoid identical bordered cells.
- **Toasts:** compact single line with an icon, action, and semantic status colour. Announce via a polite live region.
- **Wallet connect:** label exactly “Connect wallet”, no wallet logo, neutral surface until connected.

## Iconography and card art

Use simple custom SVG or CSS symbols with a consistent 2px stroke. Never substitute unrelated crypto icons. Every feature card gets its own constructed art: cap bars, time device, and scoped target. Art grows from the card's content and shares the hero object's material. Keep the object dominant; supporting cards have varied size and composition.

## Copy voice

Short, concrete, and operator readable. Name the address, cap, or check.

1. “Set the range your agent can spend.”
2. “The paying address resolves to its policy.”
3. “12.40 of 50 USDG spent today.”
4. “An increase is ready in 42 minutes.”
5. “The signed check is ready.”

## Do and do not

Do give amounts units, show the current status, and make the signed check traceable to the payer. Do keep brand colour focused on the primary action. Do not invent adoption statistics, use token-style branding, fill the page with generic status pills, or repeat a closing CTA headline.

## Distinction from rejected Oraqle themes

{diff[d['object']]}

## No-slop count

`index.html`: **1**. The required rounded floating nav is the one kit tell. The whole second headline line carries the accent, rather than one accent word. There are no KPI tile rows, generic bordered card grids, unmotivated textures, or closing repeat CTA.
'''

for d in DIRS:
    folder=ROOT/'directions'/d['slug']
    folder.mkdir(parents=True,exist_ok=True)
    # Landing pages and their style guides are authored separately per direction.
    # This utility only refreshes the shared supporting product screens and tokens.
    for name,content in [('app.html',app(d)),('signer.html',signer(d)),('tokens.css',tokens(d))]:
        (folder/name).write_text(content)
