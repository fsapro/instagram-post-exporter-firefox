'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { extractShortcode, extractType, parseSrcset, resolveBestImageSrc, isLikelyContentImage } =
  require(path.join('..', 'src', 'instagramExtractor.js'));

/** Minimal fake <img> — resolveBestImageSrc/isLikelyContentImage only ever call getAttribute(). */
function fakeImg(attrs) {
  return { getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null) };
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
