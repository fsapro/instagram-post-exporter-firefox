/**
 * markdown.js
 *
 * Builds the content of post.md from data extracted from the visible page.
 * Pure string formatting — no DOM access, no network calls.
 */
(function (global) {
  'use strict';

  function escapeForFrontMatterValue(value) {
    return String(value || '').replace(/"/g, '\\"');
  }

  /**
   * A bare "\n" is just a soft break in Markdown (most renderers collapse
   * it to a space) — a real visible line break needs a trailing double
   * space before the newline (the standard Markdown "hard break"). Applied
   * to the caption body so multi-line captions extracted from Instagram
   * (see getTextWithLineBreaks in instagramExtractor.js) keep their line
   * breaks when the .md file is rendered, not just when read as plain text.
   */
  function formatMultilineForMarkdown(text) {
    return String(text || '').split('\n').join('  \n');
  }

  function escapeAltText(alt) {
    return String(alt || '').replace(/[[\]]/g, '');
  }

  /**
   * @param {Object} data
   * @param {string} data.url - full URL of the post/reel page
   * @param {string} data.shortcode - Instagram shortcode parsed from the URL
   * @param {string} data.exportDate - ISO 8601 timestamp of when the export ran
   * @param {string} [data.postDate] - ISO 8601 timestamp of the post itself, if found in the visible DOM
   * @param {string} [data.description] - visible caption/description text
   * @param {number} [data.imageCount] - number of images included in the export
   * @param {string} [data.type] - "post" or "reel"
   * @param {Array<{alt?: string, dataUrl: string}>} [data.images] - when
   *   provided (embedded-export mode), each image is inlined directly as a
   *   Markdown image referencing its data: URI, instead of the default
   *   "N image(s) exported to the images/ folder" line (ZIP mode, where the
   *   images are separate files alongside post.md).
   * @returns {string} markdown content for post.md
   */
  function buildPostMarkdown(data) {
    const {
      url = '',
      shortcode = '',
      exportDate = new Date().toISOString(),
      postDate = null,
      description = '',
      imageCount = 0,
      type = 'post',
      images = null,
    } = data || {};

    const lines = [];
    lines.push('---');
    lines.push(`url: "${escapeForFrontMatterValue(url)}"`);
    lines.push(`shortcode: "${escapeForFrontMatterValue(shortcode)}"`);
    lines.push(`type: "${escapeForFrontMatterValue(type)}"`);
    lines.push(`export_date: "${escapeForFrontMatterValue(exportDate)}"`);
    lines.push(`post_date: "${escapeForFrontMatterValue(postDate || 'not available in visible page')}"`);
    lines.push(`image_count: ${Number.isFinite(imageCount) ? imageCount : 0}`);
    lines.push('---');
    lines.push('');
    lines.push(`# Instagram ${type === 'reel' ? 'Reel' : 'Post'} — ${shortcode}`);
    lines.push('');
    lines.push(`**URL:** ${url}`);
    lines.push('');
    lines.push(`**Export date:** ${exportDate}`);
    lines.push('');
    lines.push(`**Post date:** ${postDate || '_not available in visible page_'}`);
    lines.push('');
    lines.push('## Description');
    lines.push('');
    lines.push(description ? formatMultilineForMarkdown(description.trim()) : '_No visible description found._');
    lines.push('');
    lines.push('## Images');
    lines.push('');
    if (images && images.length) {
      images.forEach((img, i) => {
        const alt = escapeAltText(img.alt) || `image ${i + 1}`;
        lines.push(`![${alt}](${img.dataUrl})`);
        lines.push('');
      });
    } else if (imageCount > 0) {
      lines.push(`${imageCount} image(s) exported to the \`images/\` folder.`);
      lines.push('');
    } else {
      lines.push('_No images were found/exported for this post._');
      lines.push('');
    }

    return lines.join('\n');
  }

  const api = { buildPostMarkdown, formatMultilineForMarkdown };

  global.IGExporter = global.IGExporter || {};
  global.IGExporter.markdown = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
