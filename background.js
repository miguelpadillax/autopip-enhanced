'use strict';

const pendingDestinationByYouTubeTab = new Map();
const interactedYouTubeTabs = new Set();
const gateInProgressByYouTubeTab = new Set();
const gateStartedAtByYouTubeTab = new Map();
const bypassNextDestinationByYouTubeTab = new Map();
const GATE_STALE_TIMEOUT_MS = 10000;

function clearStaleGateIfNeeded(youtubeTabId) {
  if (!gateInProgressByYouTubeTab.has(youtubeTabId)) return;

  const startedAt = gateStartedAtByYouTubeTab.get(youtubeTabId) || 0;
  if (Date.now() - startedAt < GATE_STALE_TIMEOUT_MS) return;

  gateInProgressByYouTubeTab.delete(youtubeTabId);
  gateStartedAtByYouTubeTab.delete(youtubeTabId);
  pendingDestinationByYouTubeTab.delete(youtubeTabId);
}

function consumeBypassIfMatches(youtubeTabId, destinationTabId) {
  if (!youtubeTabId || !destinationTabId) return false;

  const bypass = bypassNextDestinationByYouTubeTab.get(youtubeTabId);
  if (!bypass) return false;
  if (bypass.destTabId !== destinationTabId) return false;

  bypass.remainingChecks -= 1;
  if (bypass.remainingChecks <= 0) {
    bypassNextDestinationByYouTubeTab.delete(youtubeTabId);
  } else {
    bypassNextDestinationByYouTubeTab.set(youtubeTabId, bypass);
  }

  return true;
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const { autoPip = true, pipOnPause = false } = await chrome.storage.local.get(['autoPip', 'pipOnPause']);
  if (!autoPip) return;

  let destinationTab;
  try {
    destinationTab = await chrome.tabs.get(tabId);
  } catch (_) {
    return;
  }

  if (isYouTubeTab(destinationTab.url)) return;

  const allTabs = await chrome.tabs.query({ windowId });

  for (const youtubeTab of allTabs) {
    if (youtubeTab.id === tabId) continue;
    if (!isYouTubeTab(youtubeTab.url)) continue;

    clearStaleGateIfNeeded(youtubeTab.id);

    if (consumeBypassIfMatches(youtubeTab.id, destinationTab.id)) {
      continue;
    }

    try {
      await chrome.tabs.get(youtubeTab.id);
    } catch (_) {
      continue;
    }

    const status = await safeGetYouTubeStatus(youtubeTab.id);
    const hasInteracted = status?.hasInteracted ?? interactedYouTubeTabs.has(youtubeTab.id);
    const isInPiP = status?.isInPiP ?? false;
    const isPlaying = status?.isPlaying ?? await probeIsPlaying(youtubeTab.id);
    const hasVideo = status?.hasVideo ?? await probeHasVideo(youtubeTab.id);
    const qualifiesForPiP = isPlaying || (pipOnPause && hasVideo);

    if (qualifiesForPiP && !hasInteracted && !isInPiP) {
      if (gateInProgressByYouTubeTab.has(youtubeTab.id)) continue;

      const pendingDest = pendingDestinationByYouTubeTab.get(youtubeTab.id);
      if (pendingDest === destinationTab.id) continue;

      try {
        await startInteractionGate(youtubeTab, destinationTab);
      } catch (_) {}
      break;
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'USER_INTERACTED') {
    if (sender.tab?.id) {
      interactedYouTubeTabs.add(sender.tab.id);
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'USER_INTERACTION_RESET') {
    if (sender.tab?.id) {
      interactedYouTubeTabs.delete(sender.tab.id);
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'NEEDS_INTERACTION_PROMPT') {
    handleInteractionPromptFallback(sender.tab)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'INTERACTION_GATE_CONFIRMED') {
    const youtubeTabId = sender.tab?.id;
    if (!youtubeTabId) {
      sendResponse({ ok: false });
      return;
    }

    const pendingDestTabId = pendingDestinationByYouTubeTab.get(youtubeTabId);
    const destTabId = msg.destTabId || pendingDestTabId;
    pendingDestinationByYouTubeTab.delete(youtubeTabId);
    gateInProgressByYouTubeTab.delete(youtubeTabId);
    gateStartedAtByYouTubeTab.delete(youtubeTabId);

    if (!destTabId) {
      sendResponse({ ok: false });
      return;
    }

    if (!msg.pipActivated) {
      sendResponse({ ok: false, reason: 'pip-not-activated' });
      return;
    }

    activateTabWithRetry(destTabId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'INTERACTION_GATE_CANCELLED') {
    const youtubeTabId = sender.tab?.id;
    if (youtubeTabId) {
      const pendingDestTabId = pendingDestinationByYouTubeTab.get(youtubeTabId);
      const destTabId = msg.destTabId || pendingDestTabId;
      pendingDestinationByYouTubeTab.delete(youtubeTabId);
      gateInProgressByYouTubeTab.delete(youtubeTabId);
      gateStartedAtByYouTubeTab.delete(youtubeTabId);

      if (destTabId) {
        bypassNextDestinationByYouTubeTab.set(youtubeTabId, {
          destTabId,
          remainingChecks: 2
        });
        activateTabWithRetry(destTabId)
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      }
    }
    sendResponse({ ok: true });
    return;
  }
});

function isYouTubeTab(url) {
  return Boolean(
    url && (url.startsWith('https://www.youtube.com/') || url.startsWith('https://youtube.com/'))
  );
}

async function safeGetYouTubeStatus(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
  } catch (_) {
    return null;
  }
}

async function probeIsPlaying(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') return false;

    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const video =
          document.querySelector('video.html5-main-video') ||
          document.querySelector('#movie_player video') ||
          document.querySelector('video');
        return Boolean(video && !video.paused);
      }
    });
    return Boolean(result?.result);
  } catch (_) {
    return false;
  }
}

