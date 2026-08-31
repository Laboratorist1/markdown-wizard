/* Popup: entry point into the editor plus the file-access hint. */

const MD_URL = /\.(md|markdown|mdown|mkd|mdx)(\?|#|$)/i;

const openEditor = document.getElementById('open-editor');
const editPage = document.getElementById('edit-page');
const pageNote = document.getElementById('page-note');
const fileAccess = document.getElementById('file-access');

openEditor.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'open-editor' });
  window.close();
});

document.getElementById('open-settings').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
  window.close();
});

document.getElementById('open-shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

async function init() {
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  fileAccess.hidden = allowed;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  if (!MD_URL.test(tab.url)) {
    if (tab.url.startsWith('file://')) {
      pageNote.textContent = 'This tab is not a Markdown file.';
      pageNote.hidden = false;
    }
    return;
  }

  if (tab.url.startsWith('file://') && !allowed) {
    pageNote.textContent = 'This is a Markdown file, but file access is off, so it cannot be read yet.';
    pageNote.hidden = false;
    return;
  }

  editPage.hidden = false;
  editPage.addEventListener('click', async () => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__markdownWizardSource ?? document.body.innerText
    });
    await chrome.runtime.sendMessage({
      type: 'open-editor',
      payload: {
        name: decodeURIComponent(tab.url.split('/').pop().split('?')[0]) || 'untitled.md',
        text: result?.result || '',
        sourceUrl: tab.url
      }
    });
    window.close();
  });
}

init().catch((error) => {
  pageNote.textContent = error.message;
  pageNote.hidden = false;
});
