'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { crc32, createZip } = require(path.join('..', 'src', 'zip.js'));

test('crc32 matches a known reference value', () => {
  // CRC-32 of the ASCII string "123456789" is a well-known test vector.
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(bytes).toString(16), 'cbf43926');
});

test('createZip produces a buffer with valid local/central/EOCD signatures', () => {
  const files = [
    { name: 'post.md', data: new TextEncoder().encode('# Hello\n') },
    { name: 'images/01.jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
  ];

  const zipBytes = createZip(files);
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

  // First bytes must be a local file header signature (PK\x03\x04).
  assert.equal(view.getUint32(0, true), 0x04034b50);

  // The EOCD record signature (PK\x05\x06) must appear near the end of the buffer.
  let eocdOffset = -1;
  for (let i = zipBytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, 'EOCD record not found');

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  assert.equal(totalEntries, files.length);
});

test('createZip round-trips file names and byte-for-byte content (manual parse)', () => {
  const payload = new TextEncoder().encode('hello world');
  const files = [{ name: 'a/b.txt', data: payload }];
  const zipBytes = createZip(files);
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

  // Parse the single local file header manually.
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const compression = view.getUint16(8, true);
  assert.equal(compression, 0); // STORE
  const compressedSize = view.getUint32(18, true);
  const nameLength = view.getUint16(26, true);
  assert.equal(compressedSize, payload.length);

  const nameBytes = zipBytes.slice(30, 30 + nameLength);
  const name = new TextDecoder().decode(nameBytes);
  assert.equal(name, 'a/b.txt');

  const dataBytes = zipBytes.slice(30 + nameLength, 30 + nameLength + compressedSize);
  assert.deepEqual(Array.from(dataBytes), Array.from(payload));
});
