'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  extractShortcode,
  extractType,
  parseSrcset,
  resolveBestImageSrc,
  isLikelyContentImage,
  findSaveButtonAnchor,
  looksLikePostArticle,
  findPostPermalink,
  getTextWithLineBreaks,
  normalizeCaptionText,
} = require(path.join('..', 'src', 'instagramExtractor.js'));

/** Minimal fake text/element nodes — just enough for getTextWithLineBreaks. */
function fakeTextNode(text) {
  return { nodeType: 3, textContent: text };
}
function fakeElement(tagName, children) {
  return { nodeType: 1, tagName, childNodes: children };
}

/** Minimal fake <img> — resolveBestImageSrc/isLikelyContentImage only ever call getAttribute(). */
function fakeImg(attrs) {
  return { getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null) };
}

/** Minimal fake <svg aria-label>, with a fixed .closest() result — enough for findSaveButtonAnchor. */
function fakeSvg(label, closestResult) {
  return {
    getAttribute: (name) => (name === 'aria-label' ? label : null),
    closest: () => closestResult,
  };
}

function fakeScope(svgs) {
  return { querySelectorAll: (selector) => (selector === 'svg[aria-label]' ? svgs : []) };
}

/** Minimal fake <article> — looksLikePostArticle/findPostPermalink only ever call querySelector(All). */
function fakeArticle({ hasImg = false, iconCount = 0, permalinkHref = null } = {}) {
  return {
    querySelector: (selector) => {
      if (selector === 'img') return hasImg ? {} : null;
      if (selector === 'a[href*="/p/"], a[href*="/reel/"]') {
        return permalinkHref ? { getAttribute: (n) => (n === 'href' ? permalinkHref : null) } : null;
      }
      return null;
    },
    querySelectorAll: (selector) => (selector === 'svg[aria-label]' ? new Array(iconCount).fill({}) : []),
  };
}

test('extractShortcode parses /p/ and /reel/ URLs and bare paths', () => {
  assert.equal(extractShortcode('https://www.instagram.com/p/ABC123/'), 'ABC123');
  assert.equal(extractShortcode('https://www.instagram.com/reel/XYZ789/?utm=1'), 'XYZ789');
  assert.equal(extractShortcode('/p/ABC123/'), 'ABC123');
  assert.equal(extractShortcode('https://www.instagram.com/'), '');
});

test('extractType distinguishes post vs reel', () => {
  assert.equal(extractType('https://www.instagram.com/p/ABC123/'), 'post');
  assert.equal(extractType('https://www.instagram.com/reel/ABC123/'), 'reel');
});

test('parseSrcset handles a normal multi-candidate list and picks the widest', () => {
  const candidates = parseSrcset('https://example.com/a.jpg 320w, https://example.com/b.jpg 640w');
  assert.deepEqual(candidates, [
    { url: 'https://example.com/a.jpg', width: 320 },
    { url: 'https://example.com/b.jpg', width: 640 },
  ]);
});

test('parseSrcset does not split a data: URI on its internal comma', () => {
  const srcset = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw== 640w';
  const candidates = parseSrcset(srcset);
  assert.equal(candidates.length, 1);
  assert.equal(
    candidates[0].url,
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
  );
  assert.equal(candidates[0].width, 640);
});

test('parseSrcset handles multiple data: URI candidates separated by commas', () => {
  const srcset = 'data:image/gif;base64,AAAA 320w, data:image/gif;base64,BBBB 640w';
  const candidates = parseSrcset(srcset);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].url, 'data:image/gif;base64,AAAA');
  assert.equal(candidates[0].width, 320);
  assert.equal(candidates[1].url, 'data:image/gif;base64,BBBB');
  assert.equal(candidates[1].width, 640);
});

test('parseSrcset handles a single candidate with no descriptor', () => {
  const candidates = parseSrcset('https://example.com/a.jpg');
  assert.deepEqual(candidates, [{ url: 'https://example.com/a.jpg', width: 0 }]);
});

test('resolveBestImageSrc prefers srcset over src, and picks the widest candidate', () => {
  const img = fakeImg({
    src: 'https://cdn.example.com/small.jpg',
    srcset: 'https://cdn.example.com/small.jpg 320w, https://cdn.example.com/large.jpg 1080w',
  });
  assert.equal(resolveBestImageSrc(img), 'https://cdn.example.com/large.jpg');
});

