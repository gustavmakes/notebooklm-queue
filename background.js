// Background service worker - mostly passive, just here to keep extension lifecycle clean.
// All real work happens in content.js running on the NotebookLM tab.

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["queue", "running"], (data) => {
    if (!data.queue) chrome.storage.local.set({ queue: [], running: false, currentIdx: -1 });
    // If a previous run crashed, clear the running flag
    if (data.running) chrome.storage.local.set({ running: false });
  });
});
