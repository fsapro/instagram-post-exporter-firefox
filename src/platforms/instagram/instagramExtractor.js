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

  /**
   * Picks the highest-resolution URL for an <img>. Checks `srcset` before
   * `src`, and also falls back to the `data-srcset`/`data-src` attributes
   * some lazy-loading carousel implementations use to hold an image's real
   * URL before it swaps into `src`/`srcset` on load — reading them is still
   * just reading attributes already present in the DOM, not triggering any
   * loading ourselves.
   */
  function resolveBestImageSrc(img) {
    const srcsetAttr = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (srcsetAttr) {
      const candidates = parseSrcset(srcsetAttr);
      candidates.sort((a, b) => b.width - a.width);
      if (candidates.length && candidates[0].url) {
        return candidates[0].url;
      }
    }
    return img.getAttribute('src') || img.getAttribute('data-src') || '';
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
    const hasAnySource =
      img.getAttribute('src') ||
      img.getAttribute('srcset') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-srcset');
    if (!hasAnySource) {
      return false;
    }
    return true;
  }

  /**
   * Returns content images for the current post as [{ url, alt }],
   * deduplicated by resolved URL. For carousel posts this naturally
   * includes every slide Instagram has already rendered into the DOM
   * (whether currently on-screen or scrolled off to the side) — nothing
   * here scrolls, clicks, or otherwise drives the carousel forward to force
   * additional slides to load, since that would be automated interaction
   * rather than reading what's already visible/rendered.
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

  const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'BR']);

  /**
   * Serializes an element's text the way a user actually reads it, unlike
   * `.textContent` — which silently drops `<br>` entirely (it contributes
   * zero characters, so "Line 1<br>Line 2" becomes "Line 1Line 2" with no
   * separator at all) and doesn't add anything between block-level
   * children either. Instagram captions commonly use `<br>` for line
   * breaks and split plain text around `<a>` mention/hashtag links, so a
   * naive `.textContent` read either loses every line break or (if only
   * one fragment is read, as an earlier version of this extractor did)
   * loses everything after the first hashtag/mention.
   */
  function getTextWithLineBreaks(node) {
    let out = '';
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += child.textContent;
      } else if (child.nodeType === 1) {
        if (child.tagName === 'BR') {
          out += '\n';
        } else {
          out += getTextWithLineBreaks(child);
          if (BLOCK_TAGS.has(child.tagName)) out += '\n';
        }
      }
    });
    return out;
  }

  /** Collapses the raw serialized text into readable caption text: trims each line, drops 3+ blank lines down to 1. */
  function normalizeCaptionText(text) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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
    if (h1) {
      const text = normalizeCaptionText(getTextWithLineBreaks(h1));
      if (text.length > 2) return text;
    }

    const listItems = scope.querySelectorAll('ul li');
    for (const li of listItems) {
      const text = normalizeCaptionText(getTextWithLineBreaks(li));
      if (text.length > 15 && !looksLikeStatOrTimestamp(text)) {
        return text;
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

  const SAVE_ICON_ARIA_LABELS = ['enregistrer', 'save', 'guardar', 'salvar', 'speichern', 'salva'];

  /**
   * Finds a clickable ancestor for the post's save/bookmark icon, used only
   * to read its on-screen position (`getBoundingClientRect`) so our own
   * button can be placed next to it — it is never clicked or otherwise
   * interacted with. Instagram's UI language (icon aria-labels) doesn't
   * always match the post's own language, so this first tries a small set
   * of known "save" labels, then falls back to the last icon in the
   * like/comment/share/save row (save is conventionally the rightmost one).
   */
  function findSaveButtonAnchor(doc, root) {
    const scope = root || findPostRoot(doc);
    const icons = Array.from(scope.querySelectorAll('svg[aria-label]'));
    if (!icons.length) return null;

    let match = icons.find((svg) => {
      const label = (svg.getAttribute('aria-label') || '').trim().toLowerCase();
      return SAVE_ICON_ARIA_LABELS.includes(label);
    });
    if (!match) {
      match = icons[icons.length - 1];
    }
    return match.closest('div[role="button"], button') || match;
  }

  /**
   * True if an <article> element looks like an actual post/reel card rather
   * than some other widget Instagram happens to also wrap in <article>
   * (suggested-accounts rails, etc.). Requires at least one image plus a
   * like/comment/share/save-style icon row (3+ labeled icons) — a real post
   * card always has both; small sidebar widgets generally don't.
   */
  function looksLikePostArticle(article) {
    if (!article.querySelector('img')) return false;
    return article.querySelectorAll('svg[aria-label]').length >= 3;
  }

  /**
   * Finds the post/reel permalink (e.g. "/p/<shortcode>/") inside a feed
   * post card, if present — feed cards link to their own permalink (often
   * via the timestamp) even though the address bar stays on the feed URL.
   */
  function findPostPermalink(article) {
    const a = article.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    return a ? a.getAttribute('href') : null;
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
    findSaveButtonAnchor,
    looksLikePostArticle,
    findPostPermalink,
    getTextWithLineBreaks,
    normalizeCaptionText,
  };

  global.IGExporter = global.IGExporter || {};
  global.IGExporter.extractor = api;

  global.SocialExporter = global.SocialExporter || {};
  global.SocialExporter.extractor = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
