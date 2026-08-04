# Instagram Post Exporter (Firefox)

A small, local-only Firefox WebExtension. On an Instagram post (`/p/...`) or
reel (`/reel/...`) page, it adds an **"Export ZIP"** button. Clicking it saves
the currently open post to your computer as a ZIP file containing:

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
- **No scraping.** The extension only reads the DOM of the single post/reel
  page you already have open — it never visits other pages, other posts, or
  paginates through anything.
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

## Usage

1. Navigate to any Instagram post (`https://www.instagram.com/p/<shortcode>/`)
   or reel (`https://www.instagram.com/reel/<shortcode>/`).
2. A pink/purple **"Export ZIP"** button appears in the bottom-right corner.
3. Click it. The button shows "Exporting…" while it fetches the visible
   images, then your browser downloads `instagram-<post|reel>-<shortcode>.zip`.

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

- **Carousel posts:** only images currently present/loaded in the DOM are
  exported. The extension does not auto-advance carousel slides (that would
  be a form of automated interaction beyond reading visible content), so
  slides you haven't scrolled to may be missing.
- **Post date:** Instagram doesn't always expose a machine-readable
  timestamp in the visible DOM. When it's not available, `post.md` records
  `post_date: "not available in visible page"`.
- **Video/reel content:** only the visible preview image(s) are exported,
  not video files.
- **DOM fragility:** Instagram's class names are generated/hashed and change
  frequently, so extraction relies on structural heuristics (tag names,
  roles, `srcset`, `og:description`) rather than fixed class names. Instagram
  layout changes may require selector updates over time.

## Future improvements

- Optional video export for reels.
- A settings/options page (e.g. choose image format, filename pattern).
- Better carousel handling (export only slides the user has actually viewed,
  with a clear count in `post.md`).
- Localized UI strings.
- Packaging/signing for permanent installation via addons.mozilla.org.

## License

MIT
