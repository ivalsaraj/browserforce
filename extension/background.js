// BrowserForce — MV3 Service Worker
// Bridges relay server commands to chrome.debugger API on real browser tabs.

const RELAY_URL_DEFAULT = 'ws://127.0.0.1:19222/extension';
const RECONNECT_DELAY_MS = 3000;
const CDP_VERSION = '1.3';

// ─── State ───────────────────────────────────────────────────────────────────

let ws = null;
let connectionState = 'disconnected'; // disconnected | connecting | connected
let maintainLoopActive = false;

/** @type {Map<number, { sessionId: string, targetId: string, targetInfo: object }>} */
const attachedTabs = new Map();

/** @type {Map<string, number>} Chrome child sessionId -> parent tabId */
const childSessions = new Map();

/** Serializes tab group operations to avoid races (same pattern as playwriter) */
let tabGroupQueue = Promise.resolve();

/** Tracks last CDP activity per attached tab (tabId → timestamp ms) */
const tabLastActivity = new Map();
/** Tracks tabs created by the agent via createTab() */
const agentCreatedTabs = new Set();
/** Auto-detach check interval handle */
let autoManageInterval = null;

// ─── Initialization ──────────────────────────────────────────────────────────

(async function init() {
  const stored = await chrome.storage.local.get(['relayUrl']);
  const relayUrl = stored.relayUrl || RELAY_URL_DEFAULT;

  // Register debugger listeners once (persists across reconnections)
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.addListener(onDebuggerDetach);

  // Tab lifecycle
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.tabs.onUpdated.addListener(onTabUpdated);

  // Alarm-based fallback: wakes the service worker if it was killed
  chrome.alarms.create('bf-reconnect', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'bf-reconnect' && !ws) {
      startMaintainLoop(relayUrl);
    }
  });

  startMaintainLoop(relayUrl);
})();

// ─── Connection Management ───────────────────────────────────────────────────

function startMaintainLoop(relayUrl) {
  if (maintainLoopActive) return;
  maintainLoopActive = true;
  maintainConnection(relayUrl);
}

async function maintainConnection(relayUrl) {
  while (true) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (connectionState !== 'connecting') {
        connectionState = 'connecting';
        updateBadge();
      }

      try {
        await connect(relayUrl);
      } catch {
        connectionState = 'disconnected';
        updateBadge();
      }
    }

    await sleep(ws?.readyState === WebSocket.OPEN ? 1000 : RECONNECT_DELAY_MS);
  }
}

function connect(relayUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(relayUrl);

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.close();
        reject(new Error('Connection timeout'));
      }
    }, 5000);

    socket.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws = socket;
      connectionState = 'connected';
      updateBadge();
      console.log('[bf] Connected to relay');
      resolve();
    });

    socket.addEventListener('message', (event) => {
      try {
        handleRelayMessage(JSON.parse(event.data));
      } catch (e) {
        console.error('[bf] Message parse error:', e);
      }
    });

    socket.addEventListener('close', () => {
      clearTimeout(timeout);
      ws = null;
      connectionState = 'disconnected';
      updateBadge();
      console.log('[bf] Disconnected from relay');
      if (!settled) {
        settled = true;
        reject(new Error('Connection closed'));
      }
    });

    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new Error('Connection error'));
      }
    });
  });
}

// ─── Relay Message Handling ──────────────────────────────────────────────────

function handleRelayMessage(msg) {
  if (msg.method === 'ping') {
    send({ method: 'pong' });
    return;
  }

  // Command from relay (has id)
  if (msg.id !== undefined) {
    executeCommand(msg)
      .then((result) => send({ id: msg.id, result }))
      .catch((err) => send({ id: msg.id, error: err.message || String(err) }));
  }
}

async function executeCommand(msg) {
  switch (msg.method) {
    case 'listTabs':
      return listTabs();
    case 'attachTab':
      return attachTab(msg.params.tabId, msg.params.sessionId);
    case 'detachTab':
      return detachTab(msg.params.tabId);
    case 'createTab':
      return createTab(msg.params);
    case 'closeTab':
      return closeTab(msg.params);
    case 'cdpCommand':
      tabLastActivity.set(msg.params.tabId, Date.now());
      return cdpCommand(msg.params);
    default:
      throw new Error(`Unknown command: ${msg.method}`);
  }
}

