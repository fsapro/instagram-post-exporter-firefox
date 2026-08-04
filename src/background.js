/**
 * background.js
 *
 * Firefox content scripts can't call browser.downloads directly — this is
 * the one privileged call the "save straight to a subfolder" export mode
 * needs, so it lives in a tiny background script instead of a full
 * pipeline. It relays exactly one message type from content.js: "save
 * this exact already-built text content to this exact filename." It does
 * not read, decide, or transform the content itself — content.js builds
 * the complete Markdown (including embedding images as base64 data: URIs)
 * before sending it here.
 *
 * The file content arrives as a plain string, not a data: URL: Firefox's
 * downloads.download() rejects data: URLs passed to it from a background
 * script ("Access denied for URL data:...", regardless of size). The
 * Blob + URL.createObjectURL() must be created in the same context that
 * calls downloads.download() — Firefox's classic (non-service-worker)
 * background script has a full page-like global (Blob/URL/document are
 * all available), so the Blob is built right here instead.
 */
'use strict';

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'ig-exporter-save-file') return undefined;

  const blob = new Blob([message.textContent], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  return browser.downloads
    .download({
      url,
      filename: message.filename,
      saveAs: false,
      conflictAction: 'uniquify',
    })
    .finally(() => {
      // Give the download a moment to actually read the blob before revoking it.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
});
