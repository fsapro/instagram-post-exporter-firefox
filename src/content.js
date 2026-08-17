/**
 * content.js
 *
 * Unified orchestrator that runs inside Instagram or LinkedIn pages.
 * Detects the platform, loads the appropriate extractor, and manages
 * per-post Export buttons with platform-specific behavior.
 *
 * For each platform:
 * - Scans the DOM for post/carousel/article cards
 * - Gives each one an "Export" button anchored next to its save/bookmark icon
 * - Guarantees a button on direct post pages (fallback to bottom-right)
 * - Accumulates carousel images across ticks via MutationObserver + polling
 * - Exports as ZIP (default) or embedded Markdown with base64 images
 */
(function () {
  'use strict';

  // Platform will be detected at runtime
  let platform = null;
  let platformConfig = null;

  /** Map<article-or-post-root element, { btn, isPrimary }> for every post card we've found. */
  const buttons = new Map();

  /**
   * Map<article, Map<url, {url, alt}>> — every content image seen so far
   * for each tracked post, accumulated across ticks rather than read fresh
   * only at export time. Both Instagram and LinkedIn carousels commonly virtualize:
   * they only keep the current slide plus one neighbor mounted in the DOM at once,
   * unmounting earlier slides as the user swipes further — so a single
   * snapshot at click time can never see more than ~2 slides, no matter how
   * much of the carousel the user has actually looked at. Since we already
   * poll the DOM once a second anyway, merging each tick's findings into a
   * running per-post set means anything the user has scrolled past is
   * still remembered even after the platform removes it from the DOM.
   */
  const imageCache = new Map();

  function modules() {
    return window.SocialExporter || {};
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
    if (!platformConfig || !platformConfig.urlPatterns) return false;
    return platformConfig.urlPatterns.post.test(pathname);
  }

  /**
   * Resolves the URL/identifier/type for a given post card.
   * Feed cards carry their own permalink even though the address
   * bar stays on the feed URL; a direct post page generally
   * doesn't need one since the page URL already is the permalink.
   */
  function resolvePostContext(article, extractor) {
    const permalink = extractor.findPostPermalink(article);
    const url = permalink ? new URL(permalink, location.origin).href : location.href;

    // Platform-specific identifier extraction
    let identifier = 'unknown';
    let type = 'post';

    if (platform === 'instagram') {
      identifier = extractor.extractShortcode(url) || 'unknown';
      type = extractor.extractType(url);
    } else if (platform === 'linkedin') {
      identifier = extractor.extractPostUrn(url) || 'unknown';
      type = extractor.extractType(url);
    }

    return { url, identifier, type };
  }

  function setButtonState(btn, state, message, defaultLabel) {
    btn.disabled = state === 'busy';
    const busyClass = `${platformConfig.buttonClassPrefix}--busy`;
    const errorClass = `${platformConfig.buttonClassPrefix}--error`;
    btn.classList.toggle(busyClass, state === 'busy');
    btn.classList.toggle(errorClass, state === 'error');
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
    const messageType = `${platformConfig.messagePrefix}-save-file`;
    await browser.runtime.sendMessage({ type: messageType, filename, textContent });
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
        console.warn(`[${platformConfig.name} Post Exporter] Skipping image (fetch failed):`, img.url, err);
      }
    }

    const markdownContent = markdown.buildPostMarkdown({ ...common, imageCount: successCount });
    files.push({ name: 'post.md', data: new TextEncoder().encode(markdownContent) });

    const zipBytes = zip.createZip(files);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const filename = `${platformConfig.shortName}-${common.type}-${common.identifier}.zip`;
    download.downloadBlob(blob, filename);

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
        console.warn(`[${platformConfig.name} Post Exporter] Skipping image (fetch failed):`, img.url, err);
      }
    }

    const markdownContent = markdown.buildPostMarkdown({
      ...common,
      images: embeddedImages,
      imageCount: embeddedImages.length,
    });

    const filename = subfolder
      ? `${subfolder}/${platformConfig.shortName}-${common.type}-${common.identifier}.md`
      : `${platformConfig.shortName}-${common.type}-${common.identifier}.md`;
    await saveFileDirect(filename, markdownContent);

    return { successCount: embeddedImages.length, total: images.length };
  }

  async function exportArticle(article, btn, defaultLabel) {
    const { extractor, markdown, zip, download, settings } = modules();
    if (!extractor || !markdown || !zip || !download || !settings) {
      console.error(`[${platformConfig.name} Post Exporter] Extension modules failed to load.`);
      setButtonState(btn, 'error', 'Export failed', defaultLabel);
      return;
    }

    setButtonState(btn, 'busy', 'Exporting…', defaultLabel);

    try {
      const { url, identifier, type } = resolvePostContext(article, extractor);
      // One last refresh to catch the currently-displayed slide, then use
      // everything accumulated for this post so far (see imageCache above)
      // rather than just what's mounted in the DOM at this exact instant.
      const images = Array.from(updateImageCache(article, extractor).values());
      const description = extractor.extractDescription(document, article);
      const postDate = extractor.extractPostDate(document, article);
      const exportDate = new Date().toISOString();

      // Platform-specific additional data
      let author = null;
      if (platform === 'linkedin' && typeof extractor.extractAuthor === 'function') {
        author = extractor.extractAuthor(document, article);
      }

      const common = { url, identifier, type, exportDate, postDate, description, author };

      const userSettings = await settings.getSettings();
      const result =
        userSettings.exportMode === 'embedded-md'
          ? await exportAsEmbeddedMarkdown({ markdown }, images, common, userSettings.subfolder)
          : await exportAsZip({ markdown, zip, download }, images, common);

      // Always shows the image count, not just on partial failure — a low
      // count can also mean the extraction itself only found that many
      // images rendered in the DOM at click time (e.g. a carousel hasn't
      // fully rendered yet), which looks identical to "done" unless
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
      console.error(`[${platformConfig.name} Post Exporter] Export failed:`, err);
      setButtonState(btn, 'error', 'Export failed', defaultLabel);
      setTimeout(() => setButtonState(btn, 'idle', null, defaultLabel), 3000);
    }
  }

  function createButtonFor(article) {
    const btn = document.createElement('button');
    const defaultLabel = 'Export';
    btn.type = 'button';
    btn.className = `social-exporter-btn ${platformConfig.buttonClassPrefix} social-exporter-btn--anchored ${platformConfig.buttonClassPrefix}--anchored`;
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
   * post page's own post — see ensurePrimaryPostButton) is different:
   * it's the one button that must always be reachable, so instead of
   * hiding it falls back to the classic floating bottom-right position.
   */
  function repositionButtonFor(article, entry, extractor) {
    const { btn, isPrimary } = entry;
    const anchor = document.body.contains(article) ? extractor.findSaveButtonAnchor(document, article) : null;
    const rect = anchor ? anchor.getBoundingClientRect() : null;
    const margin = 100;
    const hasSize = !!rect && (rect.width > 0 || rect.height > 0);
    const inViewport = hasSize && rect.bottom > -margin && rect.top < window.innerHeight + margin;

    if (hasSize && inViewport) {
      btn.classList.add('social-exporter-btn--anchored');
      btn.classList.add(`${platformConfig.buttonClassPrefix}--anchored`);
      btn.style.display = '';
      const btnRect = btn.getBoundingClientRect();
      btn.style.top = `${Math.max(8, rect.top + rect.height / 2 - btnRect.height / 2)}px`;
      btn.style.left = `${Math.max(8, rect.left - btnRect.width - 8)}px`;
      return;
    }

    if (isPrimary) {
      btn.classList.remove('social-exporter-btn--anchored');
      btn.classList.remove(`${platformConfig.buttonClassPrefix}--anchored`);
      btn.style.display = '';
      btn.style.top = '';
      btn.style.left = '';
      return;
    }

    btn.style.display = 'none';
  }

  /** Finds new post cards (anywhere on the page) and gives each one a button. */
  function scanForPosts(extractor) {
    const candidates = document.querySelectorAll(`article:not([${platformConfig.processedAttr}])`);
    candidates.forEach((article) => {
      if (!extractor.looksLikePostArticle(article)) return;
      article.setAttribute(platformConfig.processedAttr, '1');
      buttons.set(article, { btn: createButtonFor(article), isPrimary: false });
    });
  }

  /**
   * On a direct post page, guarantee a button for the main post
   * regardless of whether looksLikePostArticle's heuristic matches
   * its markup — there's no ambiguity to resolve here, the URL already
   * tells us this page is one specific post.
   */
  function ensurePrimaryPostButton(extractor) {
    if (!isDirectPostPath(location.pathname)) return;
    const root = extractor.findPostRoot(document);
    if (!root || root === document.body) return;
    if (root.hasAttribute(platformConfig.processedAttr)) return;
    root.setAttribute(platformConfig.processedAttr, '1');
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

  // Initialize platform detection
  const { detectPlatform, getPlatformConfig } = window.SocialExporter.platform;
  platform = detectPlatform();
  platformConfig = getPlatformConfig(platform);

  if (!platform) {
    console.warn('[Social Post Exporter] Unknown platform, exiting.');
    return;
  }

  console.log(`[Social Post Exporter] Initialized for ${platformConfig.name}`);

  // `true` (capture) so this also fires for scroll events on nested scroll
  // containers (e.g. a post modal's own scrollable area, or the feed's
  // internal scroller), since scroll events don't bubble but capturing
  // still reaches them.
  window.addEventListener('scroll', scheduleReposition, true);
  window.addEventListener('resize', scheduleReposition);

  // Both Instagram and LinkedIn are single-page apps that stream in new post
  // cards (feed scroll, client-side navigation) without a page reload, so we keep
  // rescanning on a low-frequency poll rather than relying on a one-time
  // scan or path-based navigation hooks.
  setInterval(tick, 1000);
  tick();

  // The 1s poll alone can miss a carousel slide that gets mounted and then
  // unmounted again (virtualizing to the next slide) within the same second,
  // e.g. a user swiping through quickly. A MutationObserver catches every
  // DOM change as it happens, so image caches stay accurate even between
  // poll ticks — it only refreshes existing posts' image caches (rAF-throttled
  // so a burst of mutations doesn't cause a refresh per mutation); new-post
  // discovery still runs on the regular poll.
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