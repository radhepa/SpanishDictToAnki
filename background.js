// Service worker: lights a "SCAN" badge on the toolbar icon while the user is on
// a SpanishDict list page, so they know exactly when the popup has something to
// scan. (Chrome forbids programmatically opening the popup, so a badge is the cue.)

const LIST_URL = /^https:\/\/www\.spanishdict\.com\/lists(\/|$|\?|#)/;
const BADGE_TEXT = "SCAN";
const BADGE_COLOR = "#22c55e";

function isListPage(url) {
  return typeof url === "string" && LIST_URL.test(url);
}

async function updateBadge(tabId, url) {
  if (tabId == null) return;
  try {
    if (isListPage(url)) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
      await chrome.action.setBadgeText({ tabId, text: BADGE_TEXT });
    } else {
      await chrome.action.setBadgeText({ tabId, text: "" });
    }
  } catch (err) {
    // Tab closed between the event firing and this call — safe to ignore.
  }
}

// Fires on full loads AND SPA history navigations: changeInfo.url is populated
// when SpanishDict swaps routes client-side, which is the case we care about.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    updateBadge(tabId, tab.url);
  }
});

// Re-evaluate whenever the user switches to a different tab.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadge(tabId, tab.url);
  } catch (err) {
    // Tab no longer exists.
  }
});

// Restore the active tab's badge when the worker (re)starts or is installed.
async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) updateBadge(tab.id, tab.url);
  } catch (err) {
    // No accessible active tab.
  }
}

chrome.runtime.onInstalled.addListener(refreshActiveTab);
chrome.runtime.onStartup.addListener(refreshActiveTab);
