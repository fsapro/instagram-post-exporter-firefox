# Instagram Post Exporter (Firefox)

A small, local-only Firefox WebExtension. It adds an **"Export"** button
next to every post/reel's save (bookmark) icon it can find — on a direct
post page (`/p/...`, `/reel/...`), where it's always present, *and* on the
home feed, a profile grid, saved posts, etc., one button per post card as
you scroll. Clicking a button saves that specific post's URL, shortcode,
export date, (best-effort) post date, and visible description/caption,
plus its images, in one of two formats (configurable in the extension's
**options page**):

- **ZIP** (default) — a `.zip` download containing:
  ```
  instagram-post-<shortcode>.zip
  ├── images/
  │   ├── 01.jpg
  │   └── 02.jpg
  └── post.md
  ```
- **Embedded Markdown** — a single `instagram-<post|reel>-<shortcode>.md`
  file per post, with every carousel image inlined directly inside it as a
  base64 `data:` URI (no separate image files, no `.zip`), written straight
  into a subfolder of Firefox's downloads directory that you choose once in
  the options page.

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
- **Minimal permissions.** `storage` (remembers your export-mode/subfolder
  choice) and `downloads` (only used in "Embedded Markdown" mode, to save a
  file directly — see below) are the only WebExtension permissions
  requested, alongside `host_permissions` for instagram.com and its two
  image CDN domains. No `tabs`, no `<all_urls>`, no analytics SDK.

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
- **Permanent install on regular release Firefox:** get the package signed
  by Mozilla — see "Signing for permanent self-install" below.

## Signing for permanent self-install (any Firefox, no dev flags)

This gets you a `.xpi` that installs permanently via "Installer un module
depuis un fichier…" on **any** Firefox — release included — with no
`about:config` changes, because it's actually signed by Mozilla. It's the
**unlisted/self-distribution** channel: Mozilla runs an automated
security scan (usually a few minutes, no human review), but the add-on is
never listed or searchable on addons.mozilla.org — only people you give
the `.xpi` file to can install it.

1. **Create/log into a Firefox Account** at
   [addons.mozilla.org](https://addons.mozilla.org) if you don't have one.
2. **Generate API credentials**: go to the
   [Developer Hub API keys page](https://addons.mozilla.org/developers/addon/api/key/)
   and generate a JWT issuer (`API key`) + `API secret`. Keep the secret
   private — treat it like a password, don't commit it anywhere.
3. **Sign and submit**:
   ```bash
   npm install
   npm run sign -- --api-key=YOUR_JWT_ISSUER --api-secret=YOUR_JWT_SECRET
   ```
   This uploads the package for Mozilla's automated review and, once
   approved, downloads the signed `.xpi` into `web-ext-artifacts/`.
4. **Install it**: `about:addons` → gear icon → **"Installer un module
   depuis un fichier…"** → select the signed `.xpi`. Installs permanently,
   survives restarts, no signing workaround needed.

To update later: bump `"version"` in `manifest.json` and `package.json`,
then re-run `npm run sign -- ...` — each signed version needs a
higher version number than the last.

## Usage

1. Browse Instagram normally — the home feed, a profile, a direct post
   (`https://www.instagram.com/p/<shortcode>/`) or reel page, saved posts,
   etc.
2. A small pink/purple **"Export"** button appears next to each post's
   save/bookmark icon:
   - On a direct post/reel page, the button for that post is always
     present — if its icon can't be located or is scrolled out of view, it
     falls back to a fixed position in the bottom-right corner instead of
     disappearing.
   - Everywhere else (feed, profile grid, saved posts…), every post card
     the extension recognizes (an image plus a like/comment/share/save icon
     row) gets its own button, anchored next to that post's icon. It
     follows the post as you scroll and hides while the post is off screen
     — grid thumbnails and sidebar widgets don't expose enough of an
     action-icon row to qualify, so they're skipped.
3. Click a button. It shows "Exporting…" while it fetches that post's
   visible images, then either downloads a `.zip` or saves a `.md` directly,
   depending on the export mode set in the options page (gear icon on
   `about:addons` → this extension → **Options**, or `about:addons` →
   ⚙ → *Gérer l'extension* → *Préférences*).

## Options page

Open it from `about:addons` (find "Instagram Post Exporter" → the "…" menu
or gear icon → **Options**/**Préférences**), or via `npm run start` which
opens Firefox with the extension already loaded. Two settings:

- **Export mode** — `ZIP` (default, unchanged from before) or
  `Embedded Markdown` (single `.md` per post, images inlined as base64).
- **Subfolder** — only used in Embedded Markdown mode: the name of a
  subfolder under Firefox's downloads directory to write directly into
  (default `InstagramExports`). See "Known limitations" below for why this
  can't be an arbitrary folder anywhere on disk.

## Local testing (no real Instagram access needed)

This repo includes two ways to exercise the code without touching
instagram.com:

```bash
npm install
npm test          # runs node:test unit tests against src/zip.js, markdown.js, instagramExtractor.js, settings.js
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

- **Carousel posts:** Instagram typically virtualizes a carousel — only the
  current slide plus one neighbor are ever mounted in the DOM at once,
  unmounting earlier slides as you swipe further. Rather than reading the
  DOM only once at click time (which could then never see more than ~2
  slides no matter how much of the carousel you'd actually viewed), the
  extension accumulates every image it has seen for a post since its
  button first appeared, refreshed both on a 1s poll and immediately on
  any DOM change (via a `MutationObserver`) — so slides you swiped past
  earlier are still included even after Instagram removes them from the
  DOM. It still never auto-advances the carousel itself or clicks/scrolls
  anything on your behalf (that would be automated interaction beyond
  reading visible content) — so a slide you never actually viewed while
  the post was open still won't be included, and if you export within the
  same second the post first loads (before having looked at any slide but
  the first), you may only get 1 image. The button's label after exporting
  always shows the count it found (e.g. "Exported ✓ (3 images)"), so you
  can tell at a glance if it came up short and, if so, browse through the
  remaining slides and export again — the count will include everything
  seen across both attempts as long as the post's button hasn't
  disappeared (e.g. from scrolling far away) in between.
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
  (e.g. a stripped-down layout) won't get a button — except the direct
  post/reel page's own post, which always gets one regardless (see Usage).
- **No arbitrary folder picker:** Firefox WebExtensions have no API to let
  the user pick an arbitrary folder anywhere on disk and then write to it
  silently (the File System Access API's `showDirectoryPicker()` isn't
  implemented in Firefox, unlike Chromium browsers). "Embedded Markdown"
  mode's destination is therefore limited to a subfolder *name* under
  Firefox's own downloads directory (configured in the options page), not a
  full path — `browser.downloads.download()` is the only way to write a
  file without a "Save As" dialog popping up on every single export.

## Future improvements

- Optional video export for reels.
- More options: image format/quality for embedded mode, filename pattern.
- Better carousel handling (export only slides the user has actually viewed,
  with a clear count in `post.md`).
- Localized UI strings.
- Packaging/signing for permanent installation via addons.mozilla.org.

## License

MIT
