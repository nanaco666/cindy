# Slogan / Wordmark Defringe Evidence

2026-07-21 targeted fix for the #F1F0F1 matte fringe left by the prior exact color-key transparency pass. Scope covers both user-pointed assets: slogan and wordmark, across desktop and mobile.

Method: deterministic Node stdlib PNG pass (`scripts/defringe-login-assets.mjs`). For each opaque edge pixel it solves the matte blend `C = alpha * ink + (1 - alpha) * #F1F0F1`, rewrites the pixel to clean ink RGB plus reconstructed alpha, and does not erode, choke, quantize, or hard-threshold the edge. Fully opaque non-edge pixels keep RGB byte-for-byte.

Raw-source check: Figma `368:1394` exposes the slogan as transparent SVG / 455x131 natural PNG, but the MCP screenshot endpoint does not upscale to the required desktop 2x and mobile 3x outputs. Figma `368:1381` exposes the wordmark source bitmap as 4096x1399, whose aspect ratio differs from the 423x145 node by about 0.36%, so using it would reintroduce crop/alignment risk. The repair therefore uses the deterministic defringe fallback.

Unified-master chain: the same script generates a canonical PNG per resolution group, then writes the exact encoded bytes to every same-resolution desktop/mobile target. `wordmark-423x145-unified` uses desktop `wordmark.png` as the canonical input and writes the same output to mobile `login-wordmark@2x.png`; `slogan-455x131-unified` uses desktop `slogan.png` and writes the same output to mobile `login-slogan@2x.png`. Other density files remain distinct because their consuming resolutions differ.

Preview files use four columns: original on `#2A2828`, fixed on `#2A2828`, original on mid-gray, fixed on mid-gray.

The raw PNG alpha sum drops because the previous files encoded antialiased fringe as fully opaque pixels. The no-weight-change check compares mathematically inferred alpha coverage before the rewrite with actual alpha coverage after the rewrite. Stroke widths are sampled with the same inferred-alpha model at threshold 16.

| Target | Matte-like fringe | Nonzero-alpha pixels | Inferred alpha delta | Sampled width | Semi-alpha levels after | Full-alpha RGB max delta |
|---|---:|---:|---:|---|---:|---:|
| desktop-wordmark-1x | 459 -> 0 | 34640 -> 34640 | 0% | unchanged | 246 | 0 |
| desktop-wordmark-2x | 1467 -> 0 | 135811 -> 135811 | 0% | unchanged | 254 | 0 |
| desktop-slogan-1x | 628 -> 0 | 5447 -> 5447 | 0% | unchanged | 32 | 0 |
| desktop-slogan-2x | 1260 -> 0 | 19253 -> 19253 | 0% | unchanged | 32 | 0 |
| mobile-wordmark-2x | 241 -> 0 | 34422 -> 34640 | 0.012% | unchanged | 246 | 0 |
| mobile-wordmark-3x | 565 -> 0 | 76694 -> 76694 | 0% | unchanged | 245 | 0 |
| mobile-slogan-2x | 628 -> 0 | 5447 -> 5447 | 0% | unchanged | 32 | 0 |
| mobile-slogan-3x | 933 -> 0 | 11314 -> 11314 | 0% | unchanged | 34 | 0 |

The `mobile-wordmark-2x` nonzero-alpha count increases by 218 pixels only because it now shares the byte-identical desktop 423x145 master; those pixels are low-alpha antialias coverage, with inferred alpha coverage delta 0.012% (<0.5%) and unchanged sampled stroke width.

| Unified group | Targets | SHA256 |
|---|---|---|
| wordmark-423x145-unified | `apps/desktop/src/renderer/assets/login/wordmark.png`<br/>`apps/mobile/assets/login/login-wordmark@2x.png` | `924788e60f82db2ab3403960402787582aa014bb41fcdb1e1e4d2c555fa31724` |
| slogan-455x131-unified | `apps/desktop/src/renderer/assets/login/slogan.png`<br/>`apps/mobile/assets/login/login-slogan@2x.png` | `11f002d286074c6d59db68085e4167342516096fc51a13d065c21181d1bf7716` |

Hero assets were inspected only, not changed. Exact transparent #F1F0F1 pixels and exact visible #F1F0F1 pixels are both 0 for all desktop, phone, and tablet hero PNGs listed in `defringe-report.json`.
