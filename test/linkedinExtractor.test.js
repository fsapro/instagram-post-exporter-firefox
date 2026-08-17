/**
 * linkedinExtractor.test.js
 * Unit tests for the pure DOM-reading helpers in linkedinExtractor.js
 * Run with: node --test test/linkedinExtractor.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const extractor = require('../src/platforms/linkedin/linkedinExtractor.js');

// Minimal fake DOM element factory for testing
function createFakeElement(tagName, attributes = {}, children = []) {
  const el = {
    tagName: tagName.toUpperCase(),
    attributes: new Map(Object.entries(attributes)),
    children,
    childNodes: children.map(c => typeof c === 'string' ? { nodeType: 3, textContent: c } : c),
    parent: null,
    parentElement: null,
    getAttribute(name) { return this.attributes.get(name) || null; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    hasAttribute(name) { return this.attributes.has(name); },
    querySelector(selector) {
      if (selector.startsWith('[') && selector.endsWith(']')) {
        const attr = selector.slice(1, -1);
        if (this.attributes.has(attr)) return this;
        for (const child of this.children) {
          const found = child.querySelector?.(selector);
          if (found) return found;
        }
      }
      if (selector === 'img' && this.tagName === 'IMG') return this;
      if (selector === 'time[datetime]' && this.tagName === 'TIME' && this.attributes.has('datetime')) return this;
      if (selector === 'a[data-test-id="actor-name"]' && this.tagName === 'A' && this.attributes.get('data-test-id') === 'actor-name') return this;
      if (selector === '[data-test-id="actor-headline"]' && this.attributes.get('data-test-id') === 'actor-headline') return this;
      if (selector === '[data-test-id="post-text"]' && this.attributes.get('data-test-id') === 'post-text') return this;
      for (const child of this.children) {
        const found = child.querySelector?.(selector);
        if (found) return found;
      }
      return null;
    },
    querySelectorAll(selector) {
      const results = [];
      const check = (el) => {
        if (selector === 'img' && el.tagName === 'IMG') results.push(el);
        else if (selector === 'button[aria-label]' && el.tagName === 'BUTTON' && el.attributes.has('aria-label')) results.push(el);
        else if (selector === '[role="button"][aria-label]' && el.attributes.get('role') === 'button' && el.attributes.has('aria-label')) results.push(el);
        else if (selector === '[data-test-id="social-action-button"]' && el.attributes.get('data-test-id') === 'social-action-button') results.push(el);
        else if (selector === 'p, span, div' && ['P', 'SPAN', 'DIV'].includes(el.tagName)) results.push(el);
        else if (selector.startsWith('[') && selector.endsWith(']')) {
          const attr = selector.slice(1, -1);
          if (el.attributes.has(attr)) results.push(el);
        }
        for (const child of el.children) check(child);
      };
      check(this);
      return results;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (selector === 'div[role="button"]' && current.attributes.get('role') === 'button') return current;
        if (selector === 'button' && current.tagName === 'BUTTON') return current;
        current = current.parent;
      }
      return null;
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 100, height: 40, bottom: 40, right: 100 };
    },
    contains(el) { return false; },
  };
  for (const child of children) {
    if (child && typeof child === 'object') {
      child.parent = el;
      child.parentElement = el;
    }
  }
  return el;
}

describe('linkedinExtractor', () => {
  describe('extractPostUrn', () => {
    test('extracts URN from feed/update URL', () => {
      const url = 'https://www.linkedin.com/feed/update/urn:li:activity:123456789/';
      assert.strictEqual(extractor.extractPostUrn(url), '123456789');
    });

    test('extracts URN from activity shorthand', () => {
      const url = 'https://www.linkedin.com/feed/update/activity:987654321/';
      assert.strictEqual(extractor.extractPostUrn(url), '987654321');
    });

    test('extracts URN from posts URL with activity pattern', () => {
      const url = 'https://www.linkedin.com/posts/author-activity-123456/';
      assert.strictEqual(extractor.extractPostUrn(url), '123456');
    });

    test('returns empty string for non-matching URL', () => {
      assert.strictEqual(extractor.extractPostUrn('https://www.linkedin.com/feed/'), '');
    });
  });

  describe('extractType', () => {
    test('returns article for /posts/ URLs', () => {
      assert.strictEqual(extractor.extractType('https://www.linkedin.com/posts/author-something-123/'), 'article');
    });

    test('returns post for feed/update URLs', () => {
      assert.strictEqual(extractor.extractType('https://www.linkedin.com/feed/update/activity:123/'), 'post');
    });
  });

  describe('parseSrcset', () => {
    test('parses simple srcset', () => {
      const srcset = 'image.jpg 400w, image-2x.jpg 800w';
      const result = extractor.parseSrcset(srcset);
      assert.deepStrictEqual(result, [
        { url: 'image.jpg', width: 400 },
        { url: 'image-2x.jpg', width: 800 },
      ]);
    });

    test('handles data URI with comma', () => {
      const srcset = 'data:image/gif;base64,AAAA 640w, image.jpg 800w';
      const result = extractor.parseSrcset(srcset);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].url.startsWith('data:'), true);
    });
  });

  describe('resolveBestImageSrc', () => {
    test('prefers srcset over src', () => {
      const img = createFakeElement('img', {
        src: 'lowres.jpg',
        srcset: 'highres.jpg 800w, medium.jpg 400w',
      });
      assert.strictEqual(extractor.resolveBestImageSrc(img), 'highres.jpg');
    });

    test('falls back to src when no srcset', () => {
      const img = createFakeElement('img', { src: 'fallback.jpg' });
      assert.strictEqual(extractor.resolveBestImageSrc(img), 'fallback.jpg');
    });

    test('checks data-srcset and data-src', () => {
      const img = createFakeElement('img', {
        'data-srcset': 'lazy-high.jpg 800w',
        'data-src': 'lazy-low.jpg',
      });
      assert.strictEqual(extractor.resolveBestImageSrc(img), 'lazy-high.jpg');
    });
  });

  describe('isLikelyContentImage', () => {
    test('rejects profile pictures', () => {
      const img = createFakeElement('img', { alt: 'Profile picture of John Doe', src: 'avatar.jpg', width: '100', height: '100' });
      assert.strictEqual(extractor.isLikelyContentImage(img), false);
    });

    test('rejects photo de profil (French)', () => {
      const img = createFakeElement('img', { alt: 'Photo de profil de Jean', src: 'avatar.jpg', width: '100', height: '100' });
      assert.strictEqual(extractor.isLikelyContentImage(img), false);
    });

    test('rejects reaction images', () => {
      const img = createFakeElement('img', { alt: 'J\'aime', src: 'like.png', width: '32', height: '32' });
      assert.strictEqual(extractor.isLikelyContentImage(img), false);
    });

    test('rejects tiny images', () => {
      const img = createFakeElement('img', { src: 'icon.png', width: '20', height: '20' });
      assert.strictEqual(extractor.isLikelyContentImage(img), false);
    });

    test('accepts normal content images', () => {
      const img = createFakeElement('img', { src: 'post-image.jpg', width: '800', height: '600' });
      assert.strictEqual(extractor.isLikelyContentImage(img), true);
    });

    test('rejects images with no source', () => {
      const img = createFakeElement('img', { alt: 'No src' });
      assert.strictEqual(extractor.isLikelyContentImage(img), false);
    });

    test('rejects reaction emoji images', () => {
      const parent = createFakeElement('div', {}, [createFakeElement('span', {}, ['J\'aime'])]);
      const img = createFakeElement('img', { src: 'like-emoji.png', width: '24', height: '24' }, []);
      img.parentElement = parent;
      assert.strictEqual(extractor.isLikelyContentImage(img), false);
    });
  });

  describe('normalizeCaptionText', () => {
    test('trims lines and collapses multiple blank lines', () => {
      const input = '  Line 1  \n\n\n\nLine 2  \n  ';
      const result = extractor.normalizeCaptionText(input);
      assert.strictEqual(result, 'Line 1\n\nLine 2');
    });

    test('filters UI chrome lines', () => {
      const input = 'Post du fil d\'actualité\nSuivre\nReal content here\nAfficher la traduction';
      const result = extractor.normalizeCaptionText(input);
      assert.ok(!result.includes('Post du fil'));
      assert.ok(!result.includes('Suivre'));
      assert.ok(!result.includes('Afficher la traduction'));
      assert.ok(result.includes('Real content here'));
    });
  });

  describe('getTextWithLineBreaks', () => {
    test('preserves BR as newlines', () => {
      const el = createFakeElement('div', {}, [
        'Line 1',
        createFakeElement('br'),
        'Line 2',
      ]);
      const result = extractor.getTextWithLineBreaks(el);
      assert.strictEqual(result, 'Line 1\nLine 2');
    });

    test('handles nested spans', () => {
      const el = createFakeElement('div', {}, [
        createFakeElement('span', {}, ['Hello']),
        createFakeElement('span', {}, [' ', 'World']),
      ]);
      const result = extractor.getTextWithLineBreaks(el);
      assert.strictEqual(result, 'Hello World');
    });
  });

  describe('findSaveButtonAnchor', () => {
    test('finds button with save aria-label', () => {
      const saveBtn = createFakeElement('button', { 'aria-label': 'Save', 'data-test-id': 'save-button' });
      const root = createFakeElement('div', {}, [saveBtn]);
      const doc = { querySelectorAll: (sel) => {
        if (sel === 'button[aria-label]') return [saveBtn];
        if (sel === '[role="button"][aria-label]') return [];
        if (sel.includes('save-button')) return [saveBtn];
        return [];
      }};

      const result = extractor.findSaveButtonAnchor(doc, root);
      assert.strictEqual(result, saveBtn);
    });

    test('falls back to last button in action bar', () => {
      const btn1 = createFakeElement('button', { 'aria-label': 'Like', 'data-test-id': 'social-action-button' });
      const btn2 = createFakeElement('button', { 'aria-label': 'Comment', 'data-test-id': 'social-action-button' });
      const btn3 = createFakeElement('button', { 'aria-label': 'Share', 'data-test-id': 'social-action-button' });
      const root = createFakeElement('div', {}, [btn1, btn2, btn3]);
      const doc = { querySelectorAll: (sel) => {
        if (sel.includes('social-action-button')) return [btn1, btn2, btn3];
        if (sel === 'button[aria-label]') return [btn1, btn2, btn3];
        if (sel === '[role="button"][aria-label]') return [];
        return [];
      }};

      const result = extractor.findSaveButtonAnchor(doc, root);
      assert.strictEqual(result, btn3);
    });
  });

  describe('looksLikePostArticle', () => {
    test('returns true for valid post card', () => {
      const textEl = createFakeElement('div', { 'data-test-id': 'post-text' }, ['Some post content here']);
      const actorName = createFakeElement('a', { 'data-test-id': 'actor-name' }, ['John Doe']);
      const btn1 = createFakeElement('button', { 'data-test-id': 'social-action-button', 'aria-label': 'Like' });
      const btn2 = createFakeElement('button', { 'data-test-id': 'social-action-button', 'aria-label': 'Comment' });
      const btn3 = createFakeElement('button', { 'data-test-id': 'social-action-button', 'aria-label': 'Share' });
      const article = createFakeElement('div', { 'data-test-id': 'feed-shared-update-v2' }, [textEl, actorName, btn1, btn2, btn3]);

      assert.strictEqual(extractor.looksLikePostArticle(article), true);
    });

    test('returns false for card without text', () => {
      const btn1 = createFakeElement('button', { 'data-test-id': 'social-action-button', 'aria-label': 'Like' });
      const btn2 = createFakeElement('button', { 'data-test-id': 'social-action-button', 'aria-label': 'Comment' });
      const article = createFakeElement('div', {}, [btn1, btn2]);

      assert.strictEqual(extractor.looksLikePostArticle(article), false);
    });

    test('returns false for card without enough action buttons', () => {
      const textEl = createFakeElement('div', { 'data-test-id': 'post-text' }, ['Some content']);
      const btn1 = createFakeElement('button', { 'data-test-id': 'social-action-button', 'aria-label': 'Like' });
      const article = createFakeElement('div', {}, [textEl, btn1]);

      assert.strictEqual(extractor.looksLikePostArticle(article), false);
    });

    test('returns false for card without actor', () => {
      const textEl = createFakeElement('div', { 'data-test-id': 'post-text' }, ['Some content']);
      const btn1 = createFakeElement('button', { 'data-test-id': 'social-action-button', 'aria-label': 'Like' });
      const btn2 = createFakeElement('button', { 'data-test-id': 'social-action-button', 'aria-label': 'Comment' });
      const article = createFakeElement('div', {}, [textEl, btn1, btn2]);

      assert.strictEqual(extractor.looksLikePostArticle(article), false);
    });
  });

  describe('extractAuthor', () => {
    test('extracts author name and profile URL', () => {
      const authorLink = createFakeElement('a', { href: 'https://www.linkedin.com/in/johndoe/', 'data-test-id': 'actor-name' }, ['John Doe']);
      const headlineEl = createFakeElement('div', { 'data-test-id': 'actor-headline' }, ['Software Engineer at Acme Corp']);
      const root = createFakeElement('div', {}, [authorLink, headlineEl]);
      const doc = {};

      const result = extractor.extractAuthor(doc, root);
      assert.strictEqual(result.name, 'John Doe');
      assert.strictEqual(result.profileUrl, 'https://www.linkedin.com/in/johndoe/');
      assert.strictEqual(result.headline, 'Software Engineer at Acme Corp');
    });
  });

  describe('extractDescription', () => {
    test('extracts from data-test-id post-text', () => {
      const textContainer = createFakeElement('div', { 'data-test-id': 'post-text' }, ['Real post content here']);
      const root = createFakeElement('div', { 'data-test-id': 'feed-shared-update-v2' }, [textContainer]);
      const doc = {};

      const result = extractor.extractDescription(doc, root);
      assert.strictEqual(result, 'Real post content here');
    });

    test('filters out UI chrome lines', () => {
      const textContainer = createFakeElement('div', { 'data-test-id': 'post-text' }, [
        'Post du fil d\'actualité',
        'Suivre',
        'Real post content here',
        'Afficher la traduction',
        'J\'aime',
        'Commenter'
      ]);
      const root = createFakeElement('div', { 'data-test-id': 'feed-shared-update-v2' }, [textContainer]);
      const doc = {};

      const result = extractor.extractDescription(doc, root);
      assert.ok(!result.includes('Post du fil'));
      assert.ok(!result.includes('Suivre'));
      assert.ok(!result.includes('Afficher la traduction'));
      assert.ok(!result.includes('J\'aime'));
      assert.ok(!result.includes('Commenter'));
      assert.ok(result.includes('Real post content here'));
    });
  });
});