async function probeHasVideo(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') return false;

    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(
        document.querySelector('video.html5-main-video') ||
        document.querySelector('#movie_player video') ||
        document.querySelector('video')
      )
    });
    return Boolean(result?.result);
  } catch (_) {
    return false;
  }
}

async function startInteractionGate(youtubeTab, destinationTab) {
  if (!youtubeTab?.id || !destinationTab?.id) return false;

  if (gateInProgressByYouTubeTab.has(youtubeTab.id)) {
    return true;
  }
  gateInProgressByYouTubeTab.add(youtubeTab.id);
  gateStartedAtByYouTubeTab.set(youtubeTab.id, Date.now());

  pendingDestinationByYouTubeTab.set(youtubeTab.id, destinationTab.id);

  await activateTabWithRetry(youtubeTab.id);

  try {
    await chrome.tabs.sendMessage(youtubeTab.id, {
      type: 'SHOW_INTERACTION_GATE',
      destTabId: destinationTab.id
    });
    return true;
  } catch (_) {
    pendingDestinationByYouTubeTab.delete(youtubeTab.id);
    gateInProgressByYouTubeTab.delete(youtubeTab.id);
    gateStartedAtByYouTubeTab.delete(youtubeTab.id);
    return false;
  }
}

async function handleInteractionPromptFallback(sourceTab) {
  if (!sourceTab?.id || typeof sourceTab.windowId !== 'number') return;

  const { autoPip = true } = await chrome.storage.local.get(['autoPip']);
  if (!autoPip) return;

  const [destinationTab] = await chrome.tabs.query({ active: true, windowId: sourceTab.windowId });
  if (!destinationTab?.id || destinationTab.id === sourceTab.id) return;

  if (consumeBypassIfMatches(sourceTab.id, destinationTab.id)) {
    return;
  }

  try {
    await startInteractionGate(sourceTab, destinationTab);
  } catch (_) {}
}

async function activateTabWithRetry(tabId, attempts = 5) {
  let lastError;

  for (let i = 0; i < attempts; i++) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      return;
    } catch (err) {
      lastError = err;
      const message = String(err?.message || '');
      const transient =
        message.includes('Tabs cannot be edited right now') ||
        message.includes('No tab with id') ||
        message.includes('Tab not found');

      if (!transient || i === attempts - 1) {
        throw err;
      }
      await sleep(40 * (i + 1));
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  interactedYouTubeTabs.delete(tabId);
  pendingDestinationByYouTubeTab.delete(tabId);
  gateInProgressByYouTubeTab.delete(tabId);
  gateStartedAtByYouTubeTab.delete(tabId);
  bypassNextDestinationByYouTubeTab.delete(tabId);
});
