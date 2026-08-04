/**
 * content.js
 *
 * Orchestrator that runs inside any instagram.com page. Scans the DOM for
 * post/reel cards (an open /p/ or /reel/ page has exactly one; the home
 * feed, a profile's tagged/saved view, etc. can have many as the user
 * scrolls) and gives each one its own "Export ZIP" button, anchored next to
 * that post's own save/bookmark icon. Clicking a button reads that specific
 * post's already-rendered DOM, fetches the bytes of its visible content
 * images, builds post.md, zips everything, and triggers a local download.
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

  /** Map<article element, button element> for every post card we've found. */
  const buttons = new Map();

  function modules() {
    return window.IGExporter || {};
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

  function setButtonState(btn, state, message) {
    btn.disabled = state === 'busy';
    btn.classList.toggle('ig-exporter-btn--busy', state === 'busy');
    btn.classList.toggle('ig-exporter-btn--error', state === 'error');
    btn.textContent = message || 'Export ZIP';
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

  async function exportArticle(article, btn) {
    const { extractor, markdown, zip, download } = modules();
    if (!extractor || !markdown || !zip || !download) {
      console.error('[Instagram Post Exporter] Extension modules failed to load.');
      setButtonState(btn, 'error', 'Export failed');
      return;
    }

    setButtonState(btn, 'busy', 'Exporting…');

    try {
      const { url, shortcode, type } = resolvePostContext(article, extractor);
      const images = extractor.extractPostImages(document, article);
      const description = extractor.extractDescription(document, article);
      const postDate = extractor.extractPostDate(document, article);
      const exportDate = new Date().toISOString();

      const files = [];
      let successCount = 0;

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        try {
          const bytes = await fetchImageBytes(img.url);
          const ext = guessExtension(img.url);
          const name = `images/${String(i + 1).padStart(2, '0')}.${ext}`;
          files.push({ name, data: bytes });
          successCount++;
        } catch (err) {
          // Keep going — a single failed image (e.g. an expired signed URL)
          // shouldn't block exporting the rest of the post.
          console.warn('[Instagram Post Exporter] Skipping image (fetch failed):', img.url, err);
        }
      }

      const markdownContent = markdown.buildPostMarkdown({
        url,
        shortcode,
        exportDate,
        postDate,
        description,
        imageCount: successCount,
        type,
      });
      files.push({ name: 'post.md', data: new TextEncoder().encode(markdownContent) });

      const zipBytes = zip.createZip(files);
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      download.downloadBlob(blob, `instagram-${type}-${shortcode}.zip`);

      const resultLabel =
        images.length > 0 && successCount < images.length
          ? `Exported (${successCount}/${images.length} images)`
          : 'Exported ✓';
      setButtonState(btn, 'idle', resultLabel);
      setTimeout(() => setButtonState(btn, 'idle', 'Export ZIP'), 3000);
    } catch (err) {
      console.error('[Instagram Post Exporter] Export failed:', err);
      setButtonState(btn, 'error', 'Export failed');
      setTimeout(() => setButtonState(btn, 'idle', 'Export ZIP'), 3000);
    }
  }

  function createButtonFor(article) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ig-exporter-btn ig-exporter-btn--anchored';
    btn.textContent = 'Export ZIP';
    btn.style.display = 'none'; // shown once we've successfully anchored it
    btn.addEventListener('click', () => exportArticle(article, btn));
    document.body.appendChild(btn);
    return btn;
  }

  /**
   * Positions a post's button just to the left of its save/bookmark icon.
   * Hides the button (rather than falling back to some default position)
   * whenever the anchor can't be found, isn't laid out yet, or has
   * scrolled out of view — with many post cards on screen at once, a
   * fallback position would just pile several buttons on top of each other.
   */
  function repositionButtonFor(article, btn, extractor) {
    if (!document.body.contains(article)) {
      btn.style.display = 'none';
      return;
    }

    const anchor = extractor.findSaveButtonAnchor(document, article);
    if (!anchor) {
      btn.style.display = 'none';
      return;
    }

    const rect = anchor.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      btn.style.display = 'none';
      return;
    }

    const margin = 100;
    const inViewport = rect.bottom > -margin && rect.top < window.innerHeight + margin;
    if (!inViewport) {
      btn.style.display = 'none';
      return;
    }

    btn.style.display = '';
    const btnRect = btn.getBoundingClientRect();
    const top = rect.top + rect.height / 2 - btnRect.height / 2;
    const left = rect.left - btnRect.width - 8;
    btn.style.top = `${Math.max(8, top)}px`;
    btn.style.left = `${Math.max(8, left)}px`;
  }

  /** Finds new post cards and gives each one a button; drops buttons whose card is gone. */
  function scanForPosts() {
    const { extractor } = modules();
    if (!extractor) return;

    const candidates = document.querySelectorAll(`article:not([${PROCESSED_ATTR}])`);
    candidates.forEach((article) => {
      if (!extractor.looksLikePostArticle(article)) return;
      article.setAttribute(PROCESSED_ATTR, '1');
      buttons.set(article, createButtonFor(article));
    });

    buttons.forEach((btn, article) => {
      if (!document.body.contains(article)) {
        btn.remove();
        buttons.delete(article);
      }
    });
  }

  function repositionAll() {
    const { extractor } = modules();
    if (!extractor) return;
    buttons.forEach((btn, article) => repositionButtonFor(article, btn, extractor));
  }

  let repositionQueued = false;
  function scheduleReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      repositionAll();
    });
  }

  function tick() {
    scanForPosts();
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
})();
