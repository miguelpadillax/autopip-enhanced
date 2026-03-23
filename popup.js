'use strict';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
let i18n = {};

function t(key) {
  const normalizedKey = String(key).replace(/[^a-zA-Z0-9_@]/g, '_');
  return i18n[key] || i18n[normalizedKey] || key;
}

function flattenChromeMessages(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const flat = {};

  Object.entries(raw).forEach(([key, value]) => {
    if (value && typeof value.message === 'string') {
      flat[key] = value.message;
    }
  });

  return flat;
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => {
      resolve(data || {});
    });
  });
}

function storageSet(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => resolve());
  });
}

function storageClear() {
  return new Promise((resolve) => {
    chrome.storage.local.clear(() => resolve());
  });
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

async function loadLocale(lang) {
  const safeLang = lang === 'es' ? 'es' : 'en';

  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${safeLang}/messages.json`));
    const raw = await res.json();
    i18n = flattenChromeMessages(raw);
  } catch (_) {
    i18n = {};
  }

  applyI18n();
  document.documentElement.lang = safeLang;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });

  renderFooterVersion();
}

function renderFooterVersion() {
  const footer = document.querySelector('[data-i18n="popup.footer"]');
  const version = chrome?.runtime?.getManifest?.().version;
  if (!footer || !version) return;

  const baseLabel = t('popup.footer').replace(/\s*v?\d+(?:\.\d+){1,3}\s*$/i, '').trim();
  footer.textContent = `${baseLabel} v${version}`;
}

function renderSpeedButtons(lastSpeed = 1) {
  const grid = document.getElementById('speedGrid');
  grid.textContent = '';

  SPEEDS.forEach((speed) => {
    const btn = document.createElement('button');
    btn.className = 'speed-btn';
    btn.textContent = `${speed}x`;

    if (Math.abs(lastSpeed - speed) < 0.01) {
      btn.classList.add('active');
    }

    btn.addEventListener('click', async () => {
      await setSpeed(speed);
      grid.querySelectorAll('.speed-btn').forEach((item) => item.classList.remove('active'));
      btn.classList.add('active');
    });

    grid.appendChild(btn);
  });
}

async function initLanguage() {
  const data = await storageGet(['appLanguage']);
  const lang = data.appLanguage === 'es' ? 'es' : 'en';
  const select = document.getElementById('languageSelect');
  select.value = lang;
  await loadLocale(lang);
}

document.getElementById('toggleAutoPip').addEventListener('change', (e) => {
  storageSet({ autoPip: e.target.checked });
});

document.getElementById('toggleRememberSpeed').addEventListener('change', (e) => {
  storageSet({ rememberSpeed: e.target.checked });
  if (!e.target.checked) {
    chrome.storage.local.remove('lastSpeed');
  }
});

document.getElementById('togglePipOnPause').addEventListener('change', (e) => {
  storageSet({ pipOnPause: e.target.checked });
});

document.getElementById('languageSelect').addEventListener('change', async (e) => {
  const lang = e.target.value === 'es' ? 'es' : 'en';
  await storageSet({ appLanguage: lang });
  await loadLocale(lang);
});

async function setSpeed(speed) {
  const data = await storageGet(['rememberSpeed']);
  if (data.rememberSpeed !== false) {
    await storageSet({ lastSpeed: speed });
  }

  const tab = await getActiveTab();
  if (tab?.id && tab.url && tab.url.includes('youtube.com')) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SET_SPEED', speed });
    } catch (_) {}
  }
}

document.getElementById('resetStorageBtn').addEventListener('click', async () => {
  await storageClear();
  await storageSet({ autoPip: true, rememberSpeed: true, appLanguage: 'en', pipOnPause: false });
  window.location.reload();
});

async function init() {
  const data = await storageGet(['autoPip', 'rememberSpeed', 'pipOnPause', 'lastSpeed']);

  document.getElementById('toggleAutoPip').checked = data.autoPip !== false;
  document.getElementById('toggleRememberSpeed').checked = data.rememberSpeed !== false;
  document.getElementById('togglePipOnPause').checked = data.pipOnPause === true;

  renderSpeedButtons(data.lastSpeed || 1);
  await initLanguage();
}

init();
