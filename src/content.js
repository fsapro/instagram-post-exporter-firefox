/**
 * content.js
 *
 * Orchestrator that runs inside any instagram.com page. Scans the DOM for
 * post/reel cards (the home feed, a profile's tagged/saved view, etc. can
 * have many as the user scrolls) and gives each one its own "Export"
 * button, anchored next to that post's own save/bookmark icon. A direct
 * /p/ or /reel/ page is additionally guaranteed a button for its main post
 * even if the icon-row heuristic used for feed scanning doesn't match (see
 * ensurePrimaryPostButton) — and that button falls back to a fixed
 * bottom-right position instead of disappearing whenever its icon can't be
 * located or is scrolled out of view, since it's the one button that must
 * always be reachable.
 *
 * Clicking a button reads that specific post's already-rendered DOM,
 * fetches the bytes of its visible content images, and either (a) zips
 * post.md + images/ and downloads the .zip (default), or (b) — if the
 * user configured "embedded-md" mode in the options page — builds a
 * single .md with the images inlined as base64 data: URIs and saves it
 * directly into a subfolder of Firefox's downloads directory via the
 * background script (the only thing a content script can't do itself).
 *
 * Everything here operates on the single active tab's current document.
 * No other pages are visited, no Instagram interaction is simulated beyond
 * the user's own click on one of our buttons, and no requests are sent
 * anywhere other than to fetch the exact image URLs already present in the
 * DOM of the post being exported.
 */
