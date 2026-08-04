/**
 * content.js
 *
 * Orchestrator that runs inside the Instagram post/reel page. Injects the
 * "Export ZIP" button, and on click: reads the already-rendered post data
 * from the DOM, fetches the bytes of the visible content images, builds
 * post.md, zips everything, and triggers a local download.
 *
 * Everything here operates on the single active tab's current document.
 * No other pages are visited, no Instagram interaction is simulated beyond
 * the user's own click on our button, and no requests are sent anywhere
 * other than to fetch the exact image URLs already present in the DOM.
 */
(function () {
  'use strict';

  const BUTTON_ID = 'ig-exporter-export-btn';

  function isSupportedPath(pathname) {
    return /^\/(p|reel)\/[^/]+\/?/.test(pathname);
  }

  function createButton() {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.className = 'ig-exporter-btn';
    btn.textContent = 'Export ZIP';
    btn.addEventListener('click', onExportClick);
    document.body.appendChild(btn);
    return btn;
  }

  function removeButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();
  }

  function ensureButton() {
    if (!isSupportedPath(location.pathname)) {
      removeButton();
      return;
    }
    if (document.getElementById(BUTTON_ID)) return;
    createButton();
  }

  function setButtonState(state, message) {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
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

  async function onExportClick() {
    const { extractor, markdown, zip, download } = window.IGExporter || {};
    if (!extractor || !markdown || !zip || !download) {
      console.error('[Instagram Post Exporter] Extension modules failed to load.');
      setButtonState('error', 'Export failed');
      return;
    }

    setButtonState('busy', 'Exporting…');

    try {
      const url = location.href;
      const shortcode = extractor.extractShortcode(url) || 'unknown';
      const type = extractor.extractType(url);
      const root = extractor.findPostRoot(document);
      const images = extractor.extractPostImages(document, root);
      const description = extractor.extractDescription(document, root);
      const postDate = extractor.extractPostDate(document, root);
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
      setButtonState('idle', resultLabel);
      setTimeout(() => setButtonState('idle', 'Export ZIP'), 3000);
    } catch (err) {
      console.error('[Instagram Post Exporter] Export failed:', err);
      setButtonState('error', 'Export failed');
      setTimeout(() => setButtonState('idle', 'Export ZIP'), 3000);
    }
  }

  /**
   * Instagram is a single-page app: navigating between posts/reels does not
   * reload the content script. We watch for path changes (via history API
   * patches, popstate, and a low-frequency fallback poll) so the button is
   * added/removed as the user browses without needing a page reload.
   */
  function watchNavigation() {
    let lastPath = location.pathname;
    const check = () => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        ensureButton();
      }
    };

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      check();
      return result;
    };
    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      check();
      return result;
    };
    window.addEventListener('popstate', check);
    setInterval(check, 1000);
  }

  ensureButton();
  watchNavigation();
})();
