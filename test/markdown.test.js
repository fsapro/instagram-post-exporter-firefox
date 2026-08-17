'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildPostMarkdown, formatMultilineForMarkdown } = require(path.join('..', 'src', 'markdown.js'));

test('buildPostMarkdown includes URL, shortcode, export date and description', () => {
  const md = buildPostMarkdown({
    url: 'https://www.instagram.com/p/ABC123/',
    shortcode: 'ABC123',
    exportDate: '2026-08-04T10:00:00.000Z',
    description: 'A lovely sunset over the mountains',
    imageCount: 2,
    type: 'post',
  });

  assert.match(md, /https:\/\/www\.instagram\.com\/p\/ABC123\//);
  assert.match(md, /ABC123/);
  assert.match(md, /2026-08-04T10:00:00\.000Z/);
  assert.match(md, /A lovely sunset over the mountains/);
  assert.match(md, /2 image\(s\) exported/);
});

test('buildPostMarkdown handles missing description and zero images gracefully', () => {
  const md = buildPostMarkdown({
    url: 'https://www.instagram.com/reel/XYZ789/',
    shortcode: 'XYZ789',
    exportDate: '2026-08-04T10:00:00.000Z',
    imageCount: 0,
    type: 'reel',
  });

  assert.match(md, /No visible description found/);
  assert.match(md, /No images were found\/exported/);
  assert.match(md, /Reel — XYZ789/);
});

test('formatMultilineForMarkdown turns each newline into a Markdown hard break', () => {
  assert.equal(formatMultilineForMarkdown('Line 1\nLine 2\nLine 3'), 'Line 1  \nLine 2  \nLine 3');
});

test('buildPostMarkdown preserves a multi-line description as visible line breaks, not a single run-on line', () => {
  const md = buildPostMarkdown({
    url: 'https://www.instagram.com/p/ABC123/',
    shortcode: 'ABC123',
    exportDate: '2026-08-04T10:00:00.000Z',
    description: 'Line 1\nLine 2',
    imageCount: 1,
    type: 'post',
  });
  assert.match(md, /Line 1 {2}\nLine 2/);
});

test('buildPostMarkdown inlines images as Markdown image links when an images array is provided (embedded mode)', () => {
  const md = buildPostMarkdown({
    url: 'https://www.instagram.com/p/ABC123/',
    shortcode: 'ABC123',
    exportDate: '2026-08-04T10:00:00.000Z',
    type: 'post',
    images: [
      { alt: 'slide 1', dataUrl: 'data:image/jpeg;base64,AAAA' },
      { alt: '', dataUrl: 'data:image/jpeg;base64,BBBB' },
    ],
  });
  assert.match(md, /!\[slide 1\]\(data:image\/jpeg;base64,AAAA\)/);
  assert.match(md, /!\[image 2\]\(data:image\/jpeg;base64,BBBB\)/);
  assert.doesNotMatch(md, /exported to the `images\/` folder/);
});

test('buildPostMarkdown strips brackets from alt text so an embedded image link can\'t be broken', () => {
  const md = buildPostMarkdown({
    url: 'https://www.instagram.com/p/ABC123/',
    shortcode: 'ABC123',
    type: 'post',
    images: [{ alt: 'weird [alt] text', dataUrl: 'data:image/jpeg;base64,AAAA' }],
  });
  assert.match(md, /!\[weird alt text\]\(data:image\/jpeg;base64,AAAA\)/);
});
