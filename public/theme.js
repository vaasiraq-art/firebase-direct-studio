'use strict';

(() => {
  const key = 'firebase-direct-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try { const saved = localStorage.getItem(key); if (saved === 'light' || saved === 'dark') preference = saved; } catch {}

  function apply() {
    const theme = preference || (system.matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
      toggle.setAttribute('aria-checked', String(theme === 'dark'));
      toggle.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
      document.getElementById('themeToggleLabel').textContent = theme === 'dark' ? 'Dark' : 'Light';
      document.getElementById('themeToggleIcon').textContent = theme === 'dark' ? '☾' : '☀';
      document.getElementById('themeSystemReset')?.classList.toggle('hidden', !preference);
    }
  }

  apply();
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch {}
      apply();
    });
    document.getElementById('themeSystemReset')?.addEventListener('click', () => {
      preference = null;
      try { localStorage.removeItem(key); } catch {}
      apply();
    });
    apply();
  });
  if (system.addEventListener) system.addEventListener('change', () => { if (!preference) apply(); });
  else if (system.addListener) system.addListener(() => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : null; apply(); }
  });
})();