test('resolveBestImageSrc falls back to data-src/data-srcset for lazy-loaded carousel slides', () => {
  const img = fakeImg({
    'data-src': 'https://cdn.example.com/lazy.jpg',
    'data-srcset': 'https://cdn.example.com/lazy-small.jpg 320w, https://cdn.example.com/lazy-large.jpg 1080w',
  });
  assert.equal(resolveBestImageSrc(img), 'https://cdn.example.com/lazy-large.jpg');

  const imgNoSrcset = fakeImg({ 'data-src': 'https://cdn.example.com/lazy-only.jpg' });
  assert.equal(resolveBestImageSrc(imgNoSrcset), 'https://cdn.example.com/lazy-only.jpg');
});

test('isLikelyContentImage accepts a lazy-loaded image with only data-src, rejects a sourceless one', () => {
  assert.equal(
    isLikelyContentImage(fakeImg({ 'data-src': 'https://cdn.example.com/lazy.jpg', width: '640', height: '640' })),
    true
  );
  assert.equal(isLikelyContentImage(fakeImg({ width: '640', height: '640' })), false);
});

test('isLikelyContentImage rejects small avatar-sized images and profile-picture alt text', () => {
  assert.equal(
    isLikelyContentImage(fakeImg({ src: 'https://cdn.example.com/avatar.jpg', width: '32', height: '32' })),
    false
  );
  assert.equal(
    isLikelyContentImage(
      fakeImg({ src: 'https://cdn.example.com/x.jpg', alt: 'Profile picture of testuser', width: '640', height: '640' })
    ),
    false
  );
});

test('findSaveButtonAnchor matches a known localized "save" label over other icons', () => {
  const saveAnchor = { id: 'save-anchor' };
  const scope = fakeScope([
    fakeSvg('Like', { id: 'like-anchor' }),
    fakeSvg('Comment', { id: 'comment-anchor' }),
    fakeSvg('Enregistrer', saveAnchor),
  ]);
  assert.equal(findSaveButtonAnchor(null, scope), saveAnchor);
});

test('findSaveButtonAnchor falls back to the last icon when no known save label matches', () => {
  const lastAnchor = { id: 'last-anchor' };
  const scope = fakeScope([fakeSvg('Like', { id: 'like-anchor' }), fakeSvg('Unknown Icon', lastAnchor)]);
  assert.equal(findSaveButtonAnchor(null, scope), lastAnchor);
});

test('findSaveButtonAnchor returns null when the post has no labeled icons', () => {
  assert.equal(findSaveButtonAnchor(null, fakeScope([])), null);
});

test('looksLikePostArticle accepts a card with an image and a 3+ icon action row', () => {
  assert.equal(looksLikePostArticle(fakeArticle({ hasImg: true, iconCount: 4 })), true);
});

test('looksLikePostArticle rejects cards missing an image or with too few icons (e.g. sidebar widgets)', () => {
  assert.equal(looksLikePostArticle(fakeArticle({ hasImg: false, iconCount: 4 })), false);
  assert.equal(looksLikePostArticle(fakeArticle({ hasImg: true, iconCount: 1 })), false);
});

test('findPostPermalink reads the feed card\'s own /p//reel/ link when present', () => {
  assert.equal(
    findPostPermalink(fakeArticle({ permalinkHref: '/p/ABC123/' })),
    '/p/ABC123/'
  );
  assert.equal(findPostPermalink(fakeArticle({})), null);
});

test('getTextWithLineBreaks converts <br> to a newline (plain textContent would drop it entirely)', () => {
  const node = fakeElement('DIV', [fakeTextNode('Line 1'), fakeElement('BR', []), fakeTextNode('Line 2')]);
  assert.equal(getTextWithLineBreaks(node), 'Line 1\nLine 2');
});

test('getTextWithLineBreaks concatenates text split across inline elements (e.g. around a hashtag/mention link)', () => {
  const node = fakeElement('SPAN', [
    fakeTextNode('Check out my trip '),
    fakeElement('A', [fakeTextNode('#travel')]),
    fakeTextNode(' it was amazing!'),
  ]);
  assert.equal(getTextWithLineBreaks(node), 'Check out my trip #travel it was amazing!');
});

test('getTextWithLineBreaks adds a newline after block-level children (e.g. caption built from <div> lines)', () => {
  const node = fakeElement('DIV', [
    fakeElement('DIV', [fakeTextNode('Line 1')]),
    fakeElement('DIV', [fakeTextNode('Line 2')]),
  ]);
  assert.equal(getTextWithLineBreaks(node), 'Line 1\nLine 2\n');
});

test('normalizeCaptionText trims each line and collapses 3+ blank lines down to one', () => {
  assert.equal(normalizeCaptionText('  Line 1  \n\n\n\n  Line 2  '), 'Line 1\n\nLine 2');
});
