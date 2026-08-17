/**
 * zip.js
 *
 * Minimal, dependency-free ZIP file writer (STORE method only — no compression,
 * which is fine since we only ever zip already-compressed images and small text
 * files). Implements just enough of the ZIP spec to produce a file that every
 * major unzip tool (Windows Explorer, macOS Archive Utility, 7-Zip, unzip) can
 * open: local file headers, a central directory, and an end-of-central-directory
 * record.
 *
 * Exposed as `IGExporter.zip` in the browser (content script global scope) and
 * as a CommonJS export for local Node-based unit testing.
 */
(function (global) {
  'use strict';

  const SIG_LOCAL_FILE_HEADER = 0x04034b50;
  const SIG_CENTRAL_DIR_HEADER = 0x02014b50;
  const SIG_END_OF_CENTRAL_DIR = 0x06054b50;

  const VERSION_NEEDED = 20; // 2.0 - supports basic STORE zips
  const VERSION_MADE_BY = 20;
  const FLAG_UTF8 = 0x0800; // general purpose bit 11: filename/comment are UTF-8

  let crcTable = null;

  function buildCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  }

  /** Standard CRC-32 (used by ZIP) over a Uint8Array. */
  function crc32(bytes) {
    if (!crcTable) crcTable = buildCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** Converts a JS Date to DOS date/time fields used by the ZIP format. */
  function toDosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const dosDate =
      (((year - 1980) & 0x7f) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate();
    const dosTime =
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2);
    return { dosDate: dosDate & 0xffff, dosTime: dosTime & 0xffff };
  }

  function utf8Bytes(str) {
    return new TextEncoder().encode(str);
  }

  function concatUint8Arrays(arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      out.set(a, offset);
      offset += a.length;
    }
    return out;
  }

  function writeU16(view, offset, value) {
    view.setUint16(offset, value, true);
  }
  function writeU32(view, offset, value) {
    view.setUint32(offset, value, true);
  }

  /**
   * Builds a ZIP archive (STORE method) from a list of files.
   * @param {Array<{name: string, data: Uint8Array, date?: Date}>} files
   * @returns {Uint8Array} raw zip file bytes
   */
  function createZip(files) {
    const now = new Date();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = utf8Bytes(file.name.replace(/\\/g, '/'));
      const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      const crc = crc32(data);
      const { dosDate, dosTime } = toDosDateTime(file.date || now);

      // ---- Local file header ----
      const localHeader = new ArrayBuffer(30);
      const lv = new DataView(localHeader);
      writeU32(lv, 0, SIG_LOCAL_FILE_HEADER);
      writeU16(lv, 4, VERSION_NEEDED);
      writeU16(lv, 6, FLAG_UTF8);
      writeU16(lv, 8, 0); // compression method: 0 = store
      writeU16(lv, 10, dosTime);
      writeU16(lv, 12, dosDate);
      writeU32(lv, 14, crc);
      writeU32(lv, 18, data.length); // compressed size
      writeU32(lv, 22, data.length); // uncompressed size
      writeU16(lv, 26, nameBytes.length);
      writeU16(lv, 28, 0); // extra field length

      const localHeaderBytes = new Uint8Array(localHeader);
      localParts.push(localHeaderBytes, nameBytes, data);

      const localEntrySize = localHeaderBytes.length + nameBytes.length + data.length;

      // ---- Central directory header ----
      const centralHeader = new ArrayBuffer(46);
      const cv = new DataView(centralHeader);
      writeU32(cv, 0, SIG_CENTRAL_DIR_HEADER);
      writeU16(cv, 4, VERSION_MADE_BY);
      writeU16(cv, 6, VERSION_NEEDED);
      writeU16(cv, 8, FLAG_UTF8);
      writeU16(cv, 10, 0); // compression method
      writeU16(cv, 12, dosTime);
      writeU16(cv, 14, dosDate);
      writeU32(cv, 16, crc);
      writeU32(cv, 20, data.length);
      writeU32(cv, 24, data.length);
      writeU16(cv, 28, nameBytes.length);
      writeU16(cv, 30, 0); // extra field length
      writeU16(cv, 32, 0); // comment length
      writeU16(cv, 34, 0); // disk number start
      writeU16(cv, 36, 0); // internal file attributes
      writeU32(cv, 38, 0); // external file attributes
      writeU32(cv, 42, offset); // relative offset of local header

      const centralHeaderBytes = new Uint8Array(centralHeader);
      centralParts.push(centralHeaderBytes, nameBytes);

      offset += localEntrySize;
    }

    const centralDirStart = offset;
    const centralDirBytes = concatUint8Arrays(centralParts);
    const centralDirSize = centralDirBytes.length;

    const eocd = new ArrayBuffer(22);
    const ev = new DataView(eocd);
    writeU32(ev, 0, SIG_END_OF_CENTRAL_DIR);
    writeU16(ev, 4, 0); // disk number
    writeU16(ev, 6, 0); // disk with central dir
    writeU16(ev, 8, files.length); // entries on this disk
    writeU16(ev, 10, files.length); // total entries
    writeU32(ev, 12, centralDirSize);
    writeU32(ev, 16, centralDirStart);
    writeU16(ev, 20, 0); // comment length

    return concatUint8Arrays([
      ...localParts,
      centralDirBytes,
      new Uint8Array(eocd),
    ]);
  }

  const api = { crc32, createZip, toDosDateTime };

  global.IGExporter = global.IGExporter || {};
  global.IGExporter.zip = api;

  global.SocialExporter = global.SocialExporter || {};
  global.SocialExporter.zip = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
