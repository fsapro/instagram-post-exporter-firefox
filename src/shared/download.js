/**
 * download.js
 *
 * Triggers a local file save for a Blob using the standard
 * object-URL + <a download> technique. This is plain DOM behaviour (the
 * same thing any web page can do to offer a file download) and does not
 * require the "downloads" WebExtension permission or a background script.
 */
(function (global) {
  'use strict';

  /**
   * @param {Blob} blob
   * @param {string} filename
   */
  function downloadBlob(blob, filename) {
    const doc = global.document;
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    doc.body.appendChild(link);
    link.click();
    doc.body.removeChild(link);
    // Give the browser time to pick up the object URL before revoking it.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  const api = { downloadBlob };

  global.IGExporter = global.IGExporter || {};
  global.IGExporter.download = api;

  global.SocialExporter = global.SocialExporter || {};
  global.SocialExporter.download = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
