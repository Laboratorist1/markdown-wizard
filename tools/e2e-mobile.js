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
  page.evaluate(() => window.MarkdownWizardMobile.Library.list().then((rows) => rows.map((r) => r.id)));

async function importFile(page, name, contents) {
  await page.setInputFiles('#file-input', {
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(contents, 'utf8')
  });
}

async function openDoc(page, name) {
  await page.click(`.doc-item:has-text("${name}") .doc-open`);
  await page.waitForSelector('#screen-editor:not([hidden])');
  await page.waitForFunction(
    (wanted) => document.getElementById('editor-title').textContent.indexOf(wanted) !== -1,
    name);
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
  await page.waitForFunction(() => !!window.MarkdownWizardMobile);

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
  await page.waitForFunction(() => !!window.MarkdownWizardMobile);
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

  const packing = await page.evaluate(() => window.MarkdownWizardMobile.Library.findByTitle('Packing')
    .then((meta) => window.MarkdownWizardMobile.Library.read(meta.id))
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

  await openDoc(page, 'Packing');

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
  await page.waitForFunction(() => !!window.MarkdownWizardMobile);
  check('the app opens with no network', await docCount(page), 3);
  check('documents are readable offline',
    await page.$$eval('.doc-name', (n) => n.length), 3);
  await context.setOffline(false);

  /* ------------------------------------------------- JSON and XML views */

  const unit = await page.evaluate(() => {
    const sample = '{"a":[1,2,{"b":null}],"c":"x"}';
    return {
      detectByName: Structured.detect('data.json', ''),
      detectXmlByName: Structured.detect('feed.xml', ''),
      detectByContent: Structured.detect('nameless', sample),
      detectXmlByContent: Structured.detect('nameless', '<?xml version="1.0"?><a><b/></a>'),
      detectMarkdown: Structured.detect('notes.md', '# hi'),
      formatted: Structured.format('json', sample),
      minified: Structured.minifyJson('{\n  "a": 1\n}'),
      xmlFormatted: Structured.format('xml', '<a><b x="1">t</b><c/></a>'),
      validSummary: Structured.render('json', sample).summary,
      invalidSummary: Structured.render('json', '{"a":}').summary,
      invalidMessage: Structured.render('json', '{\n  "a": ,\n}').error,
      invalidDeep: Structured.render('json',
        '{\n  "one": 1,\n  "two": 2,\n  "three": [1,2,3],\n  "four": ,\n  "five": 5\n}').error,
      trailing: Structured.render('json', '{"a": 1} oops').error,
      unterminated: Structured.render('json', '{"a": "no end}').error,
      badEscape: Structured.render('json', '{"a": "b\\q"}').error,
      legal: Structured.render('json',
        '{"e":-1.5e+3,"u":"\\u00e9 \\" \\\\","n":[null,true,{}],"empty":[]}').error,
      xmlSummary: Structured.render('xml', '<a><b/><c/></a>').summary,
      xmlInvalid: Structured.render('xml', '<a><b></a>').error,
      // A hostile document must not become live markup.
      noScript: Structured.render('json', '{"x":"<img src=x onerror=alert(1)>"}')
        .node.querySelectorAll('img').length
    };
  });

  check('detects JSON by extension', unit.detectByName, 'json');
  check('detects XML by extension', unit.detectXmlByName, 'xml');
  check('detects JSON by content when the name says nothing', unit.detectByContent, 'json');
  check('detects XML by content', unit.detectXmlByContent, 'xml');
  check('leaves Markdown alone', unit.detectMarkdown, 'markdown');
  check('formats JSON', unit.formatted,
    '{\n  "a": [\n    1,\n    2,\n    {\n      "b": null\n    }\n  ],\n  "c": "x"\n}');
  check('minifies JSON', unit.minified, '{"a":1}');
  check('formats XML', unit.xmlFormatted, '<a>\n  <b x="1">t</b>\n  <c/>\n</a>\n');
  check('summarises valid JSON', unit.validSummary, 'valid JSON · 7 values');
  check('summarises invalid JSON', unit.invalidSummary, 'invalid JSON');
  check('reports where the JSON breaks', unit.invalidMessage, 'Invalid JSON at line 2, column 8');
  check('finds the break in a longer document', unit.invalidDeep,
    'Invalid JSON at line 5, column 11');
  check('flags trailing rubbish', unit.trailing, 'Invalid JSON at line 1, column 10');
  check('flags an unterminated string', unit.unterminated, 'Invalid JSON at line 1, column 15');
  check('flags a bad escape', unit.badEscape, 'Invalid JSON at line 1, column 10');
  check('accepts the awkward but legal', unit.legal, null);
  check('summarises XML', unit.xmlSummary, 'well-formed XML · 3 elements');
  check('reports malformed XML', unit.xmlInvalid, 'Invalid XML');
  check('never turns document content into live markup', unit.noScript, 0);

  await importFile(page, 'config.json',
    '{"name":"wizard","tags":["a","b"],"nested":{"deep":{"ok":true}},"count":3}');
  await page.waitForFunction(() => document.querySelectorAll('.doc-item').length === 4);
  check('an imported .json is labelled', await page.textContent('.doc-item:has-text("config") .doc-kind'), 'JSON');

  await openDoc(page, 'config');
  check('the Markdown toolbar gives way to the data one', await page.isHidden('#format-bar'), true);
  check('the data toolbar is shown', await page.isVisible('#data-bar'), true);
  check('validity is reported while editing',
    await page.textContent('#data-status'), 'valid JSON · 9 values');

  await page.click('#btn-view');
  await page.waitForSelector('#data-view:not([hidden])');
  check('the tree renders', await page.$$eval('#data-view details.st-node', (n) => n.length > 0), true);
  check('keys are shown', await page.$$eval('#data-view .st-key', (n) => n.map((x) => x.textContent))
    .then((keys) => keys.includes('"name"')), true);
  check('deep nodes start collapsed',
    await page.$$eval('#data-view details.st-node', (n) => n.some((d) => !d.open)), true);

  await page.click('[data-data-cmd="expand"]');
  check('Expand opens every node',
    await page.$$eval('#data-view details.st-node', (n) => n.every((d) => d.open)), true);
  await page.click('[data-data-cmd="collapse"]');
  check('Collapse closes every node',
    await page.$$eval('#data-view details.st-node', (n) => n.every((d) => !d.open)), true);

  await page.click('#btn-view');
  await page.click('[data-data-cmd="format"]');
  check('Format indents the document',
    (await page.inputValue('#editor')).startsWith('{\n  "name": "wizard"'), true);
  await page.click('[data-data-cmd="minify"]');
  check('Minify strips the whitespace',
    (await page.inputValue('#editor')).startsWith('{"name":"wizard"'), true);

  await page.fill('#editor', '{"broken": }');
  await page.waitForFunction(() =>
    document.getElementById('data-status').textContent.indexOf('Invalid') === 0);
  check('a broken document says so', await page.textContent('#data-status'),
    'Invalid JSON at line 1, column 12');
  check('and is flagged, not silently wrong',
    await page.$eval('#data-status', (n) => n.classList.contains('is-error')), true);

  await page.fill('#editor', '{"fixed": true}');
  await page.waitForFunction(() =>
    document.getElementById('data-status').textContent === 'valid JSON · 2 values');
  await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved');
  await page.click('#btn-back');

  await importFile(page, 'feed.xml',
    '<?xml version="1.0"?><feed><entry id="1"><title>One</title></entry><entry id="2"><title>Two</title></entry></feed>');
  await page.waitForFunction(() => document.querySelectorAll('.doc-item').length === 5);
  await openDoc(page, 'feed');
  check('XML is recognised', await page.textContent('#data-status'), 'well-formed XML · 5 elements');
  check('Minify is hidden for XML', await page.isHidden('[data-data-cmd="minify"]'), true);

  await page.click('#btn-view');
  check('tags are shown', await page.$$eval('#data-view .st-tag', (n) => n[0].textContent), 'feed');
  check('attributes are shown', await page.$$eval('#data-view .st-attr', (n) => n[0].textContent), 'id');
  await page.click('#btn-view');
  await page.click('#btn-back');

  // Markdown documents must be untouched by all of the above.
  await openDoc(page, 'Ferry notes');
  check('Markdown keeps its own toolbar', await page.isVisible('#format-bar'), true);
  check('and no data toolbar', await page.isHidden('#data-bar'), true);
  await page.click('#btn-view');
  check('and still renders as Markdown', await page.$$eval('#preview h1', (n) => n.length), 1);
  await page.click('#btn-view');
  await page.click('#btn-back');

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
  await subPage.waitForFunction(() => !!window.MarkdownWizardMobile);
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
  await subPage.waitForFunction(() => !!window.MarkdownWizardMobile);
  check('a subpath deployment also opens offline', await docCount(subPage), 1);
  await subContext.setOffline(false);
  check('no page errors from the subpath deployment', subErrors, []);

  /* --------------------------------------------- migration after rename */

  // The app used to be called Markdown Studio, which named its metadata
  // database. A library written by that version must survive the rename.
  const legacyContext = await browser.newContext({ ...devices['Pixel 7'] });
  const legacyPage = await legacyContext.newPage();
  const legacyErrors = [];
  legacyPage.on('pageerror', (e) => legacyErrors.push('pageerror: ' + e.message));

  await legacyPage.goto(BASE);
  await legacyPage.waitForFunction(() => !!window.MarkdownWizardMobile);

  await legacyPage.evaluate(async () => {
    // Write what the old version would have left behind: bytes in OPFS, and a
    // metadata row in a database named after the old app.
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('docs', { create: true });
    const handle = await dir.getFileHandle('legacyid.md', { create: true });
    const writable = await handle.createWritable();
    await writable.write('# From the old version\n');
    await writable.close();

    // Drop the current metadata so the library looks empty, as it would after
    // the rename, then plant the legacy database.
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('markdown-wizard');
      request.onsuccess = request.onerror = request.onblocked = resolve;
    });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('markdown-studio', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('docs', { keyPath: 'id' })
          .createIndex('updatedAt', 'updatedAt');
      };
      request.onsuccess = () => {
        const db = request.result;
        const store = db.transaction('docs', 'readwrite').objectStore('docs');
        store.put({
          id: 'legacyid',
          title: 'Old notes',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          size: 24,
          preview: 'From the old version'
        });
        db.transaction('docs', 'readonly').oncomplete = () => {};
        setTimeout(() => { db.close(); resolve(); }, 50);
      };
      request.onerror = () => reject(request.error);
    });
  });

  await legacyPage.reload();
  await legacyPage.waitForSelector('.doc-item');
  check('a library from the old app name is carried over',
    await docTitles(legacyPage), ['Old notes']);

  await openDoc(legacyPage, 'Old notes');
  check('the migrated document still has its text',
    await legacyPage.inputValue('#editor'), '# From the old version\n');
  check('no page errors during migration', legacyErrors, []);
  await legacyContext.close();

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
