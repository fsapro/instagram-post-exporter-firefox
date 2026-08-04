# Technical notes

## Overview

The extension is a plain Manifest V3 WebExtension with a single content
script pipeline injected on `https://www.instagram.com/p/*` and
`https://www.instagram.com/reel/*`. There is no background script, no
options page, and no build step — every file under `src/` is loaded as-is
by the browser.

```
manifest.json
src/
  zip.js                  -> IGExporter.zip        (ZIP writer)
  markdown.js              -> IGExporter.markdown    (post.md builder)
  instagramExtractor.js    -> IGExporter.extractor   (DOM reading)
  download.js               -> IGExporter.download    (save-as-file)
  content.js                (orchestrator, no exports — wires the above)
  styles.css
```

Each module (except `content.js`) attaches its public functions to a shared
`window.IGExporter` namespace *and* exports them via `module.exports` when
run under Node (guarded by `typeof module !== 'undefined'`). This lets the
exact same source files run unmodified both as browser content scripts (no
module loader — content scripts are plain classic scripts) and under
`node --test` for unit testing, with no build/bundle step either way.

## Why a hand-rolled ZIP writer instead of a library

`src/zip.js` implements just the ZIP subset needed here: local file headers,
a central directory, and an end-of-central-directory record, using the
**STORE** method (no compression). This is deliberate:

- The payload is almost entirely JPEG/WebP images, which are already
  compressed — DEFLATE would add CPU cost for negligible size savings.
- Avoiding a third-party dependency (e.g. JSZip) keeps the extension fully
  auditable from source, with no supply-chain surface and no license file to
  track — important for a browser extension that runs on every visit to a
  major site.
- The implementation is ~180 lines and independently unit-tested
  (`test/zip.test.js`) against a known CRC-32 test vector and by manually
  parsing the header fields of a generated archive.

## Why DOM-only extraction (no API calls)

Instagram's private GraphQL/API endpoints are intentionally **not** used.
Calling them would mean reverse-engineering authenticated, rate-limited,
anti-bot-protected endpoints — exactly what the project's constraints rule
out ("pas de scraping massif", "pas de contournement anti-bot / rate limit").
Instead, `instagramExtractor.js` only reads elements that are already
rendered in the page the user has open:

- **Shortcode/type** — parsed from `location.href`/`location.pathname`
  (`/p/<code>/` or `/reel/<code>/`).
- **Post root** — `main article`, falling back through a few structural
  selectors down to `document.body`.
- **Images** — every `<img>` inside the post root, filtered to drop obvious
  avatars/icons (small fixed dimensions, `alt` text matching "profile
  picture"), deduplicated by resolved URL. When an image has a `srcset`,
  the highest-width candidate is chosen. `parseSrcset()` walks the
  attribute value token by token (URL = next whitespace-delimited run,
  descriptor = up to the next un-parenthesized comma) rather than naively
  splitting on `,` — a plain comma-split misparses any candidate URL that
  itself contains a comma, such as a `data:` URI's `base64,` marker (see
  `test/instagramExtractor.test.js`).
  - **Carousel slides**: `querySelectorAll('img')` runs over the whole post
    subtree, so every slide a carousel has already rendered into the DOM is
    picked up, not just the currently on-screen one — Instagram carousels
    typically render every slide's `<img>` inside a horizontally-scrolling
    `<ul>`, they just aren't all visible on screen at once.
  - **Lazy-loaded slides**: `resolveBestImageSrc()`/`isLikelyContentImage()`
    also check `data-src`/`data-srcset` after `src`/`srcset`, since some
    lazy-loading implementations hold a not-yet-visible slide's real image
    URL there until it scrolls into view. Reading those attributes is still
    just reading DOM state that's already present — nothing is scrolled,
    clicked, or otherwise driven to force a slide that hasn't rendered at
    all yet to appear.
- **Description** — tries, in order: the post's `<h1>` (if present and
  non-trivial), the first sufficiently long `<span>` text inside a `<ul><li>`
  block that isn't a like-count/timestamp, then the page's own
  `meta[property="og:description"]` tag, then `document.title`. All of these
  are part of the single document already loaded in the tab — no extra
  request is made to obtain any of them.
- **Post date** — a `time[datetime]` element inside the post root, if
  present. Instagram does not always render this in a way that's reliably
  present in the DOM, so it's treated as best-effort and clearly labeled as
  such in `post.md` when missing.

