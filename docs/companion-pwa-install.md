# Companion PWA install recipe

How a Companion becomes installable as a standalone app — Android Chrome's
"Install app" with a real home-screen icon, desktop Chrome's install chip, a
chrome-free window at the slender width. This is the configuration proven to
work end-to-end (Pixel, Android Chrome, 2026-07-18, memsum.ai/companion), and
the diagnosis method for when a deployment that "passes on paper" still isn't
offered an install. Written for any agent session working on a Sum-family
companion surface; it is deliberately product-neutral so it can be carried
into sibling repos.

## The proven configuration

All of it, not most of it. The failure mode that motivated this document was a
sibling companion that satisfied every *documented* Chromium criterion and
still got no install offer on the same phone that installed this one.

1. **HTTPS**, and the page serves 200 at a stable URL (no auth redirect away
   from the manifest-bearing route).
2. **A linked manifest**: `<link rel="manifest" href="…">` in the page head.
3. **Manifest fields**: `name` and `short_name`; `start_url` and `scope` set
   to the companion route (scoping matters — install from anywhere in the app
   should install the *companion*, not the whole site); `display:
   "standalone"`.
4. **Icons 192 and 512**, PNG, whose *actual pixel dimensions match the
   declared sizes*, with `"purpose": "any maskable"`. Maskable is what lets
   Android shape the icon natively (squircle/circle) instead of shrinking it
   onto a white plate. Caveat: maskable crops to the safe zone — the mark must
   sit within the inner ~80% of the canvas with a full-bleed background, or it
   gets clipped. If existing icon art runs to the edges, regenerate with
   padding before declaring maskable.
5. **`<meta name="mobile-web-app-capable" content="yes">`** — the standard
   form, not only the deprecated `apple-mobile-web-app-capable`. (Next.js
   emits it from `appleWebApp: { capable: true }` in the route's metadata.)
6. **Manifest MIME** `application/manifest+json` (Vercel serves
   `.webmanifest` correctly by default; a static host may need a header
   rule).
7. **Slender window size**: the manifest has no size field, so an installed
   app opens at whatever size the OS chooses. Snap it in the page script,
   guarded so it never fires in a browser tab or pop-out:

   ```js
   if (window.matchMedia("(display-mode: standalone)").matches) {
     window.resizeTo(440, 900);
   }
   ```

## What does NOT matter (verified 2026-07-18)

- **No service worker is required.** The installable deployment has none.
- **`Content-Disposition: inline; filename="…"`** on page, manifest, and icon
  responses is Vercel's ambient static-serving fingerprint. The installable
  deployment carries it too. Ignore it.
- Engagement heuristics, `orientation`, theme colors, `robots: noindex` — all
  present or absent on both sides of the working/failing pair without
  correlation.

Items 4 (maskable purpose) and 5 (the standard meta) were the *only* deltas
between the deployment that installed and the sibling that didn't — neither
appears in Chromium's documented install criteria, so treat this recipe as
empirical: converge on the whole proven configuration rather than reasoning
items away one at a time.

## Diagnosing a deployment that isn't offered install

Do this from any shell; it needs no phone and no DevTools.

```sh
# The page head: is the manifest linked? Which metas are present?
curl -s https://HOST/companion | grep -oE '<(meta|link)[^>]*>'

# The manifest, in full, plus its MIME:
curl -sI https://HOST/path/to/manifest.webmanifest | grep -i content-type
curl -s  https://HOST/path/to/manifest.webmanifest

# Real icon dimensions (PNG IHDR), not the declared ones:
node -e "const g=async u=>{const b=Buffer.from(await(await fetch(u)).arrayBuffer());console.log(u.split('/').pop(),b.readUInt32BE(16)+'x'+b.readUInt32BE(20))};g('https://HOST/icon-192.png');g('https://HOST/icon-512.png')"
```

Then diff every line against a deployment known to install. Trust the diff
over documentation: the documented criteria are necessary, not sufficient.

Automation caveat: probing `beforeinstallprompt` from an embedded/driven
Chromium is unreliable — automation contexts suppress install UI, so the
event firing on *neither* of two sites proves nothing about either.

## Retest protocol (Android)

Chrome caches per-origin install state, so after shipping a fix: visit the
page fresh, let it settle a few seconds, then ⋮ menu → **Add to Home screen**
→ expect **Install** (app semantics, custom icon) rather than **Create
shortcut**. If the offer still doesn't appear, Chrome → Settings → Site
settings → clear the origin's data, then revisit and check again before
concluding the fix failed.

## Drift pin

The suite pins this recipe to reality: the manifest's `display`, `start_url`,
`scope`, icon sizes and `"any maskable"` purpose, the layout's
`appleWebApp.capable` (which emits the standard meta), the guarded
`resizeTo`, and this document's load-bearing claims are asserted together in
`test/hosted.test.ts`, so the doc and the shipped configuration change in one
commit or the suite fails.

See `docs/companion.md` for what the Companion is and why it stays slender.
