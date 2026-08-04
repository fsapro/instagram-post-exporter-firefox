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

- **Shortcode/type** — parsed from the post's own URL: either an in-card
  permalink (`findPostPermalink()`, feed cards) or `location.href` (direct
  post pages).
- **Post root** — for feed/multi-post scanning, the `<article>` element
  itself is passed directly as the extraction root (see "Multi-post
  scanning" below). `findPostRoot()` (`main article`, falling back through
  a few structural selectors down to `document.body`) exists as a
  single-post fallback used by `test/fixture.html`'s manual test harness.
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
  non-trivial), the first `<li>` (inside a `<ul>`) whose full text is
  long enough to be a caption rather than a like-count/timestamp, then the
  page's own `meta[property="og:description"]` tag, then `document.title`.
  All of these are part of the single document already loaded in the tab —
  no extra request is made to obtain any of them.
  - The `<h1>`/`<li>` candidates are read with `getTextWithLineBreaks()`,
    not `.textContent`. Two real bugs this fixes: (1) `.textContent`
    silently drops `<br>` entirely (contributes zero characters, so "Line
    1<br>Line 2" becomes "Line 1Line 2" with no separator at all) — this
    is why an earlier version of this extractor lost line breaks in
    multi-line captions; (2) an earlier version returned as soon as it
    found *one* `<span>` with enough text, which only grabs one fragment
    of a caption Instagram splits across several sibling
    spans/links (e.g. around hashtag/mention `<a>` tags) — now the full
    `<li>` text is read instead, concatenating every fragment.
    `normalizeCaptionText()` then trims each line and collapses 3+ blank
    lines down to one. `markdown.js`'s `formatMultilineForMarkdown()`
    turns each `\n` into a Markdown hard break (`  \n`) when building
    `post.md`, since a bare `\n` is just a soft break most renderers
    collapse to a space.
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
- `findSaveButtonAnchor()` (used purely to position the button, never
  clicked) matches an icon's `aria-label` against a small list of known
  translations for "save" (`enregistrer`, `save`, `guardar`, `salvar`,
  `speichern`, `salva`) since Instagram's UI language doesn't always match
  the post's own content language; if none match, it falls back to the
  last `svg[aria-label]` in the post (save/bookmark is conventionally the
  rightmost icon in the action row). In an unlisted UI language with an
  unusual icon order, this can anchor to the wrong icon.
- `looksLikePostArticle()` (an image + 3 or more labeled icons) is a
  coarse filter to distinguish real post cards from other `<article>`-
  wrapped widgets Instagram may render (e.g. suggested-accounts rails). A
  post rendered with fewer than 3 icons in some alternate layout would be
  skipped entirely.

## Multi-post scanning: one button per post card

The extension doesn't gate on the page URL at all — `manifest.json`'s
`content_scripts.matches` covers the whole `instagram.com` origin, and
`content.js` continuously scans the DOM for `<article>` elements that look
like real post/reel cards (`extractor.looksLikePostArticle()`: has an
`<img>` and a 3+ icon action row), giving each one its own button. This
covers a direct `/p/`/`/reel/` page (exactly one matching article) and the
home feed / a profile's tagged or saved view / explore (potentially many,
loaded incrementally as the user scrolls) with the same code path — there's
no special-casing of "am I on a post page."

- `scanForPosts()` finds not-yet-seen articles (tagged with a
  `data-ig-exporter-processed` attribute once handled), creates a button
  for each, and drops buttons whose article has since left the DOM (e.g. a
  virtualized feed item Instagram unmounted after scrolling far past it).
- Each button is a direct child of `document.body`, not of the article —
  this keeps it outside Instagram's own React tree (so a re-render of the
  post card can't wipe it out) and immune to any CSS `transform` on
  ancestor elements, which would otherwise change what a `position: fixed`
  child is positioned relative to.
- `repositionButtonFor()` anchors each button next to its own post's
  save/bookmark icon (`extractor.findSaveButtonAnchor()`) using
  `getBoundingClientRect()`, and hides it (rather than falling back to some
  default position) whenever the anchor can't be found, isn't laid out yet,
  or has scrolled off-screen — with potentially many post cards on screen
  at once, a shared fallback position would just stack buttons on top of
  each other.
- Since Instagram keeps streaming in new cards and reflowing existing ones
  without a page reload, there's no one-time scan: a 1s poll re-scans for
  new articles and re-anchors every button, a `scroll` listener (capture
  phase, so it also catches nested scroll containers like the feed's own
  scroller or a post modal, since scroll events don't bubble) and a
  `resize` listener additionally trigger a `requestAnimationFrame`-throttled
  reposition pass for responsiveness during active scrolling.
- Clicking a button reads that specific `<article>` as the extraction root
  directly (`extractPostImages(document, article)`, etc.) — no need to
  locate "the current post" globally, since each button already knows which
  article it belongs to (closed over in its click handler).
- The post's own URL/shortcode/type come from a permalink link inside the
  card itself (`extractor.findPostPermalink()` — feed cards link to their
  own `/p/`/`/reel/` URL, typically via the timestamp, even though the
  address bar stays on the feed URL) with a fallback to `location.href` for
  the case where the card has no such in-card link (typically because the
  address bar already *is* the permalink, i.e. a direct post page).

This replaces an earlier design that tracked a single global button gated
on `location.pathname` plus `history.pushState`/`replaceState` patching —
dropped once buttons became per-post-card rather than per-page, since path
tracking no longer has anything to do with whether/where a button should
exist.

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
- `test/instagramExtractor.test.js` (Node, `node:test`): unit tests for the
  pure DOM-reading helpers (`extractShortcode`/`extractType`, `parseSrcset`,
  `resolveBestImageSrc`, `isLikelyContentImage`, `findSaveButtonAnchor`,
  `looksLikePostArticle`, `findPostPermalink`) against minimal hand-built
  fake DOM objects (just enough `getAttribute`/`querySelector(All)`/
  `closest` stand-ins for each function under test) — no real DOM or jsdom
  dependency needed.
- `test/fixture.html`: a static page with a hand-built, IG-like DOM (a
  3-slide carousel including a lazy-loaded slide, a caption `<h1>`, a
  simulated like/comment/share/save action row, a `<time datetime>`
  element, and an `og:description` meta fallback). Opening it in Firefox:
  "Run export test" exercises `instagramExtractor.js`, `markdown.js`,
  `zip.js`, and `download.js` together end-to-end, entirely offline;
  "Preview anchored button position" exercises the same button-positioning
  math `content.js` uses against the fixture's action row. Neither ever
  contacts instagram.com. (`content.js` itself isn't loaded by the fixture,
  since its multi-post scanning is easiest to verify live in a real
  browser — see "Real-Instagram verification" below.)
- `npx web-ext lint` validates `manifest.json` and flags common WebExtension
  packaging issues.

Real-Instagram verification (a logged-in user opening an actual post and
clicking the button) is left to manual testing, since it requires a live,
authenticated session that shouldn't be automated.
