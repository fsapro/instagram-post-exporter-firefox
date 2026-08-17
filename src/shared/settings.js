/**
 * settings.js
 *
 * Reads/writes the extension's user-configurable export settings via
 * browser.storage.local — available to both content scripts and the
 * options page directly (unlike browser.downloads, which needs the
 * background script). Pure storage plumbing: no DOM, no network calls.
 *
 * Supports both Instagram and LinkedIn with platform-specific defaults.
 */
(function (global) {
  'use strict';

  // Default settings per platform
  const PLATFORM_DEFAULTS = {
    instagram: {
      exportMode: 'zip',
      subfolder: 'InstagramExports',
    },
    linkedin: {
      exportMode: 'zip',
      subfolder: 'LinkedInExports',
    },
  };

  // Global defaults (fallback)
  const DEFAULT_SETTINGS = {
    exportMode: 'zip',
    subfolder: 'SocialExports',
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

  /**
   * Gets the current platform from the URL (if running in content script context).
   * Falls back to 'instagram' for options page context.
   */
  function getCurrentPlatform() {
    if (typeof location !== 'undefined' && location.hostname) {
      const hostname = location.hostname.toLowerCase();
      if (hostname.includes('instagram.com')) return 'instagram';
      if (hostname.includes('linkedin.com')) return 'linkedin';
    }
    // For options page or other contexts, default to instagram
    return 'instagram';
  }

  function getDefaultsForPlatform(platform) {
    return PLATFORM_DEFAULTS[platform] || DEFAULT_SETTINGS;
  }

  async function getSettings() {
    const platform = getCurrentPlatform();
    const defaults = getDefaultsForPlatform(platform);
    const stored = await browser.storage.local.get(defaults);
    return {
      exportMode: stored.exportMode === 'embedded-md' ? 'embedded-md' : 'zip',
      subfolder: sanitizeSubfolder(stored.subfolder) || defaults.subfolder,
    };
  }

  async function saveSettings(settings) {
    const platform = getCurrentPlatform();
    const defaults = getDefaultsForPlatform(platform);
    const clean = {
      exportMode: settings.exportMode === 'embedded-md' ? 'embedded-md' : 'zip',
      subfolder: sanitizeSubfolder(settings.subfolder) || defaults.subfolder,
    };
    await browser.storage.local.set(clean);
    return clean;
  }

  // Export for both IGExporter (backward compat) and SocialExporter
  const api = { DEFAULT_SETTINGS, sanitizeSubfolder, getSettings, saveSettings, getDefaultsForPlatform, getCurrentPlatform };

  global.IGExporter = global.IGExporter || {};
  global.IGExporter.settings = api;

  global.SocialExporter = global.SocialExporter || {};
  global.SocialExporter.settings = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);