### Why this is fragile, and why that's an accepted trade-off

Instagram ships CSS-module/hash-based class names that change on
deployment, so nothing here depends on a specific class name — only on tag
names, ARIA roles, and standard attributes (`srcset`, `alt`, `datetime`,
`og:description`). This is more resilient than hardcoding class names, but
it is still a heuristic reading of a third-party page's markup, so:

- Selector heuristics may need occasional updates as Instagram's markup
  evolves.
- The description-extraction fallback chain can occasionally pick the wrong
  text block on unusual layouts (e.g. a pinned comment) rather than the
  actual caption. The `og:description` meta fallback is the most stable
  signal when the structural heuristics fail.

## SPA navigation handling

Instagram is a single-page app: navigating from one post to another (e.g.
via the feed, or the "next" arrow) uses `history.pushState`/`replaceState`
and does not reload the page, so a content script matched only against
`/p/*`/`/reel/*` would never even get injected in the first place when a
user clicks into a post from the feed (browsers inject `content_scripts`
on document navigation, not on `pushState`). To avoid that cold-start gap,
`manifest.json`'s `content_scripts.matches` covers the whole
`instagram.com` origin, and `content.js` gates the button itself:

1. `isSupportedPath()` checks `location.pathname` against `/p/*`/`/reel/*`
   and `ensureButton()`/`removeButton()` add or remove the button
   accordingly — this runs once on script load, and again on every detected
   navigation.
2. `history.pushState`/`replaceState` are wrapped to detect path changes.
3. A `popstate` listener handles back/forward navigation.
4. `location.pathname` is also polled every second as a low-cost fallback,
   in case Instagram's router bypasses both of the above in some flow.

The button element is keyed by a fixed `id`, so re-running the check is
idempotent.

## Image fetching and permissions

Content-script `fetch()` calls are subject to the same CORS rules as the
page itself, **except** for origins covered by the extension's
`host_permissions` — for those, the browser grants the extension
cross-origin fetch access without needing the target server to send
CORS headers. Instagram serves post images from CDN domains distinct from
`instagram.com` (typically `*.cdninstagram.com` / `*.fbcdn.net`), so
`manifest.json` declares `host_permissions` for the `www.instagram.com` and
bare `instagram.com` origins plus those two CDN wildcard patterns — nothing
broader (no `<all_urls>`). Image fetches are made with `credentials: 'omit'`
since the CDN URLs are pre-signed and don't need cookies, and there's no
reason to send the user's Instagram session cookie to a third-party CDN
request.

Only those four `host_permissions` patterns are requested. No `permissions`
entries are needed at all — the extension never calls `browser.downloads`,
`browser.tabs`, or any other privileged WebExtension API; the content
script is injected purely via `content_scripts.matches`, and the file save
uses plain DOM APIs (see below).

## Triggering the download without a background script

Firefox content scripts do not have access to `browser.downloads` (that API
is only available to extension pages/background scripts). Rather than add a
background script purely to relay one message, `download.js` uses the
standard `URL.createObjectURL(blob)` + `<a download>` + synthetic `.click()`
pattern, which is ordinary DOM behavior available to any page/script and
requires no extra permission. The object URL is revoked after a delay to
avoid interrupting an in-progress save.

## Testing strategy

- `test/zip.test.js` (Node, `node:test`): validates CRC-32 against the
  standard `"123456789"` test vector, and manually parses a generated ZIP's
  local file header + EOCD record to confirm structural correctness.
- `test/markdown.test.js` (Node, `node:test`): validates `post.md` content
  generation, including the "missing description"/"zero images" fallback
  text.
- `test/fixture.html`: a static page with a hand-built, IG-like DOM
  (article, two content images as inline data URIs, one avatar image to be
  filtered out, a caption `<h1>`, a `<time datetime>` element, and an
  `og:description` meta fallback). Opening it in Firefox and clicking "Run
  export test" exercises `instagramExtractor.js`, `markdown.js`, `zip.js`,
  and `download.js` together, end-to-end, entirely offline — validating the
  full pipeline without ever contacting instagram.com.
- `npx web-ext lint` validates `manifest.json` and flags common WebExtension
  packaging issues.

Real-Instagram verification (a logged-in user opening an actual post and
clicking the button) is left to manual testing, since it requires a live,
authenticated session that shouldn't be automated.
