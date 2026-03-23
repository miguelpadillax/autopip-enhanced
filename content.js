(function () {
  'use strict';

  const scriptStartedAt = Date.now();
  const INTERACTION_EVENTS = ['click', 'keydown', 'mousedown', 'pointerdown', 'touchstart'];

  let hasUserInteracted = false;
  let isInPiP = false;
  let pipWindow = null;
  let interactionGateVisible = false;
  let lastVideoKey = getCurrentVideoKey();
  let suppressPromptUntilVisible = false;
  let wasHiddenSinceLastVisible = false;
  let lastKnownVideoSrc = '';
  let allowPausedPiP = false;
  let i18n = {};
  let gateStylesInjected = false;

  function hasExtensionContext() {
    return Boolean(chrome?.runtime?.id);
  }

  async function safeStorageGet(keys) {
    if (!hasExtensionContext()) return {};
    try {
      return await chrome.storage.local.get(keys);
    } catch (_) {
      return {};
    }
  }

  function safeStorageGetCb(keys, callback) {
    if (!hasExtensionContext()) return;
    try {
      chrome.storage.local.get(keys, (data) => {
        if (chrome.runtime.lastError) return;
        callback(data || {});
      });
    } catch (_) {}
  }

  function safeStorageSet(data) {
    if (!hasExtensionContext()) return;
    try {
      chrome.storage.local.set(data);
    } catch (_) {}
  }

  function safeSendMessage(message) {
    if (!hasExtensionContext()) return;
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch (_) {}
  }

  function t(key, fallback) {
    const normalizedKey = String(key).replace(/[^a-zA-Z0-9_@]/g, '_');
    return i18n[key] || i18n[normalizedKey] || fallback;
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

  async function loadLocale() {
    const data = await safeStorageGet(['appLanguage']);
    const lang = data.appLanguage === 'es' ? 'es' : 'en';
    try {
      if (!hasExtensionContext()) {
        i18n = {};
        return;
      }
      const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
      const raw = await res.json();
      i18n = flattenChromeMessages(raw);
    } catch (_) {
      i18n = {};
    }
  }

  async function loadSettings() {
    const data = await safeStorageGet(['pipOnPause']);
    allowPausedPiP = data.pipOnPause === true;
  }

  function markInteracted(event) {
    if (!event || !event.isTrusted) return;
    if (Date.now() - scriptStartedAt < 1000) return;
    if (!document.hasFocus() || document.hidden) return;
    if (!isMeaningfulManualInteraction(event)) return;

    if (!hasUserInteracted) {
      hasUserInteracted = true;
      safeSendMessage({ type: 'USER_INTERACTED' });
    }
  }

  function isMeaningfulManualInteraction(event) {
    const target = event.target;
    const element = target && target.nodeType === Node.ELEMENT_NODE
      ? target
      : target?.parentElement || null;

    if (element && typeof element.closest === 'function') {
      if (element.closest('#autopip-gate-overlay')) return false;
    }

    if (event.type === 'keydown') {
      return !event.ctrlKey && !event.metaKey && !event.altKey;
    }

    return true;
  }

  function getCurrentVideoKey() {
    try {
      const url = new URL(window.location.href);
      if (url.pathname === '/watch') return `watch:${url.searchParams.get('v') || ''}`;
      return `${url.pathname}${url.search}`;
    } catch (_) {
      return window.location.href;
    }
  }

  function resetInteractionState() {
    if (!hasUserInteracted) return;
    hasUserInteracted = false;
    safeSendMessage({ type: 'USER_INTERACTION_RESET' });
  }

  function persistSpeedIfEnabled(speed) {
    safeStorageGetCb(['rememberSpeed'], (data) => {
      if (data.rememberSpeed !== false) {
        safeStorageSet({ lastSpeed: speed });
      }
    });
  }

  INTERACTION_EVENTS.forEach((evt) => {
    document.addEventListener(evt, markInteracted, { passive: true, capture: true });
  });

  function getVideo() {
    return (
      document.querySelector('video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video')
    );
  }

  async function ensureVideoMetadataReady(video) {
    if (!video) return;
    if (video.readyState >= 1) return;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('metadata-timeout'));
      }, 2500);

      function onLoaded() {
        cleanup();
        resolve();
      }

      function cleanup() {
        clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onLoaded);
      }

      video.addEventListener('loadedmetadata', onLoaded, { once: true });
    });
  }

  function installVideoHooks(video) {
    if (!video || video._autopipHooksInstalled) return;
    video._autopipHooksInstalled = true;

    const applyRememberedSpeed = () => restoreSpeed(video);
    video.addEventListener('loadedmetadata', applyRememberedSpeed);
    video.addEventListener('play', applyRememberedSpeed);
  }

  async function enterPiP(options = {}) {
    const { allowPaused = false } = options;
    const video = getVideo();
    if (!video || isInPiP) return false;
    if (video.paused && !allowPaused) return false;

    try {
      await ensureVideoMetadataReady(video);
      pipWindow = await video.requestPictureInPicture();
      isInPiP = true;

      registerMediaSessionActions(video);

      pipWindow.addEventListener('leavepictureinpicture', () => {
        isInPiP = false;
        pipWindow = null;
      });

      return true;
    } catch (_) {
      return false;
    }
  }

  async function exitPiP() {
    if (!isInPiP) return;
    try {
      await document.exitPictureInPicture();
    } catch (_) {}
    isInPiP = false;
    pipWindow = null;
  }

  function registerMediaSessionActions(video) {
    if (!navigator.mediaSession) return;
    const speedSteps = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];

    try {
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        const cur = video.playbackRate;
        const idx = speedSteps.findIndex((s) => Math.abs(s - cur) < 0.01);
        const next = idx > 0 ? speedSteps[idx - 1] : speedSteps[0];
        video.playbackRate = next;
        showSpeedToast(next);
        persistSpeedIfEnabled(next);
      });

      navigator.mediaSession.setActionHandler('nexttrack', () => {
        const cur = video.playbackRate;
        const idx = speedSteps.findIndex((s) => Math.abs(s - cur) < 0.01);
        const next = idx < speedSteps.length - 1 ? speedSteps[idx + 1] : speedSteps[speedSteps.length - 1];
        video.playbackRate = next;
        showSpeedToast(next);
        persistSpeedIfEnabled(next);
      });
    } catch (_) {}
  }

  function showSpeedToast(speed) {
    let toast = document.getElementById('autopip-speed-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'autopip-speed-toast';
      toast.style.cssText = [
        'position: fixed',
        'bottom: 80px',
        'left: 50%',
        'transform: translateX(-50%)',
        'background: rgba(0,0,0,0.82)',
        'color: #fff',
        'font-family: Menlo, Monaco, "Lucida Console", Consolas, "Courier New", monospace',
        'font-size: 14px',
        'font-weight: 600',
        'letter-spacing: 0.03em',
        'padding: 8px 18px',
        'border-radius: 999px',
        'z-index: 999999',
        'pointer-events: none',
        'opacity: 0',
        'transition: opacity 0.2s ease'
      ].join(';');
      document.body.appendChild(toast);
    }

    toast.textContent = `${speed}x`;
    toast.style.opacity = '1';
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
      toast.style.opacity = '0';
    }, 1600);
  }

  function ensureGateStyles() {
    if (gateStylesInjected) return;
    if (!document.head) return;

    const style = document.createElement('style');
    style.id = 'autopip-gate-styles';
    style.textContent = `
      #autopip-gate-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding: 10px;
        background: rgba(8, 8, 12, 0.58);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        font-family: Menlo, Monaco, "Lucida Console", Consolas, "Courier New", monospace;
      }

      .autopip-gate-card {
        width: min(480px, 100%);
        margin-top: 1px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        background:
          radial-gradient(140px 90px at 10% -20%, rgba(255, 132, 71, 0.3), transparent 75%),
          radial-gradient(170px 100px at 90% -20%, rgba(255, 45, 85, 0.25), transparent 75%),
          rgba(21, 21, 28, 0.96);
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
        color: #fff;
        padding: 16px 18px;
      }

      .autopip-gate-title {
        font-size: 15px;
        line-height: 1.2;
        font-weight: 700;
        margin-bottom: 6px;
      }

      .autopip-gate-subtitle {
        font-size: 12px;
        line-height: 1.95;
        color: rgba(255, 255, 255, 0.76);
        margin-bottom: 12px;
      }

      .autopip-gate-actions {
        display: grid;
        gap: 8px;
      }

      .autopip-gate-btn {
        width: 100%;
        border-radius: 11px;
        border: 1px solid transparent;
        cursor: pointer;
        font-family: inherit;
        transition: transform 0.15s ease, filter 0.15s ease;
      }

      .autopip-gate-btn-primary {
        padding: 11px 13px;
        border: 0;
        font-size: 13px;
        font-weight: 700;
        color: #fff;
        background: linear-gradient(135deg, #ff5a3d, #ff2d55);
      }

      .autopip-gate-btn-secondary {
        padding: 10px 13px;
        font-size: 13px;
        color: rgba(255, 255, 255, 0.9);
        border-color: rgba(255, 255, 255, 0.16);
        background: rgba(255, 255, 255, 0.08);
      }
    `;

    document.head.appendChild(style);
    gateStylesInjected = true;
  }

  function showInteractionGateOverlay(destTabId) {
    if (interactionGateVisible) return;
    interactionGateVisible = true;
    ensureGateStyles();

    const existing = document.getElementById('autopip-gate-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'autopip-gate-overlay';

    const card = document.createElement('div');
    card.className = 'autopip-gate-card';

    const title = document.createElement('div');
    title.className = 'autopip-gate-title';
    title.textContent = t('gate.title', 'Confirm to continue');

    const subtitle = document.createElement('div');
    subtitle.className = 'autopip-gate-subtitle';
    subtitle.textContent = t('gate.subtitle', 'Leaving this tab requires one interaction first.');

    const actions = document.createElement('div');
    actions.className = 'autopip-gate-actions';

    const continueBtn = document.createElement('button');
    continueBtn.id = 'autopip-gate-continue';
    continueBtn.className = 'autopip-gate-btn autopip-gate-btn-primary';
    continueBtn.textContent = t('gate.continue', 'Enable PiP and switch tab');

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'autopip-gate-cancel';
    cancelBtn.className = 'autopip-gate-btn autopip-gate-btn-secondary';
    cancelBtn.textContent = t('gate.cancel', 'Continue without PiP');

    actions.appendChild(continueBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(actions);

    overlay.appendChild(card);
    (document.body || document.documentElement).appendChild(overlay);

    const cleanup = () => {
      interactionGateVisible = false;
      overlay.remove();
    };

    continueBtn.addEventListener('click', async () => {
      hasUserInteracted = true;
      suppressPromptUntilVisible = true;
      const pipActivated = await enterPiP({ allowPaused: allowPausedPiP });

      if (!pipActivated) {
        suppressPromptUntilVisible = false;
      }
      hasUserInteracted = false;

      cleanup();
      safeSendMessage({
        type: 'INTERACTION_GATE_CONFIRMED',
        destTabId,
        pipActivated
      });
    });

    cancelBtn.addEventListener('click', () => {
      cleanup();
      safeSendMessage({ type: 'INTERACTION_GATE_CANCELLED', destTabId });
    });
  }

  async function handleVisibilityChange() {
    const video = getVideo();
    if (!video) return;
    if (video.paused && !allowPausedPiP) return;

    if (document.hidden) {
      wasHiddenSinceLastVisible = true;

      if (isInPiP || suppressPromptUntilVisible) {
        return;
      }

      if (hasUserInteracted) {
        await enterPiP({ allowPaused: allowPausedPiP });
      } else {
        safeSendMessage({ type: 'NEEDS_INTERACTION_PROMPT' });
      }
    } else {
      suppressPromptUntilVisible = false;

      if (wasHiddenSinceLastVisible) {
        resetInteractionState();
        wasHiddenSinceLastVisible = false;
      }

      if (isInPiP) {
        await exitPiP();
      }
    }
  }

  function restoreSpeed(video) {
    safeStorageGetCb(['rememberSpeed', 'lastSpeed'], (data) => {
      if (data.rememberSpeed !== false && data.lastSpeed && video) {
        if (Math.abs(video.playbackRate - data.lastSpeed) > 0.01) {
          video.playbackRate = data.lastSpeed;
        }
      }
    });
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);

  const observer = new MutationObserver(() => {
    const video = getVideo();
    if (video) {
      installVideoHooks(video);
      if (!video._autopipSetup) {
        video._autopipSetup = true;
      }
      restoreSpeed(video);

      if (video.currentSrc && video.currentSrc !== lastKnownVideoSrc) {
        lastKnownVideoSrc = video.currentSrc;
        restoreSpeed(video);
      }
    }

    const currentKey = getCurrentVideoKey();
    if (currentKey !== lastVideoKey) {
      lastVideoKey = currentKey;
      resetInteractionState();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  const initialVideo = getVideo();
  if (initialVideo) {
    installVideoHooks(initialVideo);
    initialVideo._autopipSetup = true;
    lastKnownVideoSrc = initialVideo.currentSrc || '';
    restoreSpeed(initialVideo);
  }

  hasUserInteracted = false;
  safeSendMessage({ type: 'USER_INTERACTION_RESET' });
  loadLocale();
  loadSettings();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.appLanguage) {
      loadLocale();
    }
    if (area === 'local' && changes.pipOnPause) {
      allowPausedPiP = changes.pipOnPause.newValue === true;
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SHOW_INTERACTION_GATE') {
      showInteractionGateOverlay(msg.destTabId);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'FORCE_PIP_AFTER_INTERACTION') {
      hasUserInteracted = true;
      enterPiP({ allowPaused: allowPausedPiP }).then((ok) => sendResponse({ ok }));
      return true;
    }

    if (msg.type === 'GET_STATUS') {
      sendResponse({
        hasInteracted: hasUserInteracted,
        isInPiP,
        hasVideo: Boolean(getVideo()),
        isPlaying: (() => {
          const v = getVideo();
          return v ? !v.paused : false;
        })(),
        currentSpeed: (() => {
          const v = getVideo();
          return v ? v.playbackRate : 1;
        })()
      });
    }

    if (msg.type === 'SET_SPEED') {
      const v = getVideo();
      if (v) {
        v.playbackRate = msg.speed;
        persistSpeedIfEnabled(msg.speed);
        showSpeedToast(msg.speed);
      }
    }
  });
})();
