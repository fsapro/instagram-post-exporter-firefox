/**
 * instagramExtractor.js
 *
 * Reads data that is already rendered in the current page's DOM: shortcode
 * (from the URL), the post's image elements, its visible caption, and (when
 * present) a machine-readable post date. Nothing here makes network requests,
 * simulates clicks, or reaches into any page other than the one currently
 * open in the active tab.
 *
 * Instagram's markup uses generated/hashed class names that change often, so
 * every selector below is structural (tag names, roles, attributes) rather
 * than tied to a specific class. This is inherently best-effort — see
 * docs/technical-notes.md for known fragility and limitations.
 */
(function (global) {
  'use strict';

  /** Extracts the shortcode from a /p/<code>/ or /reel/<code>/ URL or path. */
  function extractShortcode(input) {
    const str = String(input || '');
    let path = str;
    if (str.includes('://')) {
      try {
        path = new URL(str).pathname;
      } catch (e) {
        path = str;
      }
    }
    const match = path.match(/\/(?:p|reel)\/([^/?#]+)/);
    return match ? match[1] : '';
  }

  /** Returns "reel" or "post" based on the URL/path. */
  function extractType(input) {
    const str = String(input || '');
    let path = str;
    if (str.includes('://')) {
      try {
        path = new URL(str).pathname;
      } catch (e) {
        path = str;
      }
    }
    return /\/reel\//.test(path) ? 'reel' : 'post';
  }

  /** Finds the DOM subtree containing the currently displayed post. */
  function findPostRoot(doc) {
    return (
      doc.querySelector('main article') ||
      doc.querySelector('div[role="dialog"] article') ||
      doc.querySelector('article') ||
      doc.querySelector('main') ||
      doc.body
    );
  }

  const SRCSET_WHITESPACE = /[ \t\n\r\f]/;

  /**
   * Parses a `srcset` attribute value into [{ url, width }]. Splitting naively
   * on `,` breaks on candidates whose URL itself contains a comma (most
   * notably `data:` URIs, e.g. `data:image/gif;base64,AAAA... 640w`), so this
   * walks the string the way the HTML spec does: a candidate's URL is the
   * next whitespace-delimited token (commas inside it are just characters),
   * then everything up to the next un-parenthesized comma is its descriptor.
   */
  function parseSrcset(srcset) {
    const input = srcset.trim();
    const len = input.length;
    const candidates = [];
    let pos = 0;

    while (pos < len) {
      while (pos < len && (SRCSET_WHITESPACE.test(input[pos]) || input[pos] === ',')) pos++;
      if (pos >= len) break;

      const urlStart = pos;
      while (pos < len && !SRCSET_WHITESPACE.test(input[pos])) pos++;
      let url = input.slice(urlStart, pos);

      let descriptor = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        while (pos < len && SRCSET_WHITESPACE.test(input[pos])) pos++;
        const descStart = pos;
        let parenDepth = 0;
        while (pos < len) {
          const c = input[pos];
          if (c === '(') parenDepth++;
          else if (c === ')') parenDepth--;
          else if (c === ',' && parenDepth <= 0) break;
          pos++;
        }
        descriptor = input.slice(descStart, pos).trim();
        if (pos < len && input[pos] === ',') pos++;
      }

      if (url) {
        const widthMatch = descriptor.match(/(\d+)w/);
        const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
        candidates.push({ url, width });
      }
    }

    return candidates;
  }

  /** Picks the highest-resolution URL from an <img>'s srcset (falls back to src). */
  function resolveBestImageSrc(img) {
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const candidates = parseSrcset(srcset);
      candidates.sort((a, b) => b.width - a.width);
      if (candidates.length && candidates[0].url) {
        return candidates[0].url;
      }
    }
    return img.getAttribute('src') || '';
  }

  /** Heuristic filter to skip avatars/icons and keep actual post content images. */
  function isLikelyContentImage(img) {
    const alt = (img.getAttribute('alt') || '').toLowerCase();
    if (alt.includes('profile picture') || alt.includes('photo de profil')) {
      return false;
    }
    const attrWidth = parseInt(img.getAttribute('width') || '0', 10);
    const attrHeight = parseInt(img.getAttribute('height') || '0', 10);
    const naturalWidth = img.naturalWidth || 0;
    const naturalHeight = img.naturalHeight || 0;
    const width = naturalWidth || attrWidth;
    const height = naturalHeight || attrHeight;
    if (width && height && width < 100 && height < 100) {
      return false; // likely an avatar or UI icon
    }
    if (!img.getAttribute('src') && !img.getAttribute('srcset')) {
      return false;
    }
    return true;
  }

  /**
   * Returns visible content images for the current post as
   * [{ url, alt }], deduplicated by resolved URL.
   */
  function extractPostImages(doc, root) {
    const scope = root || findPostRoot(doc);
    const imgs = Array.from(scope.querySelectorAll('img'));
    const seen = new Set();
    const results = [];
    for (const img of imgs) {
      if (!isLikelyContentImage(img)) continue;
      const url = resolveBestImageSrc(img);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({ url, alt: img.getAttribute('alt') || '' });
    }
    return results;
  }

  /** True if a caption candidate looks like real text rather than a stat/timestamp. */
  function looksLikeStatOrTimestamp(text) {
    return /^\d+\s*(likes?|vues?|views?|j|w|h|m|s|min|sem|semaines?)$/i.test(text.trim());
  }

  /**
   * Best-effort extraction of the visible caption/description text.
   * Falls back through a few structural heuristics before finally reading
   * the page's own og:description metadata (still part of the same
   * already-loaded document, not an extra request).
   */
  function extractDescription(doc, root) {
    const scope = root || findPostRoot(doc);

    const h1 = scope.querySelector('h1');
    if (h1 && h1.textContent && h1.textContent.trim().length > 2) {
      return h1.textContent.trim();
    }

    const listItems = scope.querySelectorAll('ul li');
    for (const li of listItems) {
      const spans = li.querySelectorAll('span[dir="auto"], span');
      for (const span of spans) {
        const text = (span.textContent || '').trim();
        if (text.length > 15 && !looksLikeStatOrTimestamp(text)) {
          return text;
        }
      }
    }

    const meta = doc.querySelector('meta[property="og:description"]');
    if (meta && meta.getAttribute('content')) {
      return meta.getAttribute('content').trim();
    }

    return doc.title ? doc.title.trim() : '';
  }

  /** Best-effort post date (ISO string) from a visible <time datetime> element, if any. */
  function extractPostDate(doc, root) {
    const scope = root || findPostRoot(doc);
    const time = scope.querySelector('time[datetime]');
    return time ? time.getAttribute('datetime') : null;
  }

  const api = {
    extractShortcode,
    extractType,
    findPostRoot,
    extractPostImages,
    extractDescription,
    extractPostDate,
    resolveBestImageSrc,
    isLikelyContentImage,
    parseSrcset,
  };

  global.IGExporter = global.IGExporter || {};
  global.IGExporter.extractor = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