(function () {
  'use strict';

  const PROCESSED_ATTR = 'data-ig-exporter-processed';

  /** Map<article-or-post-root element, { btn, isPrimary }> for every post card we've found. */
  const buttons = new Map();

  /**
   * Map<article, Map<url, {url, alt}>> — every content image seen so far
   * for each tracked post, accumulated across ticks rather than read fresh
   * only at export time. Instagram's carousel commonly virtualizes: it only
   * keeps the current slide plus one neighbor mounted in the DOM at once,
   * unmounting earlier slides as the user swipes further — so a single
   * snapshot at click time can never see more than ~2 slides, no matter how
   * much of the carousel the user has actually looked at. Since we already
   * poll the DOM once a second anyway, merging each tick's findings into a
   * running per-post set means anything the user has scrolled past is
   * still remembered even after Instagram removes it from the DOM.
   */
  const imageCache = new Map();

  function modules() {
    return window.IGExporter || {};
  }

  /** Merges any newly-visible images for `article` into its running cache. */
  function updateImageCache(article, extractor) {
    const found = extractor.extractPostImages(document, article);
    let seen = imageCache.get(article);
    if (!seen) {
      seen = new Map();
      imageCache.set(article, seen);
    }
    for (const img of found) {
      if (!seen.has(img.url)) seen.set(img.url, img);
    }
    return seen;
  }

  function isDirectPostPath(pathname) {
    return /^\/(p|reel)\/[^/]+\/?/.test(pathname);
  }

  /**
   * Resolves the URL/shortcode/type for a given post card. Feed cards carry
   * their own permalink (e.g. via the timestamp) even though the address
   * bar stays on the feed URL; a direct /p/ or /reel/ page generally
   * doesn't need one since the page URL already is the permalink.
   */
  function resolvePostContext(article, extractor) {
    const permalink = extractor.findPostPermalink(article);
    const url = permalink ? new URL(permalink, location.origin).href : location.href;
    return {
      url,
      shortcode: extractor.extractShortcode(url) || 'unknown',
      type: extractor.extractType(url),
    };
  }

  function setButtonState(btn, state, message, defaultLabel) {
    btn.disabled = state === 'busy';
    btn.classList.toggle('ig-exporter-btn--busy', state === 'busy');
    btn.classList.toggle('ig-exporter-btn--error', state === 'error');
    btn.textContent = message || defaultLabel;
  }

  async function fetchImageBytes(url) {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching image`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  function guessExtension(url) {
    const match = url.split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i);
    return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  }

  const MIME_BY_EXTENSION = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  function guessMimeType(url) {
    return MIME_BY_EXTENSION[guessExtension(url)] || 'image/jpeg';
  }

  /**
   * Encodes raw bytes as a data: URL via FileReader — not
   * `String.fromCharCode.apply(null, bytes)` + `btoa()`, which throws
   * "Permission denied to access property 'constructor'" in a Firefox
   * content script (an Xray-wrapper security restriction on spreading a
   * typed array through `Function.prototype.apply`). FileReader sidesteps
   * it entirely and needs no manual chunking for large images either.
   */
  function bytesToDataUrl(bytes, mimeType) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(new Blob([bytes], { type: mimeType }));
    });
  }

  /**
   * Sends a fully-built file to the background script to save via
   * browser.downloads. The text is sent as-is (structured clone handles
   * any Unicode content natively) rather than as a data: URL — Firefox's
   * downloads.download() rejects data: URLs when called from a background
   * script, so the background script builds a Blob + object URL itself
   * (see background.js).
   */
  async function saveFileDirect(filename, textContent) {
    await browser.runtime.sendMessage({ type: 'ig-exporter-save-file', filename, textContent });
  }

  async function exportAsZip({ markdown, zip, download }, images, common) {
    const files = [];
    let successCount = 0;

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        const bytes = await fetchImageBytes(img.url);
        const ext = guessExtension(img.url);
        files.push({ name: `images/${String(i + 1).padStart(2, '0')}.${ext}`, data: bytes });
        successCount++;
      } catch (err) {
        // Keep going — a single failed image (e.g. an expired signed URL)
        // shouldn't block exporting the rest of the post.
        console.warn('[Instagram Post Exporter] Skipping image (fetch failed):', img.url, err);
      }
    }

    const markdownContent = markdown.buildPostMarkdown({ ...common, imageCount: successCount });
    files.push({ name: 'post.md', data: new TextEncoder().encode(markdownContent) });

    const zipBytes = zip.createZip(files);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    download.downloadBlob(blob, `instagram-${common.type}-${common.shortcode}.zip`);

    return { successCount, total: images.length };
  }

  async function exportAsEmbeddedMarkdown({ markdown }, images, common, subfolder) {
    const embeddedImages = [];
    for (const img of images) {
      try {
        const bytes = await fetchImageBytes(img.url);
        const dataUrl = await bytesToDataUrl(bytes, guessMimeType(img.url));
        embeddedImages.push({ alt: img.alt, dataUrl });
      } catch (err) {
        console.warn('[Instagram Post Exporter] Skipping image (fetch failed):', img.url, err);
      }
    }

    const markdownContent = markdown.buildPostMarkdown({
      ...common,
      images: embeddedImages,
      imageCount: embeddedImages.length,
    });

    const filename = subfolder
      ? `${subfolder}/instagram-${common.type}-${common.shortcode}.md`
      : `instagram-${common.type}-${common.shortcode}.md`;
    await saveFileDirect(filename, markdownContent);

    return { successCount: embeddedImages.length, total: images.length };
  }

  async function exportArticle(article, btn, defaultLabel) {
    const { extractor, markdown, zip, download, settings } = modules();
    if (!extractor || !markdown || !zip || !download || !settings) {
      console.error('[Instagram Post Exporter] Extension modules failed to load.');
      setButtonState(btn, 'error', 'Export failed', defaultLabel);
      return;
    }

    setButtonState(btn, 'busy', 'Exporting…', defaultLabel);

    try {
      const { url, shortcode, type } = resolvePostContext(article, extractor);
      // One last refresh to catch the currently-displayed slide, then use
      // everything accumulated for this post so far (see imageCache above)
      // rather than just what's mounted in the DOM at this exact instant.
      const images = Array.from(updateImageCache(article, extractor).values());
      const description = extractor.extractDescription(document, article);
      const postDate = extractor.extractPostDate(document, article);
      const exportDate = new Date().toISOString();
      const common = { url, shortcode, type, exportDate, postDate, description };

      const userSettings = await settings.getSettings();
      const result =
        userSettings.exportMode === 'embedded-md'
          ? await exportAsEmbeddedMarkdown({ markdown }, images, common, userSettings.subfolder)
          : await exportAsZip({ markdown, zip, download }, images, common);

      // Always shows the image count, not just on partial failure — a low
      // count can also mean the extraction itself only found that many
      // images rendered in the DOM at click time (e.g. a carousel Instagram
      // hasn't fully rendered yet), which looks identical to "done" unless
      // the count is visible right on the button.
      const resultLabel =
        result.total === 0
          ? 'Exported ✓ (no images)'
          : result.successCount < result.total
            ? `Exported (${result.successCount}/${result.total} images)`
            : `Exported ✓ (${result.total} image${result.total > 1 ? 's' : ''})`;
      setButtonState(btn, 'idle', resultLabel, defaultLabel);
      setTimeout(() => setButtonState(btn, 'idle', null, defaultLabel), 3000);
    } catch (err) {
      console.error('[Instagram Post Exporter] Export failed:', err);
      setButtonState(btn, 'error', 'Export failed', defaultLabel);
      setTimeout(() => setButtonState(btn, 'idle', null, defaultLabel), 3000);
    }
  }

  function createButtonFor(article) {
    const btn = document.createElement('button');
    const defaultLabel = 'Export';
    btn.type = 'button';
    btn.className = 'ig-exporter-btn ig-exporter-btn--anchored';
    btn.textContent = defaultLabel;
    btn.style.display = 'none'; // shown once we've successfully positioned it
    btn.addEventListener('click', () => exportArticle(article, btn, defaultLabel));
    document.body.appendChild(btn);
    return btn;
  }

  /**
   * Positions a post's button just to the left of its save/bookmark icon.
   * For an ordinary feed-scanned button, hides it (rather than falling
   * back to some shared default position) whenever the anchor can't be
   * found, isn't laid out yet, or has scrolled out of view — with many
   * post cards on screen at once, a shared fallback position would just
   * pile buttons on top of each other. The "primary" button (the direct
   * /p/ or /reel/ page's own post — see ensurePrimaryPostButton) is
   * different: it's the one button that must always be reachable, so
   * instead of hiding it falls back to the classic floating bottom-right
   * position.
   */
  function repositionButtonFor(article, entry, extractor) {
    const { btn, isPrimary } = entry;
    const anchor = document.body.contains(article) ? extractor.findSaveButtonAnchor(document, article) : null;
    const rect = anchor ? anchor.getBoundingClientRect() : null;
    const margin = 100;
    const hasSize = !!rect && (rect.width > 0 || rect.height > 0);
    const inViewport = hasSize && rect.bottom > -margin && rect.top < window.innerHeight + margin;

    if (hasSize && inViewport) {
      btn.classList.add('ig-exporter-btn--anchored');
      btn.style.display = '';
      const btnRect = btn.getBoundingClientRect();
      btn.style.top = `${Math.max(8, rect.top + rect.height / 2 - btnRect.height / 2)}px`;
      btn.style.left = `${Math.max(8, rect.left - btnRect.width - 8)}px`;
      return;
    }

    if (isPrimary) {
      btn.classList.remove('ig-exporter-btn--anchored');
      btn.style.display = '';
      btn.style.top = '';
      btn.style.left = '';
      return;
    }

    btn.style.display = 'none';
  }

  /** Finds new post cards (anywhere on the page) and gives each one a button. */
  function scanForPosts(extractor) {
    const candidates = document.querySelectorAll(`article:not([${PROCESSED_ATTR}])`);
    candidates.forEach((article) => {
      if (!extractor.looksLikePostArticle(article)) return;
      article.setAttribute(PROCESSED_ATTR, '1');
      buttons.set(article, { btn: createButtonFor(article), isPrimary: false });
    });
  }

  /**
   * On a direct /p/ or /reel/ page, guarantee a button for the main post
   * regardless of whether looksLikePostArticle's icon-count heuristic
   * matches its markup (which can differ from a feed card's) — there's no
   * ambiguity to resolve here, the URL already tells us this page is one
   * specific post.
   */
  function ensurePrimaryPostButton(extractor) {
    if (!isDirectPostPath(location.pathname)) return;
    const root = extractor.findPostRoot(document);
    if (!root || root === document.body) return;
    if (root.hasAttribute(PROCESSED_ATTR)) return;
    root.setAttribute(PROCESSED_ATTR, '1');
    buttons.set(root, { btn: createButtonFor(root), isPrimary: true });
  }

  /** Drops buttons (and their image cache) whose backing element has left the DOM (e.g. a virtualized feed item). */
  function cleanupButtons() {
    buttons.forEach((entry, article) => {
      if (!document.body.contains(article)) {
        entry.btn.remove();
        buttons.delete(article);
        imageCache.delete(article);
      }
    });
  }

  /** Refreshes the accumulated image cache for every currently-tracked post. */
  function updateAllImageCaches(extractor) {
    buttons.forEach((_entry, article) => updateImageCache(article, extractor));
  }

  function repositionAll(extractor) {
    buttons.forEach((entry, article) => repositionButtonFor(article, entry, extractor));
  }

  let repositionQueued = false;
  function scheduleReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      const { extractor } = modules();
      if (extractor) repositionAll(extractor);
    });
  }

  function tick() {
    const { extractor } = modules();
    if (!extractor) return;
    ensurePrimaryPostButton(extractor);
    scanForPosts(extractor);
    updateAllImageCaches(extractor);
    cleanupButtons();
    scheduleReposition();
  }

  // `true` (capture) so this also fires for scroll events on nested scroll
  // containers (e.g. a post modal's own scrollable area, or the feed's
  // internal scroller), since scroll events don't bubble but capturing
  // still reaches them.
  window.addEventListener('scroll', scheduleReposition, true);
  window.addEventListener('resize', scheduleReposition);

  // Instagram is a single-page app that streams in new post cards (feed
  // scroll, client-side navigation) without a page reload, so we keep
  // rescanning on a low-frequency poll rather than relying on a one-time
  // scan or path-based navigation hooks.
  setInterval(tick, 1000);
  tick();

  // The 1s poll alone can miss a carousel slide that gets mounted and then
  // unmounted again (Instagram virtualizing to the next slide) within the
  // same second, e.g. a user swiping through quickly. A MutationObserver
  // catches every DOM change as it happens, so image caches stay accurate
  // even between poll ticks — it only refreshes existing posts' image
  // caches (rAF-throttled so a burst of mutations doesn't cause a refresh
  // per mutation); new-post discovery still runs on the regular poll.
  let mutationRefreshQueued = false;
  const mutationObserver = new MutationObserver(() => {
    if (mutationRefreshQueued) return;
    mutationRefreshQueued = true;
    requestAnimationFrame(() => {
      mutationRefreshQueued = false;
      const { extractor } = modules();
      if (extractor) updateAllImageCaches(extractor);
    });
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true });
})();
