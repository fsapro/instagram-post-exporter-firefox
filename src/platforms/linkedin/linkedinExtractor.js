/**
 * linkedinExtractor.js
 *
 * Reads data from LinkedIn's SDUI (Server Driven UI) feed and post pages.
 * LinkedIn uses a React-based SDUI architecture where the DOM is generated
 * from JSON data. This extractor parses both the DOM structure (componentkey,
 * URN attributes) and the embedded JSON data to extract post content.
 *
 * Nothing here makes network requests, simulates clicks, or reaches into
 * any page other than the one currently open in the active tab.
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

  /**
   * Finds the DOM subtree containing the currently displayed post.
   * Works for both direct post pages and feed post cards.
   */
  function findPostRoot(doc) {
    // Direct post page - look for main content area
    const mainArticle = doc.querySelector('main article, main div[data-test-id="main-feed-activity-card"], main [data-test-id="feed-update-detail"]');
    if (mainArticle) return mainArticle;

    // Feed post cards - look for SDUI post containers
    const feedCard = doc.querySelector('[data-test-id="feed-shared-update-v2"], .feed-shared-update-v2, [data-urn*="urn:li:activity:"], [data-update-urn*="urn:li:activity:"]');
    if (feedCard) return feedCard;

    // SDUI component-based posts
    const sduiPost = doc.querySelector('[componentkey*="feed-update"], [data-urn*="activity:"]');
    if (sduiPost) return sduiPost;

    return doc.querySelector('main') || doc.body;
  }

  /**
   * Finds all post cards in the feed.
   * Returns array of { element, urn, componentKey } for each post found.
   */
  function findFeedPosts(doc) {
    const posts = [];

    // Strategy 1: Look for elements with data-urn containing activity URN
    const urnElements = doc.querySelectorAll('[data-urn*="urn:li:activity:"], [data-update-urn*="urn:li:activity:"]');
    urnElements.forEach(el => {
      const urn = el.getAttribute('data-urn') || el.getAttribute('data-update-urn');
      const match = urn?.match(/urn:li:activity:(\d+)/);
      if (match) {
        posts.push({ element: el, urn: match[1], componentKey: el.getAttribute('componentkey') });
      }
    });

    // Strategy 2: Look for componentkey with feed-update pattern
    const componentElements = doc.querySelectorAll('[componentkey*="feed-update"], [componentkey*="feed-shared"]');
    componentElements.forEach(el => {
      const urn = findUrnInElement(el);
      if (urn) {
        const existing = posts.find(p => p.urn === urn);
        if (!existing) {
          posts.push({ element: el, urn, componentKey: el.getAttribute('componentkey') });
        }
      }
    });

    // Strategy 3: Look for expandable-text-box (post text containers)
    const textBoxes = doc.querySelectorAll('[data-testid="expandable-text-box"]');
    textBoxes.forEach(box => {
      // Find parent post container
      let parent = box.closest('[data-urn*="activity:"], [componentkey*="feed-update"], [data-test-id="mainFeed"]');
      if (parent) {
        const urn = findUrnInElement(parent) || findUrnInElement(box);
        if (urn) {
          const existing = posts.find(p => p.urn === urn);
          if (!existing) {
            posts.push({ element: parent, urn, componentKey: parent.getAttribute('componentkey') });
          }
        }
      }
    });

    // Deduplicate by URN
    const seen = new Set();
    return posts.filter(p => {
      if (seen.has(p.urn)) return false;
      seen.add(p.urn);
      return true;
    });
  }

  /** Helper to find URN in element or its attributes. */
  function findUrnInElement(el) {
    // Check data attributes
    const dataUrn = el.getAttribute('data-urn') || el.getAttribute('data-update-urn');
    if (dataUrn) {
      const match = dataUrn.match(/urn:li:activity:(\d+)/);
      if (match) return match[1];
    }

    // Check componentkey
    const compKey = el.getAttribute('componentkey');
    if (compKey) {
      const match = compKey.match(/urn:li:activity:(\d+)/);
      if (match) return match[1];
    }

    // Check child elements
    const child = el.querySelector('[data-urn*="activity:"], [data-update-urn*="activity:"]');
    if (child) return findUrnInElement(child);

    return null;
  }

  const SRCSET_WHITESPACE = /[ \t\n\r\f]/;

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

  /**
   * Heuristic filter to skip avatars/icons/UI and keep actual post content images.
   * For SDUI feed, content images are typically in feedshare image components.
   */
  function isLikelyContentImage(img) {
    const alt = (img.getAttribute('alt') || '').toLowerCase();
    const src = (img.getAttribute('src') || '').toLowerCase();
    const className = (img.getAttribute('class') || '').toLowerCase();

    // Exclude known UI/avatar/reaction images by alt text
    const excludeAltPatterns = [
      'profile picture', 'photo de profil', 'photo du profil',
      'logo', 'avatar', 'company logo', 'member photo',
      'voir la photo', 'view photo', 'voir photo',
      'réaction', 'reaction', 'réagir', 'react',
      'j\'aime', 'like', 'j’aime',
      'comment', 'commenter',
      'partager', 'share', 'repost',
      'envoyer', 'send',
      'suivre', 'follow',
      'ignorer', 'skip',
      'photo de couverture', 'cover photo',
      'bannière', 'banner',
      'icône', 'icon',
      'emoji', 'émoji',
      'avatar de', 'avatar of',
    ];

    for (const pattern of excludeAltPatterns) {
      if (alt.includes(pattern)) return false;
    }

    // Exclude by src pattern
    if (src.includes('profile') || src.includes('avatar') || src.includes('emoji') || src.includes('reaction')) {
      return false;
    }

    // Exclude by class pattern (SDUI avatar/image classes)
    if (className.includes('avatar') || className.includes('profile') || className.includes('emoji') || className.includes('reaction')) {
      return false;
    }

    const attrWidth = parseInt(img.getAttribute('width') || '0', 10);
    const attrHeight = parseInt(img.getAttribute('height') || '0', 10);
    const naturalWidth = img.naturalWidth || 0;
    const naturalHeight = img.naturalHeight || 0;
    const width = naturalWidth || attrWidth;
    const height = naturalHeight || attrHeight;

    // Skip tiny images (avatars, icons, reaction emojis)
    if (width && height && width < 100 && height < 100) {
      return false;
    }

    // Skip images that are clearly UI elements
    if (width && height) {
      const ratio = width / height;
      if (ratio > 10 || ratio < 0.1) return false;
    }

    // Skip reaction emoji images
    if (width && height && width <= 64 && height <= 64 && Math.abs(width - height) < 10) {
      const parent = img.parentElement;
      if (parent) {
        const parentText = (parent.textContent || '').toLowerCase();
        if (parentText.includes('réaction') || parentText.includes('reaction') || 
            parentText.includes('j\'aime') || parentText.includes('like')) {
          return false;
        }
      }
    }

    const hasAnySource =
      img.getAttribute('src') ||
      img.getAttribute('srcset') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-srcset') ||
      img.getAttribute('data-delayed-url');
    if (!hasAnySource) return false;

    // Prefer images that look like feed content (feedshare in src)
    if (src.includes('feedshare') || src.includes('dms.image')) {
      return true;
    }

    return true;
  }

  /**
   * Returns content images for the current post as [{ url, alt }],
   * deduplicated by resolved URL.
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

  /** Text patterns that indicate UI chrome to exclude from description */
  const UI_CHROME_PATTERNS = [
    /^post du fil d'?actualité$/i,
    /^fil d'?actualité$/i,
    /^suivre$/i,
    /^follow$/i,
    /^afficher la traduction$/i,
    /^see translation$/i,
    /^afficher plus$/i,
    /^see more$/i,
    /^afficher moins$/i,
    /^show less$/i,
    /^\d+\s*(réactions?|j'?aime|likes?|comment(aires?)?|partages?|shares?)$/i,
    /^j'?aime$/i,
    /^commenter$/i,
    /^comment$/i,
    /^partager$/i,
    /^share$/i,
    /^repost$/i,
    /^reposter$/i,
    /^envoyer$/i,
    /^send$/i,
    /^signaler$/i,
    /^report$/i,
    /^copier le lien/i,
    /^copy link/i,
    /^enregistrer$/i,
    /^save$/i,
    /^bookmark$/i,
    /^\d+[hmj]\s*$/i,
    /^voir toutes? (les )?réactions?$/i,
    /^see all reactions?$/i,
    /^voir toutes? (les )?statistiques?$/i,
    /^bookmark$/i,
    /^ignorer$/i,
    /^skip$/i,
    /^état du bouton de réaction/i,
    /^reaction button state/i,
    /^vues? du profil/i,
    /^profile views?/i,
    /^\d+\s*[hmj]$/i,
    /^[a-zÀ-ÿ]+ [a-zÀ-ÿ]+,?\s*(profil vérifié|verified profile)?\s*(à l'?écoute|open to work)?\s*$/i,
    /^(premier|second|third|3e|4e|5e)\s+et\s+\+?$/i,
  ];

  function isUIChrome(text) {
    const trimmed = text.trim();
    for (const pattern of UI_CHROME_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }
    return false;
  }

  const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'BR', 'SPAN']);

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

  function normalizeCaptionText(text) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !isUIChrome(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Extracts post text from SDUI JSON data embedded in the page.
   * LinkedIn stores post content in JSON within script tags or data attributes.
   */
  function extractDescriptionFromJSON(doc) {
    // Look for JSON data in script tags
    const scripts = doc.querySelectorAll('script[type="application/json"], script[id*="sdui"], script[id*="feed"]');
    for (const script of scripts) {
      try {
        const content = script.textContent || '';
        if (!content.trim()) continue;
        const data = JSON.parse(content);
        const text = findPostTextInJSON(data);
        if (text) return text;
      } catch (e) {
        // Not JSON or not our data
      }
    }
    return null;
  }

  /** Recursively searches JSON for post text content. */
  function findPostTextInJSON(obj, depth = 0) {
    if (depth > 10) return null;
    if (!obj || typeof obj !== 'object') return null;

    // Look for common text fields
    const textFields = ['text', 'commentary', 'description', 'content', 'message', 'title'];
    for (const field of textFields) {
      if (obj[field] && typeof obj[field] === 'string' && obj[field].length > 20) {
        // Basic sanity check - not UI chrome
        if (!isUIChrome(obj[field])) {
          return obj[field];
        }
      }
    }

    // Recurse into arrays and objects
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const result = findPostTextInJSON(item, depth + 1);
        if (result) return result;
      }
    } else {
      for (const key of Object.keys(obj)) {
        const result = findPostTextInJSON(obj[key], depth + 1);
        if (result) return result;
      }
    }
    return null;
  }

  /**
   * Best-effort extraction of the visible post text content.
   * Combines DOM extraction with JSON data extraction.
   */
  function extractDescription(doc, root) {
    const scope = root || findPostRoot(doc);

    // Strategy 1: Try SDUI JSON data first (most reliable for feed)
    const jsonText = extractDescriptionFromJSON(doc);
    if (jsonText && jsonText.length > 20) {
      return normalizeCaptionText(jsonText);
    }

    // Strategy 2: Try the main post text container (post page)
    const textContainerSelectors = [
      '[data-test-id="post-text"]',
      '.update-components-text',
      '.feed-shared-text',
      '.feed-shared-update-v2__description',
      '.feed-shared-inline-show-more-text',
      '[data-test-id="update-components-text"]',
      '[data-testid="expandable-text-box"]',
    ];

    for (const selector of textContainerSelectors) {
      const container = scope.querySelector(selector);
      if (container) {
        const text = normalizeCaptionText(getTextWithLineBreaks(container));
        if (text.length > 10) return text;
      }
    }

    // Strategy 3: For direct post pages, try near actor
    const actorName = scope.querySelector('[data-test-id="actor-name"], .update-components-actor__name, .feed-shared-actor__name');
    if (actorName) {
      const postContent = scope.querySelector('.update-components-text, .feed-shared-text, [data-test-id="post-text"]');
      if (postContent) {
        const text = normalizeCaptionText(getTextWithLineBreaks(postContent));
        if (text.length > 10) return text;
      }
    }

    // Strategy 4: Fallback to og:description (usually clean)
    const meta = doc.querySelector('meta[property="og:description"]');
    if (meta && meta.getAttribute('content')) {
      const content = meta.getAttribute('content').trim();
      if (content.length > 10) return normalizeCaptionText(content);
    }

    // Strategy 5: As last resort, get all text but heavily filter
    const allText = normalizeCaptionText(getTextWithLineBreaks(scope));
    if (allText.length > 50) return allText;

    return doc.title ? doc.title.trim() : '';
  }

  /** Best-effort post date (ISO string) from a visible <time datetime> element, if any. */
  function extractPostDate(doc, root) {
    const scope = root || findPostRoot(doc);
    const time = scope.querySelector('time[datetime]');
    return time ? time.getAttribute('datetime') : null;
  }

  /**
   * Find the save/bookmark button anchor for positioning our export button.
   * Works with SDUI feed and post page structures.
   */
  function findSaveButtonAnchor(doc, root) {
    const scope = root || findPostRoot(doc);

    // Strategy 1: Look for save button by aria-label
    const saveLabels = ['save', 'enregistrer', 'guardar', 'salvar', 'speichern', 'salva'];
    
    // Try multiple selector strategies
    const candidates = [
      // By aria-label on button
      ...Array.from(scope.querySelectorAll('button[aria-label], [role="button"][aria-label]')),
      // By data-test-id
      ...Array.from(scope.querySelectorAll('[data-test-id="save-button"], [data-control-name="save_post"], [data-test-id="feed-shared-save-button"], [data-testid="save-button"]')),
      // By specific classes
      ...Array.from(scope.querySelectorAll('button.feed-shared-social-action-bar__action-button, .social-action-button, [data-test-id="social-action-button"]')),
    ];

    // First pass: exact save label match
    for (const btn of candidates) {
      const label = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
      if (saveLabels.some(l => label === l || label.startsWith(l + ' '))) {
        return btn;
      }
    }

    // Second pass: partial match
    for (const btn of candidates) {
      const label = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
      if (saveLabels.some(l => label.includes(l))) {
        return btn;
      }
    }

    // Third pass: look in action bar
    const actionBar = scope.querySelector('[data-test-id="social-action-bar"], .feed-shared-social-action-bar, .update-components-social-bar, [data-test-id="feed-shared-action-bar"]');
    if (actionBar) {
      const buttons = actionBar.querySelectorAll('button, [role="button"]');
      if (buttons.length) return buttons[buttons.length - 1];
    }

    // Fallback: last action button in scope
    const actionButtons = scope.querySelectorAll('[data-test-id="social-action-button"], button[aria-label]');
    if (actionButtons.length) return actionButtons[actionButtons.length - 1];

    return null;
  }

  /**
   * True if an element looks like an actual post card rather than
   * some other widget (suggested connections, ads, etc.).
   */
  function looksLikePostArticle(article) {
    // Must have some text content
    if (!article.querySelector('[data-test-id="post-text"], .feed-shared-text, .update-components-text, [data-testid="expandable-text-box"], p, span')) return false;

    // Should have at least some action buttons
    const actionButtons = article.querySelectorAll('[data-test-id="social-action-button"], button[aria-label], [data-testid="save-button"]');
    if (actionButtons.length < 2) return false;

    // Should have an author/actor
    if (!article.querySelector('[data-test-id="actor-name"], .feed-shared-actor__name, .update-components-actor__name, [data-testid="actor-name"]')) return false;

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

    // Check for URN in element
    const urn = article.getAttribute('data-urn') || article.getAttribute('data-update-urn');
    if (urn) return `https://www.linkedin.com/feed/update/${urn}/`;

    return null;
  }

  /**
   * Extract author info from the post.
   */
  function extractAuthor(doc, root) {
    const scope = root || findPostRoot(doc);

    // Author name link
    const authorLink = scope.querySelector('[data-test-id="actor-name"], .feed-shared-actor__name a, .update-components-actor__name a, [data-testid="actor-name"] a');
    const name = authorLink ? authorLink.textContent.trim() : '';

    // Author profile URL
    const profileUrl = authorLink ? authorLink.getAttribute('href') : '';

    // Author headline
    const headlineEl = scope.querySelector('[data-test-id="actor-headline"], .feed-shared-actor__description, .update-components-actor__description, [data-testid="actor-headline"]');
    const headline = headlineEl ? headlineEl.textContent.trim() : '';

    return { name, profileUrl, headline };
  }

  const api = {
    extractPostUrn,
    extractType,
    findPostRoot,
    findFeedPosts,
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