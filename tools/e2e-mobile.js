/*
 * End-to-end checks for the mobile app, run in Chromium with phone emulation.
 *
 *   npm i -D playwright   # or use a global install
 *   node tools/e2e-mobile.js
 *
 * The point of most of these checks is the promise the app makes: editing,
 * renaming, reopening and re-importing all act on the SAME document. The
 * document count is asserted after every one of those operations.
 */

const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8742;
const BASE = `http://localhost:${PORT}/index.html`;

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown'
};

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label +
    (ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`));
}

/** `prefix` mimics GitHub Pages, which always serves a project site under
    /<repo>/ rather than at the origin root. */
function serve(port, prefix) {
  const base = prefix || '';
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (base && urlPath.startsWith(base)) urlPath = urlPath.slice(base.length);
    const rel = urlPath.replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Service-Worker-Allowed': '/'
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

const docCount = (page) => page.$$eval('.doc-item', (items) => items.length);
const docTitles = (page) => page.$$eval('.doc-name', (names) => names.map((n) => n.textContent).sort());
const docIds = (page) =>
  page.evaluate(() => window.MarkdownStudioMobile.Library.list().then((rows) => rows.map((r) => r.id)));

async function importFile(page, name, contents) {
  await page.setInputFiles('#file-input', {
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(contents, 'utf8')
  });
}

async function main() {
  // Both apps ship a copy of the shared renderer; drift means they would
  // silently render the same document differently.
  for (const file of ['markdown.js', 'markdown.css']) {
    const shared = fs.readFileSync(path.join(ROOT, 'shared', file), 'utf8');
    const mine = fs.readFileSync(path.join(ROOT, 'lib', file), 'utf8');
    check(`lib/${file} matches shared/ (run tools/sync-shared.sh)`, mine === shared, true);
  }

  const server = await serve(PORT, '');
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    const url = (m.location() && m.location().url) || '';
    if (m.type() === 'error' && !url.includes('favicon')) errors.push('console: ' + m.text());
  });

  await page.goto(BASE);
  await page.waitForFunction(() => !!window.MarkdownStudioMobile);

  /* ------------------------------------------------------- create + save */

  check('starts with an empty library', await docCount(page), 0);
  check('shows the empty state', await page.isVisible('#library-empty'), true);

  await page.click('#btn-new');
  await page.fill('#prompt-input', 'Trip notes');
  await page.click('.prompt-button.primary');
  await page.waitForSelector('#screen-editor:not([hidden])');
  check('new document opens in the editor', await page.textContent('#editor-title'), 'Trip notes');

  await page.click('#editor');
  await page.keyboard.type('Ferry leaves at six.');
  await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved');
  const firstIds = await docIds(page);
  check('exactly one document exists after the first save', firstIds.length, 1);

  await page.click('#btn-back');
  await page.waitForSelector('#screen-library:not([hidden])');
  check('library lists the one document', await docCount(page), 1);

  /* -------------------------------------------------------- reopen + edit */

  await page.reload();
  await page.waitForFunction(() => !!window.MarkdownStudioMobile);
  check('the document survives a reload', await docCount(page), 1);

  await page.click('.doc-open');
  await page.waitForSelector('#screen-editor:not([hidden])');
  var SEED = '# Trip notes\n\n';
  check('reopening shows the saved text',
    await page.inputValue('#editor'), SEED + 'Ferry leaves at six.');

  await page.click('#editor');
  await page.keyboard.press('End');
  await page.keyboard.type(' Bring a coat.');
  await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved');
  await page.click('#btn-back');

  check('editing did NOT create a second document', await docIds(page), firstIds);
  await page.click('.doc-open');
  check('the edit landed in the same document',
    await page.inputValue('#editor'), SEED + 'Ferry leaves at six. Bring a coat.');

  /* -------------------------------------------------------------- rename */

  await page.click('#btn-more');
  await page.click('.sheet-item:has-text("Rename")');
  await page.fill('#prompt-input', 'Ferry notes');
  await page.click('.prompt-button.primary');
  await page.waitForSelector('#prompt', { state: 'hidden' });
  check('rename keeps the same document id', await docIds(page), firstIds);
  check('rename keeps the text',
    await page.inputValue('#editor'), SEED + 'Ferry leaves at six. Bring a coat.');
  await page.click('#btn-back');
  check('rename shows the new title', await docTitles(page), ['Ferry notes']);

  /* -------------------------------------------------------------- import */

  await importFile(page, 'Packing.md', '# Packing\n\n- socks\n');
  await page.waitForFunction(() => document.querySelectorAll('.doc-item').length === 2);
  check('importing a new file adds one document', await docCount(page), 2);

  // Same name, same bytes: nothing to do.
  await importFile(page, 'Packing.md', '# Packing\n\n- socks\n');
  await page.waitForSelector('#toast:not([hidden])');
  check('re-importing an identical file is a no-op',
    await page.textContent('#toast'), 'Packing is already in your library');
  check('...and does not add a document', await docCount(page), 2);

  // Same name, different bytes: the app must ask rather than fork a copy.
  await importFile(page, 'Packing.md', '# Packing\n\n- socks\n- boots\n');
  await page.waitForSelector('#prompt:not([hidden])');
  check('a changed file with a known name raises a choice',
    await page.textContent('#prompt-title'), '"Packing" already exists');

  await page.click('.prompt-button.primary'); // Update it
  await page.waitForSelector('#prompt', { state: 'hidden' });
  // Wait for the app to confirm the write rather than racing its promise chain.
  await page.waitForFunction(() => document.getElementById('toast').textContent === 'Updated Packing');
  check('choosing "Update it" keeps the document count at two', await docCount(page), 2);

  const packing = await page.evaluate(() => window.MarkdownStudioMobile.Library.findByTitle('Packing')
    .then((meta) => window.MarkdownStudioMobile.Library.read(meta.id))
    .then((doc) => doc.text));
  check('choosing "Update it" replaced the contents in place',
    packing, '# Packing\n\n- socks\n- boots\n');

  await importFile(page, 'Packing.md', '# Packing\n\nthird version\n');
  await page.waitForSelector('#prompt:not([hidden])');
  await page.click('.prompt-button:has-text("Keep both")');
  await page.waitForFunction(() => document.querySelectorAll('.doc-item').length === 3);
  check('choosing "Keep both" is the only path to a second copy',
    await docTitles(page), ['Ferry notes', 'Packing', 'Packing (imported)']);

  /* ------------------------------------------------- duplicate + delete */

  await page.click('.doc-item:has-text("Ferry notes") .doc-more');
  await page.click('.sheet-item:has-text("Duplicate")');
  await page.waitForFunction(() => document.querySelectorAll('.doc-item').length === 4);
  check('Duplicate is explicit and does add a copy',
    (await docTitles(page)).includes('Ferry notes copy'), true);

  await page.click('.doc-item:has-text("Ferry notes copy") .doc-more');
  await page.click('.sheet-item.danger');
  await page.click('.prompt-button.danger');
  await page.waitForFunction(() => document.querySelectorAll('.doc-item').length === 3);
  check('delete removes exactly one document', await docCount(page), 3);

  /* --------------------------------------------------------- search + UI */

  await page.fill('#search', 'ferry');
  check('search filters the list', await docCount(page), 1);
  await page.fill('#search', '');

  await page.click('.doc-item:has-text("Packing") .doc-open');
  await page.waitForSelector('#screen-editor:not([hidden])');

  await page.click('#btn-view');
  check('preview renders the document', await page.textContent('#preview h1'), 'Packing');
  await page.click('#btn-view');

  await page.click('#editor');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  check('Enter continues the list', await page.inputValue('#editor'), '- one\n- two');

  await page.evaluate(() => {
    const editor = document.getElementById('editor');
    editor.focus();
    editor.setSelectionRange(2, 5);
  });
  await page.click('[data-cmd="bold"]');
  check('the format bar wraps the selection', await page.inputValue('#editor'), '- **one**\n- two');

  await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved');
  await page.click('#btn-back');
  check('all that editing still left three documents', await docCount(page), 3);

  /* ------------------------------------------------------------- offline */

  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 10000 });
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!window.MarkdownStudioMobile);
  check('the app opens with no network', await docCount(page), 3);
  check('documents are readable offline',
    await page.$$eval('.doc-name', (n) => n.length), 3);
  await context.setOffline(false);

  /* ------------------------------------------- served from a subpath */

  // GitHub Pages (and most free static hosts) serve a project under /<repo>/.
  // Every URL in the app is relative so that this works; assert it, because an
  // absolute path would only break once deployed.
  const subServer = await serve(PORT + 1, '/markdown-wizard');
  const subContext = await browser.newContext({ ...devices['Pixel 7'] });
  const subPage = await subContext.newPage();
  const subErrors = [];
  subPage.on('pageerror', (e) => subErrors.push('pageerror: ' + e.message));

  await subPage.goto(`http://localhost:${PORT + 1}/markdown-wizard/index.html`);
  await subPage.waitForFunction(() => !!window.MarkdownStudioMobile);
  await subPage.click('#btn-new');
  await subPage.fill('#prompt-input', 'Hosted');
  await subPage.click('.prompt-button.primary');
  await subPage.waitForSelector('#screen-editor:not([hidden])');
  await subPage.click('#editor');
  await subPage.keyboard.type('works under a subpath');
  await subPage.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved');
  await subPage.click('#btn-back');
  await subPage.waitForSelector('.doc-item');
  check('the app works when hosted under /<repo>/', await docCount(subPage), 1);

  const scope = await subPage.evaluate(() => navigator.serviceWorker.getRegistration()
    .then((registration) => (registration ? new URL(registration.scope).pathname : null)));
  check('the service worker registers with a subpath scope', scope, '/markdown-wizard/');

  await subContext.setOffline(true);
  await subPage.reload();
  await subPage.waitForFunction(() => !!window.MarkdownStudioMobile);
  check('a subpath deployment also opens offline', await docCount(subPage), 1);
  await subContext.setOffline(false);
  check('no page errors from the subpath deployment', subErrors, []);

  check('no uncaught page errors', errors, []);

  await subContext.close();
  await context.close();
  await browser.close();
  server.close();
  subServer.close();

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('Harness failed:', error);
  process.exit(1);
});
