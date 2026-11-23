# Break the QR: Vandalise a Code to Learn How It Survives

**Global Virtual Hackathon 2026 · Theme: Unveiling Technology**

> Scribble on a QR code until it breaks, and see the hidden backup system that kept it alive until then.

A playful lab where you scribble on, cover and wreck QR codes to discover the hidden parts and the error correction that keeps them working. Plain HTML, CSS and JavaScript. No build step, no server, nothing uploaded.

## Run it

Open `index.html` through any static web server (the camera needs `https://` or `localhost`):

```bash
npm start          # serves on http://localhost:8080
# or: python -m http.server 8080
```

Run the tests (encoder correctness and meter vs jsQR):

```bash
npm test
```

## Deploy to GitHub Pages

1. Create a GitHub repository and push this folder to the `main` branch.
2. Open **Settings → Pages**, choose **Deploy from a branch**, then `main` and `/ (root)`.
3. The site goes live at `https://<user>.github.io/<repo>/`. `.nojekyll` is already included.

## The lab: the 8 stages from the concept

| # | Stage | Where |
|---|-------|-------|
| 1 | Make or scan | Tab **1 Make**: type text, choose L/M/Q/H and grid size, or scan with the camera / a photo (jsQR) |
| 2 | Layer view | Tab **2 Layers**: every module coloured by role, layers can be peeled away, tap any square for an explanation |
| 3 | Read order | Tab **3 Read order**: animated zig-zag path, codeword by codeword, with the letters each byte carries |
| 4 | Vandal mode | Tab **4 Vandalise**: brush, spray, emoji/logo stickers, cleaner, undo, plus real-world "accidents" (logo, coffee stain, torn corner…) |
| 5 | Damage meter | Always under the code: "6 of 8 repairable codewords used", per-block bars, our prediction next to the jsQR result |
| 6 | Break point | When decoding fails: BROKEN stamp, lost codewords flash red, plain-language reasons, lost letters struck out |
| 7 | Level switch | Tab **5 Levels**: your exact vandalism applied to L, M, Q and H side by side |
| 8 | Graffiti QR + safety | Tab **6 Graffiti**: colour swatches labelled "dark/light" as a scanner sees them, big view for phone scanning, PNG export, then **Check before you tap** with the Link X-ray |

Extras: X-ray view (damaged codewords and flipped squares), survival record per level, version explorer, research and references section.

## How it works

| File | Role | Written by |
|------|------|------------|
| `js/qr-core.js` | QR encoder (ISO/IEC 18004, byte mode, versions 1–10, all levels, all 8 masks) + **module role map** + **codeword map** | Team |
| `js/qr-damage.js` | **Damage meter**: samples the canvas, finds flipped modules, maps them to codewords, compares with each block's repair limit (backup ÷ 2), checks the eyes and format/version labels, writes plain-language reasons | Team |
| `js/app.js` | Canvas stage, layers, read-order animation, vandal tools, break point, level comparison, graffiti, camera | Team |
| `js/link-xray.js` | "Check before you tap" link inspector (general advice, not a security product) | Team |
| `vendor/jsQR.js` | Independent decoder used to double-check the meter (Apache-2.0) | Third party |
| Canvas API, getUserMedia | Drawing and camera | Browser (built in) |

On every stroke the stage composites the clean code with the vandal layer, samples the centre of every module (dark if luminance < 50%), and compares it with the original matrix. A codeword with any wrong module counts as damaged. A block survives while `damaged ≤ floor(backup / 2)`. The same image is then decoded by jsQR, so the meter is always checked against a real scanner.

**Verified:** `npm test` round-trips 323 codes (every version 1–10 × level × mask, all at full capacity) through jsQR, and in 600 random damage trials the meter's prediction matched jsQR every time.

## Limits we state openly

- The meter is a teaching model: real scanners can also fail from blur, glare or low contrast, which the app mentions but doesn't fully simulate.
- Damage is counted per codeword; in rare layouts the true decoder may behave slightly differently, which is why every result is double-checked with jsQR.
- Eye damage uses a simple rule; real finder detection is more subtle.
- No scanned content is uploaded or stored; camera frames stay on the device.
- The quishing tip is general safety advice, not a security product.

## Credits

jsQR © Cosmo Wolfe, Apache License 2.0 (`vendor/jsQR-LICENSE.txt`). QR Code is a registered trademark of DENSO WAVE INCORPORATED. Research references are listed on the site (APA 7).
