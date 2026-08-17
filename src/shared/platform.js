/**
 * platform.js
 *
 * Platform detection and shared constants for multi-platform support.
 * Runs first in the content script bundle to establish the platform context.
 */
(function (global) {
  'use strict';

  const PLATFORM_INSTAGRAM = 'instagram';
  const PLATFORM_LINKEDIN = 'linkedin';

  /** Detect which platform we're running on based on the current URL. */
  function detectPlatform() {
    const hostname = location.hostname.toLowerCase();
    if (hostname.includes('instagram.com')) return PLATFORM_INSTAGRAM;
    if (hostname.includes('linkedin.com')) return PLATFORM_LINKEDIN;
    return null;
  }

  /** Platform-specific configuration. */
  const PLATFORM_CONFIG = {
    [PLATFORM_INSTAGRAM]: {
      name: 'Instagram',
      shortName: 'ig',
      messagePrefix: 'ig-exporter',
      buttonClassPrefix: 'ig-exporter-btn',
      processedAttr: 'data-ig-exporter-processed',
      defaultSubfolder: 'InstagramExports',
      urlPatterns: {
        post: /^\/(p|reel)\/[^/]+\/?/,
      },
    },
    [PLATFORM_LINKEDIN]: {
      name: 'LinkedIn',
      shortName: 'ln',
      messagePrefix: 'ln-exporter',
      buttonClassPrefix: 'ln-exporter-btn',
      processedAttr: 'data-ln-exporter-processed',
      defaultSubfolder: 'LinkedInExports',
      urlPatterns: {
        post: /^\/(feed\/update|posts\/|article\/)/,
      },
    },
  };

  /** Get config for the current platform. */
  function getPlatformConfig(platform) {
    return PLATFORM_CONFIG[platform] || PLATFORM_CONFIG[PLATFORM_INSTAGRAM];
  }

  const api = {
    PLATFORM_INSTAGRAM,
    PLATFORM_LINKEDIN,
    detectPlatform,
    getPlatformConfig,
  };

  global.SocialExporter = global.SocialExporter || {};
  global.SocialExporter.platform = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);