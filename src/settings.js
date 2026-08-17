/**
 * settings.js
 *
 * Reads/writes the extension's user-configurable export settings via
 * browser.storage.local — available to both content scripts and the
 * options page directly (unlike browser.downloads, which needs the
 * background script). Pure storage plumbing: no DOM, no network calls.
 */
(function (global) {
  'use strict';

  const DEFAULT_SETTINGS = {
    // 'zip': today's behavior — images/ + post.md downloaded as one .zip.
    // 'embedded-md': a single .md per post, carousel images inlined as
    // base64 data: URIs, written directly into a subfolder of Firefox's
    // downloads directory (no .zip, no separate image files).
    exportMode: 'zip',
    subfolder: 'InstagramExports',
  };

  /**
   * Strips empty/traversal path segments ("..", ".") and normalizes
   * backslashes, so a subfolder name from the options page can't be used
   * to write outside Firefox's downloads directory or its own subtree.
   */
  function sanitizeSubfolder(name) {
    return String(name || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((seg) => seg.trim())
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .join('/');
  }

  async function getSettings() {
    const stored = await browser.storage.local.get(DEFAULT_SETTINGS);
    return {
      exportMode: stored.exportMode === 'embedded-md' ? 'embedded-md' : 'zip',
      subfolder: sanitizeSubfolder(stored.subfolder) || DEFAULT_SETTINGS.subfolder,
    };
  }

  async function saveSettings(settings) {
    const clean = {
      exportMode: settings.exportMode === 'embedded-md' ? 'embedded-md' : 'zip',
      subfolder: sanitizeSubfolder(settings.subfolder) || DEFAULT_SETTINGS.subfolder,
    };
    await browser.storage.local.set(clean);
    return clean;
  }

  const api = { DEFAULT_SETTINGS, sanitizeSubfolder, getSettings, saveSettings };

  global.IGExporter = global.IGExporter || {};
  global.IGExporter.settings = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