// ─── Tab Operations ──────────────────────────────────────────────────────────

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs
      .filter((t) => {
        const url = t.url || '';
        return (
          !url.startsWith('chrome://') &&
          !url.startsWith('chrome-extension://') &&
          !url.startsWith('edge://') &&
          !url.startsWith('devtools://') &&
          !url.startsWith('about:devtools')
        );
      })
      .map((t) => ({
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
      })),
  };
}

async function attachTab(tabId, sessionId) {
  // If already attached, update sessionId and return existing info
  if (attachedTabs.has(tabId)) {
    const existing = attachedTabs.get(tabId);
    existing.sessionId = sessionId;
    return existing;
  }

  // Attach debugger
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (e) {
    // Handle "already attached" edge case (e.g., previous SW lifetime)
    if (!e.message?.includes('attached')) throw e;
  }

  // Enable Page domain for navigation events
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');

  // Get real target info from Chrome
  let targetId;
  let targetInfo;
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
    targetInfo = result.targetInfo;
    targetId = targetInfo.targetId;
  } catch {
    // Fallback: synthesize from tab info
    const tab = await chrome.tabs.get(tabId);
    targetId = `tab-${tabId}`;
    targetInfo = { targetId, type: 'page', title: tab.title, url: tab.url };
  }

  const entry = { sessionId, targetId, targetInfo, tabId };
  attachedTabs.set(tabId, entry);
  updateBadge();
  tabLastActivity.set(tabId, Date.now());
  queueSyncTabGroup();

  return entry;
}

async function detachTab(tabId) {
  if (!attachedTabs.has(tabId)) return {};

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Tab might already be gone
  }

  cleanupTab(tabId);
  queueSyncTabGroup();
  return {};
}

async function createTab(params) {
  const tab = await chrome.tabs.create({
    url: params.url || 'about:blank',
    active: false,
  });

  // Brief delay for Chrome to finalize tab creation
  await sleep(200);

  const result = await attachTab(tab.id, params.sessionId);
  agentCreatedTabs.add(tab.id);
  return result;
}

async function closeTab(params) {
  const { tabId } = params;

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // May already be detached
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Tab may already be closed
  }

  cleanupTab(tabId);
  return {};
}

// ─── CDP Command Forwarding ──────────────────────────────────────────────────

async function cdpCommand({ tabId, method, params, childSessionId }) {
  // Special handling: Runtime.enable needs the disable-then-enable trick
  // to force Chrome to re-emit executionContextCreated events
  if (method === 'Runtime.enable' && !childSessionId) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.disable');
      await sleep(50);
    } catch {
      // Ignore errors from disable
    }
  }

  const debuggee = childSessionId
    ? { tabId, sessionId: childSessionId }
    : { tabId };

  const result = await chrome.debugger.sendCommand(debuggee, method, params || {});
  return result || {};
}

// ─── Debugger Event Listeners ────────────────────────────────────────────────

function onDebuggerEvent(source, method, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const entry = attachedTabs.get(source.tabId);
  if (!entry) return;

  // Track child sessions (for iframes / OOPIFs)
  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessions.set(params.sessionId, source.tabId);
  }
  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessions.delete(params.sessionId);
  }

  send({
    method: 'cdpEvent',
    params: {
      tabId: source.tabId,
      method,
      params,
      childSessionId: source.sessionId || undefined,
    },
  });
}

function onDebuggerDetach(source, reason) {
  if (reason === 'canceled_by_user') {
    // Chrome detaches ALL debugger sessions when user clicks "Cancel"
    for (const [tabId] of attachedTabs) {
      send({
        method: 'tabDetached',
        params: { tabId, reason },
      });
      tabLastActivity.delete(tabId);
      agentCreatedTabs.delete(tabId);
    }
    attachedTabs.clear();
    childSessions.clear();
    queueSyncTabGroup();
  } else {
    if (attachedTabs.has(source.tabId)) {
      send({
        method: 'tabDetached',
        params: { tabId: source.tabId, reason },
      });
      cleanupTab(source.tabId);
      queueSyncTabGroup();
    }
  }

  updateBadge();
}

