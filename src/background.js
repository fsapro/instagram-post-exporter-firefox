/**
 * background.js
 *
 * Firefox content scripts can't call browser.downloads directly — this is
 * the one privileged call the "save straight to a subfolder" export mode
 * needs, so it lives in a tiny background script instead of a full
 * pipeline. It relays exactly one message type from content.js: "save
 * this exact already-built file content to this exact filename." It does
 * not read, decide, or transform anything about what gets saved — content.js
 * builds the complete file (including embedding images as base64) before
 * sending it here.
 */
'use strict';

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'ig-exporter-save-file') return undefined;
  return browser.downloads.download({
    url: message.dataUrl,
    filename: message.filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
});
