/*
 * End-to-end checks for the extension, run against a real Chromium with the
 * unpacked extension loaded.
 *
 *   npm i -D playwright   # or use a global install
 *   node tools/e2e-extension.js
 *
 * Covers the rendered viewer, the editor UI, and the read/write file paths.
 * The File System Access pickers cannot be driven from a test, so the file
 * paths are exercised with OPFS handles, which implement the same interface.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const EXT = path.resolve(__dirname, '..', 'extension');
const PORT = 8731;

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label +
    (ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`));
}

function serveExtensionDir() {
  const server = http.createServer((req, res) => {
    const file = path.join(EXT, decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function main() {
  // The extension ships its own copy of the shared renderer.
  for (const file of ['markdown.js', 'markdown.css']) {
    const shared = fs.readFileSync(path.resolve(__dirname, '..', 'shared', file), 'utf8');
    const mine = fs.readFileSync(path.join(EXT, 'src', 'lib', file), 'utf8');
    check(`src/lib/${file} matches shared/ (run tools/sync-shared.sh)`, mine === shared, true);
  }

  const server = await serveExtensionDir();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mds-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });

  let [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;

  const errors = [];
  const watch = (page, tag) => {
    page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
    page.on('console', (m) => {
      // The local test server has no favicon; that 404 is not the extension's.
      const url = (m.location() && m.location().url) || '';
      if (m.type() === 'error' && !url.includes('favicon')) {
        errors.push(`${tag} console: ${m.text()} (${url})`);
      }
    });
  };

  const sample = fs.readFileSync(path.join(EXT, 'sample.md'), 'utf8');

  /* ---------------------------------------------------------- rendering */

  const page = await ctx.newPage();
  watch(page, 'editor');
  await page.goto(`chrome-extension://${id}/src/editor/editor.html`);
  await page.waitForFunction(() => !!window.MarkdownStudio);

  await page.fill('#editor', sample);
  await page.waitForTimeout(300);

  check('preview renders the H1', await page.textContent('#preview h1'), 'Markdown Studio');
  check('table renders its cells', await page.$$eval('#preview td', (n) => n.length), 9);
  check('task list renders checkboxes', await page.$$eval('#preview input[type=checkbox]', (n) => n.length), 2);
  check('outline lists every heading',
    await page.$$eval('.outline-item', (n) => n.map((x) => x.textContent)),
    ['Markdown Studio', 'What it covers', 'Code', 'Table']);
  check('raw HTML in the source is escaped',
    await page.evaluate(() => MD.render('<img src=x onerror=alert(1)>').html.includes('&lt;img')), true);
  check('javascript: links are dropped',
    await page.evaluate(() => MD.render('[x](javascript:alert(1))').html.includes('<a')), false);

  /* ------------------------------------------------------------ editing */

  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.value = 'hello world';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    ed.focus();
    ed.setSelectionRange(6, 11);
  });
  await page.click('[data-cmd="bold"]');
  check('bold wraps the selection', await page.inputValue('#editor'), 'hello **world**');
  await page.click('[data-cmd="bold"]');
  check('bold toggles back off', await page.inputValue('#editor'), 'hello world');

  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.value = '';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    ed.focus();
  });
  await page.type('#editor', '- first');
  await page.keyboard.press('Enter');
  await page.type('#editor', 'second');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  check('Enter continues and then ends a list', await page.inputValue('#editor'), '- first\n- second\n');

  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.value = 'a heading';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    ed.focus();
    ed.setSelectionRange(0, 0);
  });
  await page.click('[data-cmd="heading"]');
  await page.click('[data-cmd="heading"]');
  check('heading cycles levels', await page.inputValue('#editor'), '## a heading');

  await page.keyboard.press('Control+3');
  check('Ctrl+3 switches to preview', await page.getAttribute('body', 'data-view'), 'preview');
  await page.keyboard.press('Control+2');
  check('Ctrl+2 switches to split', await page.getAttribute('body', 'data-view'), 'split');

  /* ----------------------------------------------------- files on disk */

  const fsResult = await page.evaluate(async () => {
    // Start from a clean buffer: an unsaved one would raise the discard prompt,
    // which a headless run always dismisses.
    window.MarkdownStudio.loadDocument('', { name: 'Untitled.md', path: '' });

    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }

    const notes = await root.getDirectoryHandle('notes', { create: true });
    const write = async (dir, name, text) => {
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return handle;
    };

    const readme = await write(root, 'readme.md', '# Readme\n\noriginal body\n');
    await write(notes, 'deep.md', '# Deep\n');
    await write(root, 'ignored.txt.bak', 'not markdown');
    const skipped = await root.getDirectoryHandle('node_modules', { create: true });
    await write(skipped, 'dep.md', '# Should not be listed\n');

    await window.MarkdownStudio.useWorkspace(root);
    const listed = window.MarkdownStudio.state.files.map((f) => f.path).sort();

    await window.MarkdownStudio.openFileHandle(readme, { path: 'readme.md' });
    const opened = document.getElementById('editor').value;
    const cleanOnOpen = !window.MarkdownStudio.isDirty();

    const editor = document.getElementById('editor');
    editor.value = '# Readme\n\nedited body\n';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    const dirtyAfterEdit = window.MarkdownStudio.isDirty();

    await window.MarkdownStudio.saveDocument();
    const onDisk = await (await readme.getFile()).text();
    const cleanAfterSave = !window.MarkdownStudio.isDirty();

    // Someone else changes the file while the buffer is clean.
    const writable = await readme.createWritable();
    await writable.write('# Readme\n\nchanged elsewhere\n');
    await writable.close();
    window.MarkdownStudio.state.lastModified = 1;
    await window.MarkdownStudio.checkExternalChange();
    await new Promise((r) => setTimeout(r, 250));

    return {
      listed,
      opened,
      cleanOnOpen,
      dirtyAfterEdit,
      onDisk,
      cleanAfterSave,
      afterExternalChange: document.getElementById('editor').value
    };
  });

  check('workspace scan finds markdown, skips node_modules and non-md files',
    fsResult.listed, ['notes/deep.md', 'readme.md']);
  check('opening a handle loads its text', fsResult.opened, '# Readme\n\noriginal body\n');
  check('a freshly opened file is clean', fsResult.cleanOnOpen, true);
  check('typing marks the buffer dirty', fsResult.dirtyAfterEdit, true);
  check('save writes back to the same file', fsResult.onDisk, '# Readme\n\nedited body\n');
  check('the buffer is clean after saving', fsResult.cleanAfterSave, true);
  check('an external change reloads a clean buffer',
    fsResult.afterExternalChange, '# Readme\n\nchanged elsewhere\n');

  check('the file tree lists the scanned files',
    await page.$$eval('.tree-item', (n) => n.map((x) => x.dataset.path).sort()),
    ['notes/deep.md', 'readme.md']);
  check('recents remembers what was opened',
    await page.$$eval('.recent-item', (n) => n.length > 0), true);

  await page.keyboard.press('Control+p');
  await page.waitForTimeout(200);
  check('quick open lists workspace files',
    await page.$$eval('.palette-item', (n) => n.length), 2);
  await page.keyboard.press('Escape');

  /* -------------------------------------------------------- page viewer */

  const viewer = await ctx.newPage();
  watch(viewer, 'viewer');
  await viewer.goto(`http://localhost:${PORT}/sample.md`);
  await viewer.waitForSelector('.mds-shell', { timeout: 5000 });
  check('viewer renders the document', await viewer.textContent('.mds-article h1'), 'Markdown Studio');
  check('viewer builds an outline', await viewer.$$eval('.mds-outline-link', (n) => n.length), 4);
  await viewer.click('button.mds-btn:has-text("Source")');
  check('viewer toggles to raw source', await viewer.isVisible('.mds-source'), true);

  const other = await ctx.newPage();
  await other.goto(`http://localhost:${PORT}/manifest.json`);
  await other.waitForTimeout(200);
  check('viewer leaves non-markdown pages alone',
    await other.$$eval('.mds-shell', (n) => n.length), 0);

  /* --------------------------------------------------------------- popup */

  const popup = await ctx.newPage();
  watch(popup, 'popup');
  await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
  await popup.waitForTimeout(300);
  check('popup renders', await popup.textContent('h1'), 'Markdown Studio');

  check('no uncaught page errors', errors, []);

  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('Harness failed:', error);
  process.exit(1);
});
