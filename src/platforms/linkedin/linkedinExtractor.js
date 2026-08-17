/**
 * linkedinExtractor.js
 *
 * Reads data that is already rendered in the current page's DOM: post URN
 * (from the URL or data attributes), the post's image elements, its visible
 * text content, and (when present) a machine-readable post date. Nothing
 * here makes network requests, simulates clicks, or reaches into any page
 * other than the one currently open in the active tab.
 *
 * LinkedIn's markup uses generated/hashed class names that change often,
 * so every selector below is structural (tag names, roles, attributes,
 * data-test-id) rather than tied to a specific class. This is inherently
 * best-effort — see docs/technical-notes.md for known fragility and
 * limitations.
 */
(function (global) {
  'use strict';

  /** Extracts the post URN/ID from various LinkedIn URL patterns. */
  function extractPostUrn(input) {
    const str = String(input || '');
    let path = str;
    if (str.includes('://')) {
      try {
        path = new URL(str).pathname;
      } catch (e) {
        path = str;
      }
    }

    // Patterns:
    // /feed/update/urn:li:activity:123456/
    // /posts/urn:li:activity:123456/
    // /feed/update/activity:123456/
    const match = path.match(/(?:urn:li:activity:|activity:)(\d+)/);
    if (match) return match[1];

    // Fallback: try to get from data attributes on the page
    return '';
  }

  /** Returns "post" or "article" based on the content type. */
  function extractType(input) {
    const str = String(input || '');
    if (str.includes('/posts/') || str.includes('/article/')) return 'article';
    return 'post';
  }

  /** Finds the DOM subtree containing the currently displayed post. */
  function findPostRoot(doc) {
    // Direct post page
    const mainArticle = doc.querySelector('main article, main div[data-test-id="main-feed-activity-card"]');
    if (mainArticle) return mainArticle;

    // Feed post cards
    const feedCard = doc.querySelector('div[data-test-id="feed-shared-update-v2"], .feed-shared-update-v2, article[data-test-id="feed-shared-update-v2"]');
    if (feedCard) return feedCard;

    return doc.querySelector('main') || doc.body;
  }

  const SRCSET_WHITESPACE = /[ \t\n\r\f]/;

  /**
   * Parses a `srcset` attribute value into [{ url, width }]. Splitting naively
   * on `,` breaks on candidates whose URL itself contains a comma (most
   * notably `data:` URIs), so this walks the string the way the HTML spec does.
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
   * some lazy-loading implementations use.
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
    return img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-delayed-url') || '';
  }

  /** Heuristic filter to skip avatars/icons and keep actual post content images. */
  function isLikelyContentImage(img) {
    const alt = (img.getAttribute('alt') || '').toLowerCase();
    if (alt.includes('profile picture') || alt.includes('photo de profil') ||
        alt.includes('logo') || alt.includes('avatar') ||
        alt.includes('company logo') || alt.includes('member photo')) {
      return false;
    }

    const attrWidth = parseInt(img.getAttribute('width') || '0', 10);
    const attrHeight = parseInt(img.getAttribute('height') || '0', 10);
    const naturalWidth = img.naturalWidth || 0;
    const naturalHeight = img.naturalHeight || 0;
    const width = naturalWidth || attrWidth;
    const height = naturalHeight || attrHeight;

    // Skip tiny images (avatars, icons)
    if (width && height && width < 100 && height < 100) {
      return false;
    }

    // Skip images that are clearly UI elements (very wide and short = banners, or very tall and narrow = dividers)
    if (width && height) {
      const ratio = width / height;
      if (ratio > 10 || ratio < 0.1) return false;
    }

    const hasAnySource =
      img.getAttribute('src') ||
      img.getAttribute('srcset') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-srcset') ||
      img.getAttribute('data-delayed-url');
    if (!hasAnySource) {
      return false;
    }

    return true;
  }

  /**
   * Returns content images for the current post as [{ url, alt }],
   * deduplicated by resolved URL. For carousel posts this naturally
   * includes every slide LinkedIn has already rendered into the DOM.
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

  /** True if a caption candidate looks like a stat/timestamp rather than real text. */
  function looksLikeStatOrTimestamp(text) {
    return /^\d+\s*(likes?|vues?|views?|comments?|réactions?|partages?|shares?|j|w|h|m|s|min|sem|semaines?|mois?|ans?)$/i.test(text.trim());
  }

  const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'BR', 'SPAN']);

  /**
   * Serializes an element's text the way a user actually reads it.
   * Preserves <br> as newlines and handles block elements.
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

  /** Collapses the raw serialized text into readable caption text. */
  function normalizeCaptionText(text) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Best-effort extraction of the visible post text content.
   * Falls back through structural heuristics.
   */
  function extractDescription(doc, root) {
    const scope = root || findPostRoot(doc);

    // Try the main text container (feed-shared-text, etc.)
    const textContainer = scope.querySelector('[data-test-id="post-text"], .feed-shared-text, .update-components-text, .feed-shared-update-v2__description');
    if (textContainer) {
      const text = normalizeCaptionText(getTextWithLineBreaks(textContainer));
      if (text.length > 2) return text;
    }

    // Try any element with significant text content that looks like a post body
    const candidates = scope.querySelectorAll('p, span, div');
    for (const el of candidates) {
      const text = normalizeCaptionText(getTextWithLineBreaks(el));
      if (text.length > 50 && !looksLikeStatOrTimestamp(text)) {
        // Additional check: not just a name/headline
        if (!/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(text.split('\n')[0])) {
          return text;
        }
      }
    }

    // Fallback to og:description
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

  /** Find the save/bookmark button anchor for positioning our export button. */
  function findSaveButtonAnchor(doc, root) {
    const scope = root || findPostRoot(doc);

    // LinkedIn save button typically has aria-label "Save" or "Enregistrer"
    const saveLabels = ['save', 'enregistrer', 'guardar', 'salvar', 'speichern', 'salva'];
    const icons = Array.from(scope.querySelectorAll('button[aria-label], [role="button"][aria-label]'));

    let match = icons.find((btn) => {
      const label = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
      return saveLabels.some(l => label.includes(l));
    });

    // Fallback: look for specific data-test-id
    if (!match) {
      match = scope.querySelector('[data-test-id="save-button"], [data-control-name="save_post"]');
    }

    // Fallback: last button in the action bar
    if (!match) {
      const actionButtons = scope.querySelectorAll('[data-test-id="social-action-button"], button.feed-shared-social-action-bar__action-button');
      if (actionButtons.length) match = actionButtons[actionButtons.length - 1];
    }

    return match;
  }

  /**
   * True if an element looks like an actual post card rather than
   * some other widget (suggested connections, ads, etc.).
   */
  function looksLikePostArticle(article) {
    // Must have some text content
    if (!article.querySelector('[data-test-id="post-text"], .feed-shared-text, p, span')) return false;

    // Should have at least some action buttons (like, comment, share, save)
    const actionButtons = article.querySelectorAll('[data-test-id="social-action-button"], button[aria-label]');
    if (actionButtons.length < 2) return false;

    return true;
  }

  /**
   * Finds the post permalink inside a feed post card.
   */
  function findPostPermalink(article) {
    // LinkedIn feed cards often have a timestamp link to the post
    const timeLink = article.querySelector('a[href*="/feed/update/"], a[href*="/posts/"], a[href*="activity:"]');
    if (timeLink) return timeLink.getAttribute('href');

    // Or a menu button with the post URN in data attributes
    const menuBtn = article.querySelector('[data-test-id="feed-shared-control-menu-trigger"]');
    if (menuBtn) {
      const urn = menuBtn.getAttribute('data-urn') || menuBtn.getAttribute('data-activity-urn');
      if (urn) return `https://www.linkedin.com/feed/update/${urn}/`;
    }

    return null;
  }

  /**
   * Extract author info from the post.
   */
  function extractAuthor(doc, root) {
    const scope = root || findPostRoot(doc);

    // Author name link
    const authorLink = scope.querySelector('[data-test-id="actor-name"], .feed-shared-actor__name a, .update-components-actor__name a');
    const name = authorLink ? authorLink.textContent.trim() : '';

    // Author profile URL
    const profileUrl = authorLink ? authorLink.getAttribute('href') : '';

    // Author headline
    const headlineEl = scope.querySelector('[data-test-id="actor-headline"], .feed-shared-actor__description, .update-components-actor__description');
    const headline = headlineEl ? headlineEl.textContent.trim() : '';

    return { name, profileUrl, headline };
  }

  const api = {
    extractPostUrn,
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
    extractAuthor,
    getTextWithLineBreaks,
    normalizeCaptionText,
  };

  global.LNExporter = global.LNExporter || {};
  global.LNExporter.extractor = api;

  global.SocialExporter = global.SocialExporter || {};
  global.SocialExporter.extractor = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);