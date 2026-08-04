/**
 * options.js
 *
 * Wires the settings form in options.html to settings.js (browser.storage).
 */
(function () {
  'use strict';

  const { getSettings, saveSettings } = window.IGExporter.settings;

  async function load() {
    const settings = await getSettings();
    const radio = document.querySelector(`input[name="exportMode"][value="${settings.exportMode}"]`);
    if (radio) radio.checked = true;
    document.getElementById('subfolder').value = settings.subfolder;
  }

  async function save() {
    const checked = document.querySelector('input[name="exportMode"]:checked');
    const exportMode = checked ? checked.value : 'zip';
    const subfolder = document.getElementById('subfolder').value;
    const saved = await saveSettings({ exportMode, subfolder });
    document.getElementById('subfolder').value = saved.subfolder;

    const status = document.getElementById('status');
    status.textContent = 'Enregistré ✓';
    setTimeout(() => {
      status.textContent = '';
    }, 2000);
  }

  document.getElementById('save').addEventListener('click', save);
  load();
})();
