/* Service worker: owns the editor tab, the context menu, and viewer handoffs. */

const EDITOR_URL = chrome.runtime.getURL('src/editor/editor.html');
const MD_PATTERNS = [
  'file:///*',
  '*://*/*.md',
  '*://*/*.markdown',
  '*://*/*.mdown',
  '*://*/*.mkd',
  '*://*/*.mdx'
];

async function openEditor(handoff) {
  if (handoff) {
    await chrome.storage.session.set({ handoff: { ...handoff, at: Date.now() } });
  }

  const tabs = await chrome.tabs.query({ url: EDITOR_URL + '*' });
  if (tabs.length) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    // An already-open editor picks the handoff up through
    // chrome.storage.session.onChanged, so nothing else to do here.
    return tab;
  }

  return chrome.tabs.create({ url: EDITOR_URL });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'open-editor',
      title: 'Open Markdown Studio editor',
      contexts: ['action', 'page']
    });
    chrome.contextMenus.create({
      id: 'edit-this-file',
      title: 'Edit this Markdown file',
      contexts: ['page'],
      documentUrlPatterns: MD_PATTERNS
    });
    chrome.contextMenus.create({
      id: 'edit-selection',
      title: 'Open selection in Markdown Studio',
      contexts: ['selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open-editor') {
    await openEditor(null);
    return;
  }

  if (info.menuItemId === 'edit-selection') {
    await openEditor({
      name: 'selection.md',
      text: info.selectionText || '',
      sourceUrl: info.pageUrl || ''
    });
    return;
  }

  if (info.menuItemId === 'edit-this-file' && tab && tab.id != null) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.__markdownStudioSource ?? document.body.innerText)
    });
    await openEditor({
      name: decodeURIComponent((tab.url || '').split('/').pop().split('?')[0]) || 'untitled.md',
      text: result?.result || '',
      sourceUrl: tab.url || ''
    });
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-editor') openEditor(null);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'open-editor') {
    openEditor(message.payload || null).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  return false;
});
