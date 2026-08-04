'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { sanitizeSubfolder, DEFAULT_SETTINGS } = require(path.join('..', 'src', 'settings.js'));

test('sanitizeSubfolder passes through a plain relative folder name', () => {
  assert.equal(sanitizeSubfolder('InstagramExports'), 'InstagramExports');
});

test('sanitizeSubfolder normalizes backslashes and trims segments', () => {
  assert.equal(sanitizeSubfolder('Exports\\Instagram\\ '), 'Exports/Instagram');
});

test('sanitizeSubfolder strips ".." traversal and "." segments', () => {
  assert.equal(sanitizeSubfolder('../../etc/Exports'), 'etc/Exports');
  assert.equal(sanitizeSubfolder('./Exports/./Instagram'), 'Exports/Instagram');
});

test('sanitizeSubfolder collapses empty/whitespace-only input to an empty string', () => {
  assert.equal(sanitizeSubfolder(''), '');
  assert.equal(sanitizeSubfolder('   '), '');
  assert.equal(sanitizeSubfolder(undefined), '');
});

test('DEFAULT_SETTINGS defaults to zip export mode', () => {
  assert.equal(DEFAULT_SETTINGS.exportMode, 'zip');
});
