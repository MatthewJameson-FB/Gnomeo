const sidePanelApi = globalThis.chrome?.sidePanel || null;
const tabsApi = globalThis.chrome?.tabs || null;
const runtimeApi = globalThis.chrome?.runtime || null;

const openSidePanelForWindow = async (windowId) => {
  if (!sidePanelApi?.open) {
    throw new Error('chrome.sidePanel.open is unavailable');
  }
  if (!Number.isFinite(windowId)) {
    throw new Error('Missing windowId');
  }
  await sidePanelApi.open({ windowId });
};

const resolveActiveWindowId = async () => {
  if (!tabsApi?.query) throw new Error('chrome.tabs.query is unavailable');
  const tabs = await new Promise((resolve, reject) => {
    tabsApi.query({ active: true, currentWindow: true }, (items) => {
      const message = runtimeApi?.lastError?.message || '';
      if (message) {
        reject(new Error(message));
        return;
      }
      resolve(Array.isArray(items) ? items : []);
    });
  });
  const tab = tabs.find((item) => item?.windowId != null);
  if (!tab) throw new Error('No active tab found');
  return tab.windowId;
};

const openPanelFromContext = async (context = {}) => {
  const windowId = Number.isFinite(context.windowId)
    ? context.windowId
    : Number.isFinite(context?.tab?.windowId)
      ? context.tab.windowId
      : await resolveActiveWindowId();
  await openSidePanelForWindow(windowId);
  return { ok: true, windowId };
};

globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;
  if (message.type !== 'GNOMEO_OPEN_SIDE_PANEL') return undefined;

  (async () => {
    try {
      const response = await openPanelFromContext({ tab: sender?.tab, windowId: message.windowId });
      sendResponse({ ok: true, ...response });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error || 'Open side panel failed');
      console.warn('[Gnomeo] Failed to open side panel:', messageText);
      sendResponse({ ok: false, error: messageText });
    }
  })();

  return true;
});

globalThis.chrome?.action?.onClicked?.addListener((tab) => {
  openPanelFromContext({ tab }).catch((error) => {
    const messageText = error instanceof Error ? error.message : String(error || 'Open side panel failed');
    console.warn('[Gnomeo] Action open failed:', messageText);
  });
});