// ─── Tab Lifecycle Events ────────────────────────────────────────────────────

function onTabRemoved(tabId) {
  if (!attachedTabs.has(tabId)) return;

  send({
    method: 'tabDetached',
    params: { tabId, reason: 'tab_closed' },
  });
  cleanupTab(tabId);
  updateBadge();
  queueSyncTabGroup();
}

function onTabUpdated(tabId, changeInfo) {
  if (!attachedTabs.has(tabId)) return;
  if (!changeInfo.url && !changeInfo.title) return;

  const entry = attachedTabs.get(tabId);
  if (changeInfo.url) entry.targetInfo.url = changeInfo.url;
  if (changeInfo.title) entry.targetInfo.title = changeInfo.title;

  send({
    method: 'tabUpdated',
    params: {
      tabId,
      url: changeInfo.url,
      title: changeInfo.title,
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanupTab(tabId) {
  attachedTabs.delete(tabId);
  for (const [childId, parentTabId] of childSessions) {
    if (parentTabId === tabId) childSessions.delete(childId);
  }
  tabLastActivity.delete(tabId);
  agentCreatedTabs.delete(tabId);
}

// ─── Auto-Detach / Auto-Close ─────────────────────────────────────────────

function startAutoManageTimer() {
  if (autoManageInterval) return;
  autoManageInterval = setInterval(checkInactiveTabs, 60_000);
}

function stopAutoManageTimer() {
  if (!autoManageInterval) return;
  clearInterval(autoManageInterval);
  autoManageInterval = null;
}

async function checkInactiveTabs() {
  const settings = await chrome.storage.local.get(['autoDetachMinutes', 'autoCloseMinutes']);
  const detachMs = (settings.autoDetachMinutes || 0) * 60_000;
  const closeMs = (settings.autoCloseMinutes || 0) * 60_000;

  if (!detachMs && !closeMs) return;

  const now = Date.now();
  // Snapshot keys — iteration-safe since we mutate inside the loop
  const entries = [...tabLastActivity.entries()];

  for (const [tabId, lastActivity] of entries) {
    const idle = now - lastActivity;

    // Auto-close takes precedence for agent-created tabs
    if (closeMs && agentCreatedTabs.has(tabId) && idle >= closeMs) {
      console.log(`[bf] Auto-closing agent tab ${tabId} (idle ${Math.round(idle / 60_000)}m)`);
      await closeTab({ tabId });
      continue;
    }

    // Auto-detach: full cleanup (debugger + ungroup)
    if (detachMs && idle >= detachMs) {
      console.log(`[bf] Auto-detaching tab ${tabId} (idle ${Math.round(idle / 60_000)}m)`);
      await detachTab(tabId);
    }
  }
}

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.autoDetachMinutes || changes.autoCloseMinutes) {
    const settings = await chrome.storage.local.get(['autoDetachMinutes', 'autoCloseMinutes']);
    const anyEnabled = (settings.autoDetachMinutes || 0) > 0 || (settings.autoCloseMinutes || 0) > 0;
    if (anyEnabled) {
      startAutoManageTimer();
    } else {
      stopAutoManageTimer();
    }
  }
});

// Start timer on load if settings are configured
chrome.storage.local.get(['autoDetachMinutes', 'autoCloseMinutes'], (settings) => {
  if ((settings.autoDetachMinutes || 0) > 0 || (settings.autoCloseMinutes || 0) > 0) {
    startAutoManageTimer();
  }
});

/**
 * Syncs the 'browserforce' Chrome tab group to reflect currently attached tabs.
 * Modeled after playwriter's syncTabGroup — always queries by title, never caches group ID.
 */
async function syncTabGroup() {
  try {
    const connectedTabIds = Array.from(attachedTabs.keys());
    const existingGroups = await chrome.tabGroups.query({ title: 'browserforce' });

    if (connectedTabIds.length === 0) {
      for (const group of existingGroups) {
        const tabsInGroup = await chrome.tabs.query({ groupId: group.id });
        const tabIdsToUngroup = tabsInGroup.map((t) => t.id).filter((id) => id !== undefined);
        if (tabIdsToUngroup.length > 0) {
          await chrome.tabs.ungroup(tabIdsToUngroup);
        }
      }
      return;
    }

    // Consolidate duplicate groups into one
    let groupId = existingGroups[0]?.id;
    if (existingGroups.length > 1) {
      const [keep, ...duplicates] = existingGroups;
      groupId = keep.id;
      for (const group of duplicates) {
        const tabsInDupe = await chrome.tabs.query({ groupId: group.id });
        const tabIdsToUngroup = tabsInDupe.map((t) => t.id).filter((id) => id !== undefined);
        if (tabIdsToUngroup.length > 0) {
          await chrome.tabs.ungroup(tabIdsToUngroup);
        }
      }
    }

    const allTabs = await chrome.tabs.query({});
    const tabsInGroup = allTabs.filter((t) => t.groupId === groupId && t.id !== undefined);
    const tabIdsInGroup = new Set(tabsInGroup.map((t) => t.id));

    const tabsToAdd = connectedTabIds.filter((id) => !tabIdsInGroup.has(id));
    const tabsToRemove = Array.from(tabIdsInGroup).filter((id) => !connectedTabIds.includes(id));

    if (tabsToRemove.length > 0) {
      try {
        await chrome.tabs.ungroup(tabsToRemove);
      } catch {
        // Tab may have been closed already
      }
    }

    if (tabsToAdd.length > 0) {
      if (groupId === undefined) {
        const newGroupId = await chrome.tabs.group({ tabIds: tabsToAdd });
        await chrome.tabGroups.update(newGroupId, { title: 'browserforce', color: 'cyan' });
      } else {
        await chrome.tabs.group({ tabIds: tabsToAdd, groupId });
      }
    }
  } catch (e) {
    console.warn('[bf] syncTabGroup error:', e.message);
  }
}

function queueSyncTabGroup() {
  tabGroupQueue = tabGroupQueue.then(syncTabGroup).catch((e) => {
    console.warn('[bf] syncTabGroup error:', e.message);
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function updateBadge() {
  const count = attachedTabs.size;

  if (connectionState === 'connected') {
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  } else if (connectionState === 'connecting') {
    chrome.action.setBadgeText({ text: '...' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeBackgroundColor({ color: '#9E9E9E' });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Popup Message Handler ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    const tabs = [];
    for (const [tabId, entry] of attachedTabs) {
      tabs.push({
        tabId,
        title: entry.targetInfo?.title || '',
        url: entry.targetInfo?.url || '',
        sessionId: entry.sessionId,
      });
    }

    // Compute seconds until next auto-action (detach or close)
    let nextAutoActionSecs = null;
    chrome.storage.local.get(['autoDetachMinutes', 'autoCloseMinutes'], (settings) => {
      const detachMs = (settings.autoDetachMinutes || 0) * 60_000;
      const closeMs = (settings.autoCloseMinutes || 0) * 60_000;
      if ((detachMs || closeMs) && tabLastActivity.size > 0) {
        const now = Date.now();
        let earliest = Infinity;
        for (const [tabId, lastActivity] of tabLastActivity) {
          const limit = (closeMs && agentCreatedTabs.has(tabId)) ? closeMs : detachMs;
          if (!limit) continue;
          const remaining = limit - (now - lastActivity);
          if (remaining < earliest) earliest = remaining;
        }
        if (earliest < Infinity) {
          nextAutoActionSecs = Math.max(0, Math.ceil(earliest / 1000));
        }
      }
      sendResponse({ connectionState, tabs, nextAutoActionSecs });
    });
    return true; // async sendResponse
  }
  return false;
});
