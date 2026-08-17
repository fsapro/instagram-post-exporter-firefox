/**
 * options.js
 *
 * Wires the settings form in options.html to settings.js (browser.storage).
 * Supports per-platform settings with tabbed UI.
 */
(function () {
  'use strict';

  const { getSettings, saveSettings } = window.SocialExporter.settings;

  const PLATFORMS = ['instagram', 'linkedin'];

  async function load() {
    for (const platform of PLATFORMS) {
      const settings = await getSettings();
      const radio = document.querySelector(`input[name="exportMode-${platform}"][value="${settings.exportMode}"]`);
      if (radio) radio.checked = true;
      document.getElementById(`subfolder-${platform}`).value = settings.subfolder;
    }
  }

  async function save() {
    let allSaved = true;
    for (const platform of PLATFORMS) {
      const checked = document.querySelector(`input[name="exportMode-${platform}"]:checked`);
      const exportMode = checked ? checked.value : 'zip';
      const subfolder = document.getElementById(`subfolder-${platform}`).value;
      try {
        await saveSettings({ exportMode, subfolder });
      } catch (err) {
        console.error(`Failed to save settings for ${platform}:`, err);
        allSaved = false;
      }
    }

    const status = document.getElementById('status');
    if (allSaved) {
      status.textContent = 'Enregistré ✓';
    } else {
      status.textContent = 'Erreur lors de l\'enregistrement';
      status.style.color = '#d32f2f';
    }
    setTimeout(() => {
      status.textContent = '';
      status.style.color = '';
    }, 2000);
  }

  // Tab switching
  document.querySelectorAll('.platform-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const platform = tab.dataset.platform;
      document.querySelectorAll('.platform-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.platform-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${platform}`));
    });
  });

  document.getElementById('save').addEventListener('click', save);
  load();
})();