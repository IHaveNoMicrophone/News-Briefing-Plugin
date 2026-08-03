'use strict';

function openDigestPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('digest.html') });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'openDigest') {
    openDigestPage();
    sendResponse({ ok: true });
  }
  return false;
});

chrome.action.onClicked.addListener(() => {
  openDigestPage();
});
