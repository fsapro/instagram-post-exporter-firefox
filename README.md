# Instagram Post Exporter (Firefox)

A small, local-only Firefox WebExtension. It adds an **"Export ZIP"** button
next to every post/reel's save (bookmark) icon it can find — on a direct
post page (`/p/...`, `/reel/...`), *and* on the home feed, a profile grid,
saved posts, etc., one button per post card as you scroll. Clicking a
button saves that specific post to your computer as a ZIP file containing:

```
instagram-post-<shortcode>.zip
├── images/
│   ├── 01.jpg
│   └── 02.jpg
└── post.md
```

`post.md` contains the post URL, shortcode, export date, (best-effort) post
date, and the visible description/caption.

## Scope & privacy

- **Local browser only.** Everything runs in your browser tab. There is no
  companion server, no analytics, no telemetry.
- **No scraping.** The extension only reads the DOM of posts already
  rendered on the page you have open (whether that's one post's own page or
  several post cards loaded in your feed as you scroll) — it never visits
  other pages, fetches additional posts, or paginates through anything
  itself.
- **No Instagram automation.** It never logs in, clicks, scrolls, or
  interacts with Instagram on your behalf. The only action is reading the
  page you opened and, when you click the button, fetching the exact image
  URLs already rendered on that page.
- **No login/anti-bot/rate-limit bypass.** The extension does not touch
  cookies, sessions, or private/gated content beyond what your own logged-in
  browser session already renders on screen.
- **Visible content only.** It exports what's currently visible/rendered in
  the active tab, nothing fetched from Instagram's private APIs.

See [docs/technical-notes.md](docs/technical-notes.md) for implementation
details and known limitations.

## Install (temporary, for development/testing)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **"Load Temporary Add-on…"**.
3. Select the [`manifest.json`](manifest.json) file in this repository.
4. The extension is now active until you restart Firefox (temporary add-ons
   are removed on browser restart — reload it the same way if needed).

Alternatively, using [web-ext](https://github.com/mozilla/web-ext) (installed
as a dev dependency, see below):

```bash
npm install
npm run start
```

This launches a Firefox instance with the extension pre-loaded.

## Install from a packaged file ("Installer un module depuis un fichier…")

To get a `.zip`/`.xpi` you can hand to Firefox's **Modules complémentaires**
page (gear icon → **"Installer un module depuis un fichier…"**):

```bash
npm install
npm run build
```

This produces `web-ext-artifacts/instagram_post_exporter-<version>.zip`.

**Signing caveat:** release/beta Firefox only installs extensions from that
dialog if they're signed by Mozilla (`xpinstall.signatures.required` is
`true` by default), so a locally built package will normally be rejected
as "corrompu"/unverified there. Two ways around that, depending on what you
have:

- **Firefox Developer Edition, Nightly, or ESR:** go to `about:config`, set
  `xpinstall.signatures.required` to `false`, then use "Installer un module
  depuis un fichier…" with the built `.zip`/`.xpi` — it installs
  permanently (survives restarts) and updates whenever you rebuild.
- **Any Firefox (including regular release):** use the temporary-install
  flow above instead (`about:debugging#/runtime/this-firefox` → *Load
  Temporary Add-on…*, selecting `manifest.json` directly, no build step or
  signing needed) — the only downside is it's removed on browser restart.
- **Permanent install on regular release Firefox:** submit the built
  package to [addons.mozilla.org](https://addons.mozilla.org) for Mozilla
  to sign (self-distribution or public listing); out of scope for local
  development/testing.

## Usage

1. Browse Instagram normally — the home feed, a profile, a direct post
   (`https://www.instagram.com/p/<shortcode>/`) or reel page, saved posts,
   etc.
2. For every post card the extension recognizes (an image plus a
   like/comment/share/save icon row), a small pink/purple **"Export ZIP"**
   button appears just to the left of that post's save/bookmark icon. It
   follows the post as you scroll and disappears while the post is off
   screen.
3. Click it. The button shows "Exporting…" while it fetches that post's
   visible images, then your browser downloads
   `instagram-<post|reel>-<shortcode>.zip`.

Only real post/reel cards get a button — grid thumbnails (e.g. a profile's
grid view) and sidebar widgets don't expose enough of an action-icon row to
qualify, so they're skipped.

## Local testing (no real Instagram access needed)

This repo includes two ways to exercise the code without touching
instagram.com:

```bash
npm install
npm test          # runs node:test unit tests against src/zip.js and src/markdown.js
npm run lint       # runs `web-ext lint` against the manifest/extension source
```

There's also [`test/fixture.html`](test/fixture.html) — a static page with a
fake Instagram-like post structure (offline data-URI images, a caption, a
timestamp). Open it directly in Firefox (or via `npm run start` and then
navigating to the file), click **"Run export test"**, and confirm a ZIP
downloads containing `images/` and `post.md`. This exercises the same
`instagramExtractor.js` / `markdown.js` / `zip.js` / `download.js` modules
the real content script uses, entirely locally.

To confirm it also works on real Instagram, load the extension (see
"Install" above) and visit any public post you already have open in your
logged-in session.

## Known limitations

- **Carousel posts:** every slide Instagram has already rendered into the
  DOM is exported (including off-screen ones, and lazy-loaded slides that
  only expose a `data-src`/`data-srcset` attribute so far) — see
  `test/fixture.html` for a worked 3-slide example. The extension does not
  auto-advance the carousel or scroll/click to force additional slides to
  render (that would be automated interaction beyond reading visible
  content), so a slide Instagram hasn't rendered at all yet may still be
  missing.
- **Post date:** Instagram doesn't always expose a machine-readable
  timestamp in the visible DOM. When it's not available, `post.md` records
  `post_date: "not available in visible page"`.
- **Video/reel content:** only the visible preview image(s) are exported,
  not video files.
- **DOM fragility:** Instagram's class names are generated/hashed and change
  frequently, so extraction relies on structural heuristics (tag names,
  roles, `srcset`, `og:description`) rather than fixed class names. Instagram
  layout changes may require selector updates over time.
- **Button placement:** the button anchors to the save/bookmark icon's
  position, found by matching its `aria-label` against a handful of known
  translations (English, French, Spanish, Portuguese, German, Italian) with
  a same-row-icon fallback. In another UI language, or if Instagram
  restructures the action row, the button may anchor to the wrong icon or
  not appear at all for that post — other posts are unaffected.
- **Post-card detection:** a card needs both an image and 3+ labeled icons
  to be recognized as an exportable post (filters out grid thumbnails and
  sidebar widgets). A post Instagram renders without that many icons
  (e.g. a stripped-down layout) won't get a button.

## Future improvements

- Optional video export for reels.
- A settings/options page (e.g. choose image format, filename pattern).
- Better carousel handling (export only slides the user has actually viewed,
  with a clear count in `post.md`).
- Localized UI strings.
- Packaging/signing for permanent installation via addons.mozilla.org.

## License

MIT
