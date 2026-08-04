'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { extractShortcode, extractType, parseSrcset } = require(
  path.join('..', 'src', 'instagramExtractor.js')
);

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
