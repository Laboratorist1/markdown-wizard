/*
 * Markdown Wizard editor.
 *
 * Reads and writes real files on disk through the File System Access API:
 * a picked file or folder yields a handle, the handle is kept in IndexedDB so
 * it survives a restart, and Save writes straight back to the original file.
 */
(function () {
  'use strict';

  var MD_EXT = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;
  var OPEN_EXT = /\.(md|markdown|mdown|mkd|mdx|txt|json|jsonc|geojson|webmanifest|xml|svg|xsd|xsl|xslt|rss|atom|plist)$/i;
  var SKIP_DIRS = /^(node_modules|dist|build|out|target|vendor|__pycache__|\.git|\.next|\.venv)$/;
  var MAX_SCAN_DEPTH = 6;
  var MAX_SCAN_FILES = 2000;
  // A value the buffer can never equal, used to mark a document as unsaved.
  var NEVER_SAVED = String.fromCharCode(0) + 'never-saved';

  var el = function (id) { return document.getElementById(id); };

  var dom = {
    body: document.body,
    docName: el('doc-name'),
    docPath: el('doc-path'),
    dirty: el('doc-dirty'),
    save: el('btn-save'),
    menuBtn: el('btn-menu'),
    menu: el('menu'),
    autosaveState: el('autosave-state'),
    themeState: el('theme-state'),
    banner: el('banner'),
    bannerText: el('banner-text'),
    bannerPrimary: el('banner-primary'),
    bannerDismiss: el('banner-dismiss'),
    openFolder: el('btn-open-folder'),
    openFile: el('btn-open-file'),
    refresh: el('btn-refresh'),
    workspaceName: el('workspace-name'),
    tree: el('file-tree'),
    recent: el('recent-list'),
    outline: el('outline'),
    toolbar: el('format-toolbar'),
    editor: el('editor'),
    preview: el('preview'),
    divider: el('divider'),
    statusState: el('status-state'),
    statusCursor: el('status-cursor'),
    statusCounts: el('status-counts'),
    palette: el('palette'),
    paletteInput: el('palette-input'),
    paletteResults: el('palette-results'),
    toast: el('toast')
  };

  var state = {
    handle: null,
    name: 'Untitled.md',
    path: '',
    savedText: '',
    lastModified: 0,
    workspace: null,
    kind: 'markdown',
    files: [],
    prefs: null,
    suppressScrollSync: false,
    paletteIndex: 0,
    paletteMatches: []
  };

  /* ------------------------------------------------------------ utilities */

  var toastTimer = null;
  function toast(message, isError) {
    dom.toast.textContent = message;
    dom.toast.classList.toggle('is-error', !!isError);
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.hidden = true; }, isError ? 4200 : 2000);
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  function isDirty() {
    return dom.editor.value !== state.savedText;
  }

  function setStatus(text, kind) {
    dom.statusState.textContent = text;
    dom.statusState.className = 'status-state' + (kind ? ' is-' + kind : '');
  }

  function refreshDirtyIndicator() {
    var dirty = isDirty();
    dom.dirty.hidden = !dirty;
    dom.save.disabled = !dirty && !!state.handle;
    if (dirty) setStatus('Unsaved changes', 'dirty');
    else if (state.handle) setStatus('Saved', null);
    else setStatus('Not saved to disk yet', null);
    document.title = (dirty ? '* ' : '') + state.name + ' - Markdown Wizard';
  }

  function showBanner(text, actionLabel, onAction) {
    dom.bannerText.textContent = text;
    dom.bannerPrimary.textContent = actionLabel;
    dom.bannerPrimary.hidden = !actionLabel;
    dom.banner.hidden = false;
    dom.bannerPrimary.onclick = function () {
      hideBanner();
      if (onAction) onAction();
    };
  }

  function hideBanner() { dom.banner.hidden = true; }

  function dirName(path) {
    var index = path.lastIndexOf('/');
    return index === -1 ? '' : path.slice(0, index);
  }

  /* -------------------------------------------------------------- preview */

  var renderPreview = debounce(function () {
    if (state.kind === 'markdown') {
      var result = MD.render(dom.editor.value);
      dom.preview.className = 'md-body';
      dom.preview.innerHTML = result.html;
      renderOutline(result.headings);
    } else {
      var data = Structured.render(state.kind, dom.editor.value);
      dom.preview.className = 'st-host';
      dom.preview.replaceChildren(data.node);
      renderDataPanel(data);
    }
    updateCounts();
  }, 110);

  /** For JSON and XML the outline panel becomes a verdict plus the two controls
      that actually help with a big document. */
  function renderDataPanel(data) {
    dom.outline.textContent = '';
    var verdict = document.createElement('p');
    verdict.className = data.error ? 'empty is-error' : 'empty';
    verdict.textContent = data.error || data.summary;
    dom.outline.appendChild(verdict);

    [['Expand all', true], ['Collapse all', false]].forEach(function (pair) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'outline-item';
      button.textContent = pair[0];
      button.addEventListener('click', function () {
        Structured.expandAll(dom.preview, pair[1]);
      });
      dom.outline.appendChild(button);
    });
  }

  function renderOutline(headings) {
    dom.outline.textContent = '';
    if (!headings.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Headings appear here.';
      dom.outline.appendChild(empty);
      return;
    }
    headings.forEach(function (heading) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'outline-item';
      item.dataset.level = String(heading.level);
      item.textContent = heading.text;
      item.title = heading.text;
      item.addEventListener('click', function () {
        var target = dom.preview.querySelector('#' + CSS.escape(heading.id));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        jumpToHeadingInEditor(heading);
      });
      dom.outline.appendChild(item);
    });
  }

  function jumpToHeadingInEditor(heading) {
    var lines = dom.editor.value.split('\n');
    var needle = heading.text.trim().toLowerCase();
    var offset = 0;
    for (var i = 0; i < lines.length; i++) {
      var match = lines[i].match(/^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*$/);
      if (match && match[1].replace(/[*_`~]/g, '').trim().toLowerCase() === needle) {
        dom.editor.focus();
        dom.editor.setSelectionRange(offset, offset + lines[i].length);
        var ratio = offset / Math.max(1, dom.editor.value.length);
        dom.editor.scrollTop = ratio * dom.editor.scrollHeight - dom.editor.clientHeight / 3;
        updateCursor();
        return;
      }
      offset += lines[i].length + 1;
    }
  }

  function updateCounts() {
    var text = dom.editor.value;
    if (state.kind !== 'markdown') {
      var data = Structured.render(state.kind, text);
      var lines = text.split('\n').length;
      dom.statusCounts.textContent = lines.toLocaleString() +
        (lines === 1 ? ' line - ' : ' lines - ') + (data.error || data.summary);
      dom.statusCounts.classList.toggle('is-error', !!data.error);
      return;
    }
    var words = text.trim() ? text.trim().split(/\s+/).length : 0;
    dom.statusCounts.classList.remove('is-error');
    dom.statusCounts.textContent = words.toLocaleString() + ' words - ' +
      text.length.toLocaleString() + ' chars - ' +
      Math.max(1, Math.round(words / 220)) + ' min read';
  }

  function updateCursor() {
    var upto = dom.editor.value.slice(0, dom.editor.selectionStart).split('\n');
    dom.statusCursor.textContent = 'Ln ' + upto.length + ', Col ' + (upto[upto.length - 1].length + 1);
  }

  /* ------------------------------------------------------- file operations */

  function ensurePermission(handle, mode) {
    var options = { mode: mode || 'readwrite' };
    return handle.queryPermission(options).then(function (permission) {
      if (permission === 'granted') return true;
      return handle.requestPermission(options).then(function (result) {
        return result === 'granted';
      });
    });
  }

  function confirmDiscard() {
    if (!isDirty()) return true;
    return window.confirm('"' + state.name + '" has unsaved changes. Discard them?');
  }

  function loadDocument(text, meta) {
    state.handle = meta.handle || null;
    state.name = meta.name || 'Untitled.md';
    state.path = meta.path || '';
    state.savedText = meta.unsaved ? NEVER_SAVED : text;
    state.lastModified = meta.lastModified || 0;
    state.kind = Structured.detect(state.name, text);
    dom.body.dataset.kind = state.kind;

    dom.editor.value = text;
    dom.editor.scrollTop = 0;
    dom.docName.textContent = state.name;
    dom.docPath.textContent = state.path && state.path !== state.name ? state.path : '';
    dom.docPath.title = state.path;

    hideBanner();
    renderPreview();
    refreshDirtyIndicator();
    updateCursor();
    highlightActiveFile();
  }

  function openFileHandle(handle, meta) {
    if (!confirmDiscard()) return Promise.resolve(false);
    return ensurePermission(handle, 'read').then(function (granted) {
      if (!granted) {
        toast('Permission to read that file was declined.', true);
        return false;
      }
      return handle.getFile().then(function (file) {
        return file.text().then(function (text) {
          var path = (meta && meta.path) || handle.name;
          loadDocument(text, {
            handle: handle,
            name: handle.name,
            path: path,
            lastModified: file.lastModified
          });
          Store.remember({ kind: 'file', name: handle.name, path: path, handle: handle })
            .then(function (record) {
              Store.setPrefs({ lastFileKey: record.key });
              renderRecents();
            });
          return true;
        });
      });
    }).catch(function (error) {
      toast('Could not open the file: ' + error.message, true);
      return false;
    });
  }

  function pickFile() {
    if (!window.showOpenFilePicker) {
      toast('This Chrome build has no File System Access API.', true);
      return;
    }
    window.showOpenFilePicker({
      multiple: false,
      types: [{
        description: 'Markdown',
        accept: {
          'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mdx'],
          'application/json': ['.json', '.geojson', '.webmanifest'],
          'application/xml': ['.xml', '.svg', '.rss', '.atom', '.plist'],
          'text/plain': ['.txt']
        }
      }]
    }).then(function (handles) {
      return openFileHandle(handles[0], null);
    }).catch(ignoreAbort);
  }

  function pickFolder() {
    if (!window.showDirectoryPicker) {
      toast('This Chrome build has no File System Access API.', true);
      return;
    }
    window.showDirectoryPicker({ mode: 'readwrite' })
      .then(function (handle) { return useWorkspace(handle); })
      .catch(ignoreAbort);
  }

  function ignoreAbort(error) {
    if (error && error.name === 'AbortError') return;
    toast(error && error.message ? error.message : String(error), true);
  }

  function useWorkspace(handle, silent) {
    return ensurePermission(handle, 'readwrite').then(function (granted) {
      if (!granted) {
        if (!silent) toast('Permission to that folder was declined.', true);
        return;
      }
      state.workspace = handle;
      dom.workspaceName.textContent = handle.name || 'Workspace';
      dom.refresh.hidden = false;
      return scanWorkspace().then(function () {
        return Store.remember({ kind: 'directory', name: handle.name, path: handle.name, handle: handle })
          .then(function (record) {
            renderRecents();
            return Store.setPrefs({ lastWorkspaceKey: record.key });
          });
      });
    });
  }

  function scanWorkspace() {
    if (!state.workspace) return Promise.resolve();
    dom.tree.textContent = '';
    var loading = document.createElement('p');
    loading.className = 'empty';
    loading.textContent = 'Scanning...';
    dom.tree.appendChild(loading);

    var files = [];
    return walk(state.workspace, '', 0, files).then(function () {
      files.sort(function (a, b) { return a.path.localeCompare(b.path); });
      state.files = files;
      renderTree();
    });
  }

  async function walk(dirHandle, prefix, depth, out) {
    if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return;
    var subdirs = [];
    for await (var entry of dirHandle.values()) {
      if (out.length >= MAX_SCAN_FILES) break;
      if (entry.kind === 'directory') {
        if (SKIP_DIRS.test(entry.name) || entry.name.startsWith('.')) continue;
        subdirs.push({ handle: entry, path: prefix + entry.name + '/' });
      } else if (OPEN_EXT.test(entry.name)) {
        out.push({ name: entry.name, path: prefix + entry.name, handle: entry });
      }
    }
    for (var i = 0; i < subdirs.length; i++) {
      await walk(subdirs[i].handle, subdirs[i].path, depth + 1, out);
    }
  }

  function renderTree() {
    dom.tree.textContent = '';
    if (!state.files.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = state.workspace
        ? 'No Markdown files found in this folder.'
        : 'Open a folder to browse its Markdown files, or open a single file to start editing.';
      dom.tree.appendChild(empty);
      return;
    }

    var currentDir = null;
    state.files.forEach(function (file) {
      var dir = dirName(file.path);
      if (dir !== currentDir) {
        currentDir = dir;
        if (dir) {
          var group = document.createElement('div');
          group.className = 'tree-group';
          group.textContent = dir;
          group.title = dir;
          dom.tree.appendChild(group);
        }
      }
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'tree-item';
      item.dataset.path = file.path;
      item.title = file.path;
      var icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = 'MD';
      item.appendChild(icon);
      item.appendChild(document.createTextNode(file.name));
      item.addEventListener('click', function () { openFileHandle(file.handle, { path: file.path }); });
      dom.tree.appendChild(item);
    });
    highlightActiveFile();
  }

  function highlightActiveFile() {
    Array.prototype.forEach.call(dom.tree.querySelectorAll('.tree-item'), function (item) {
      item.classList.toggle('is-active', item.dataset.path === state.path);
    });
  }

  function renderRecents() {
    return Store.all().then(function (records) {
      dom.recent.textContent = '';
      if (!records.length) {
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Files and folders you open show up here.';
        dom.recent.appendChild(empty);
        return;
      }
      records.slice(0, 10).forEach(function (record) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'recent-item';
        item.title = record.path + ' - click to reopen';
        var icon = document.createElement('span');
        icon.className = 'recent-icon';
        icon.textContent = record.kind === 'directory' ? 'DIR' : 'MD';
        item.appendChild(icon);
        item.appendChild(document.createTextNode(record.name));
        item.addEventListener('click', function () {
          if (record.kind === 'directory') useWorkspace(record.handle);
          else openFileHandle(record.handle, { path: record.path });
        });
        dom.recent.appendChild(item);
      });
    });
  }

  function writeFile(handle, text) {
    return handle.createWritable().then(function (writable) {
      return writable.write(text).then(function () { return writable.close(); });
    });
  }

  function saveDocument() {
    if (!state.handle) return saveDocumentAs();
    var text = dom.editor.value;
    setStatus('Saving...', null);
    return ensurePermission(state.handle, 'readwrite').then(function (granted) {
      if (!granted) {
        toast('Permission to write that file was declined.', true);
        setStatus('Save blocked', 'error');
        return false;
      }
      return writeFile(state.handle, text).then(function () {
        return state.handle.getFile().then(function (file) {
          state.lastModified = file.lastModified;
          state.savedText = text;
          refreshDirtyIndicator();
          toast('Saved ' + state.name);
          return true;
        });
      });
    }).catch(function (error) {
      setStatus('Save failed', 'error');
      toast('Save failed: ' + error.message, true);
      return false;
    });
  }

  function saveDocumentAs() {
    if (!window.showSaveFilePicker) {
      toast('This Chrome build cannot save files directly.', true);
      return Promise.resolve(false);
    }
    var text = dom.editor.value;
    return window.showSaveFilePicker({
      suggestedName: state.name || 'untitled.md',
      types: [{
        description: Structured.label(state.kind),
        accept: (function () {
          var accept = {};
          accept[Structured.mimeFor(state.kind)] = [Structured.extensionFor(state.kind)];
          return accept;
        })()
      }]
    }).then(function (handle) {
      return writeFile(handle, text).then(function () {
        return handle.getFile().then(function (file) {
          state.handle = handle;
          state.name = handle.name;
          state.path = handle.name;
          state.savedText = text;
          state.lastModified = file.lastModified;
          dom.docName.textContent = state.name;
          dom.docPath.textContent = '';
          hideBanner();
          refreshDirtyIndicator();
          Store.remember({ kind: 'file', name: handle.name, path: handle.name, handle: handle })
            .then(renderRecents);
          toast('Saved ' + state.name);
          return true;
        });
      });
    }).catch(function (error) {
      if (error && error.name === 'AbortError') return false;
      toast('Save failed: ' + error.message, true);
      return false;
    });
  }

  function newFile() {
    if (!confirmDiscard()) return;
    if (!state.workspace) {
      loadDocument('', { name: 'Untitled.md', path: '' });
      dom.editor.focus();
      return;
    }
    var name = window.prompt('New file name', 'untitled.md');
    if (!name) return;
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
    state.workspace.getFileHandle(name, { create: true })
      .then(function (handle) {
        return writeFile(handle, '').then(function () {
          return scanWorkspace().then(function () {
            return openFileHandle(handle, { path: name });
          });
        });
      })
      .then(function () { dom.editor.focus(); })
      .catch(function (error) { toast('Could not create the file: ' + error.message, true); });
  }

  /* ------------------------------------------------- external change watch */

  function checkExternalChange() {
    if (!state.handle) return;
    state.handle.getFile().then(function (file) {
      if (!state.lastModified || file.lastModified <= state.lastModified) return;
      if (isDirty()) {
        showBanner(state.name + ' changed on disk, and this copy has unsaved edits.',
          'Reload from disk', function () { reloadFromDisk(); });
        return;
      }
      reloadFromDisk(true);
    }).catch(function () { /* the file may have been moved or deleted */ });
  }

  function reloadFromDisk(silent) {
    if (!state.handle) return;
    var handle = state.handle;
    handle.getFile().then(function (file) {
      return file.text().then(function (text) {
        var scroll = dom.editor.scrollTop;
        loadDocument(text, {
          handle: handle,
          name: state.name,
          path: state.path,
          lastModified: file.lastModified
        });
        dom.editor.scrollTop = scroll;
        toast(silent ? 'Reloaded ' + state.name + ' (changed on disk)' : 'Reloaded from disk');
      });
    }).catch(function (error) { toast('Reload failed: ' + error.message, true); });
  }

  /* -------------------------------------------------------- text commands */

  function selection() {
    return { start: dom.editor.selectionStart, end: dom.editor.selectionEnd, value: dom.editor.value };
  }

  /** Applies an edit through execCommand so the browser's native undo stack
      keeps working (Ctrl+Z stays useful across formatting commands). */
  function applyEdit(start, end, text, selStart, selEnd) {
    dom.editor.focus();
    dom.editor.setSelectionRange(start, end);
    document.execCommand('insertText', false, text);
    if (selStart != null) dom.editor.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
    onInput();
  }

  function wrap(marker, placeholder) {
    var sel = selection();
    var chosen = sel.value.slice(sel.start, sel.end);
    var before = sel.value.slice(Math.max(0, sel.start - marker.length), sel.start);
    var after = sel.value.slice(sel.end, sel.end + marker.length);

    if (before === marker && after === marker) {
      applyEdit(sel.start - marker.length, sel.end + marker.length, chosen,
        sel.start - marker.length, sel.end - marker.length);
      return;
    }
    if (chosen.startsWith(marker) && chosen.endsWith(marker) && chosen.length >= marker.length * 2) {
      var stripped = chosen.slice(marker.length, chosen.length - marker.length);
      applyEdit(sel.start, sel.end, stripped, sel.start, sel.start + stripped.length);
      return;
    }
    var body = chosen || placeholder || '';
    applyEdit(sel.start, sel.end, marker + body + marker,
      sel.start + marker.length, sel.start + marker.length + body.length);
  }

  function lineBounds() {
    var sel = selection();
    var start = sel.value.lastIndexOf('\n', Math.max(0, sel.start - 1)) + 1;
    var endIndex = sel.value.indexOf('\n', sel.end);
    var end = endIndex === -1 ? sel.value.length : endIndex;
    return { start: start, end: end, text: sel.value.slice(start, end) };
  }

  function mapLines(transform) {
    var bounds = lineBounds();
    var lines = bounds.text.split('\n');
    var next = lines.map(transform).join('\n');
    applyEdit(bounds.start, bounds.end, next, bounds.start, bounds.start + next.length);
  }

  function togglePrefix(prefix) {
    var bounds = lineBounds();
    var lines = bounds.text.split('\n');
    var pattern = new RegExp('^\\s*' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    var allPrefixed = lines.every(function (line) { return !line.trim() || pattern.test(line); });
    mapLines(function (line) {
      if (!line.trim()) return line;
      return allPrefixed ? line.replace(pattern, '') : prefix + line;
    });
  }

  var COMMANDS = {
    bold: function () { wrap('**', 'bold text'); },
    italic: function () { wrap('*', 'italic text'); },
    strike: function () { wrap('~~', 'struck text'); },
    code: function () { wrap('`', 'code'); },
    heading: function () {
      mapLines(function (line) {
        var match = line.match(/^(#{1,6})\s+/);
        if (!match) return '# ' + line;
        if (match[1].length >= 6) return line.replace(/^#{1,6}\s+/, '');
        return '#' + line;
      });
    },
    link: function () {
      var sel = selection();
      var chosen = sel.value.slice(sel.start, sel.end);
      if (/^https?:\/\/\S+$/i.test(chosen)) {
        var linked = '[](' + chosen + ')';
        applyEdit(sel.start, sel.end, linked, sel.start + 1, sel.start + 1);
        return;
      }
      var label = chosen || 'link text';
      var replacement = '[' + label + '](url)';
      applyEdit(sel.start, sel.end, replacement,
        sel.start + label.length + 3, sel.start + label.length + 6);
    },
    ul: function () { togglePrefix('- '); },
    ol: function () {
      var bounds = lineBounds();
      var numbered = /^\s*\d+\.\s/.test(bounds.text.split('\n')[0]);
      var counter = 0;
      mapLines(function (line) {
        if (!line.trim()) return line;
        if (numbered) return line.replace(/^\s*\d+\.\s+/, '');
        counter += 1;
        return counter + '. ' + line;
      });
    },
    task: function () { togglePrefix('- [ ] '); },
    quote: function () { togglePrefix('> '); },
    codeblock: function () {
      var sel = selection();
      var chosen = sel.value.slice(sel.start, sel.end) || 'code here';
      var block = '```\n' + chosen + '\n```\n';
      applyEdit(sel.start, sel.end, block, sel.start + 3, sel.start + 3);
    },
    table: function () {
      var sel = selection();
      var table = '\n| Column | Column |\n| --- | --- |\n| value | value |\n\n';
      applyEdit(sel.start, sel.end, table, sel.start + table.length);
    },
    hr: function () {
      var sel = selection();
      var rule = '\n---\n\n';
      applyEdit(sel.start, sel.end, rule, sel.start + rule.length);
    }
  };

  /* ----------------------------------------------- markdown-aware key help */

  var LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/;

  function handleEnter(event) {
    var sel = selection();
    if (sel.start !== sel.end) return false;
    var lineStart = sel.value.lastIndexOf('\n', Math.max(0, sel.start - 1)) + 1;
    var line = sel.value.slice(lineStart, sel.start);
    var match = line.match(LIST_ITEM);
    if (!match) return false;

    var content = match[7];
    var task = match[6];
    if (!content.trim()) {
      // Enter on an empty list item ends the list instead of adding another.
      applyEdit(lineStart, sel.start, '', lineStart, lineStart);
      event.preventDefault();
      return true;
    }

    var marker = match[2]
      ? match[2] + match[5]
      : (Number(match[3]) + 1) + match[4] + match[5];
    var prefix = match[1] + marker + (task ? '[ ] ' : '');
    applyEdit(sel.start, sel.start, '\n' + prefix);
    event.preventDefault();
    return true;
  }

  function handleTab(event) {
    var sel = selection();
    var multiline = sel.value.slice(sel.start, sel.end).indexOf('\n') !== -1;

    if (!multiline && !event.shiftKey) {
      applyEdit(sel.start, sel.end, '  ');
      event.preventDefault();
      return;
    }

    mapLines(function (line) {
      if (event.shiftKey) return line.replace(/^ {1,2}|^\t/, '');
      return line.trim() ? '  ' + line : line;
    });
    event.preventDefault();
  }

  /* ----------------------------------------------------------- quick open */

  function openPalette() {
    if (!state.files.length) {
      toast('Open a folder first to jump between files.');
      return;
    }
    dom.palette.hidden = false;
    dom.paletteInput.value = '';
    renderPaletteResults('');
    dom.paletteInput.focus();
  }

  function closePalette() {
    dom.palette.hidden = true;
    dom.editor.focus();
  }

  function fuzzyScore(query, target) {
    if (!query) return 1;
    var q = query.toLowerCase();
    var t = target.toLowerCase();
    var index = t.indexOf(q);
    if (index !== -1) return 1000 - index;
    var score = 0;
    var cursor = 0;
    for (var i = 0; i < q.length; i++) {
      var found = t.indexOf(q[i], cursor);
      if (found === -1) return 0;
      score += found === cursor ? 3 : 1;
      cursor = found + 1;
    }
    return score;
  }

  function renderPaletteResults(query) {
    state.paletteMatches = state.files
      .map(function (file) { return { file: file, score: fuzzyScore(query, file.path) }; })
      .filter(function (entry) { return entry.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 60)
      .map(function (entry) { return entry.file; });

    state.paletteIndex = 0;
    dom.paletteResults.textContent = '';
    state.paletteMatches.forEach(function (file, index) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'palette-item' + (index === 0 ? ' is-active' : '');
      var name = document.createElement('span');
      name.textContent = file.name;
      var path = document.createElement('small');
      path.textContent = file.path;
      item.appendChild(name);
      item.appendChild(path);
      item.addEventListener('click', function () {
        closePalette();
        openFileHandle(file.handle, { path: file.path });
      });
      dom.paletteResults.appendChild(item);
    });
  }

  function movePaletteSelection(delta) {
    var items = dom.paletteResults.querySelectorAll('.palette-item');
    if (!items.length) return;
    items[state.paletteIndex].classList.remove('is-active');
    state.paletteIndex = (state.paletteIndex + delta + items.length) % items.length;
    var active = items[state.paletteIndex];
    active.classList.add('is-active');
    active.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------------------------------------- exporting */

  function renderedHtml() {
    return MD.render(dom.editor.value).html;
  }

  function copyHtml() {
    navigator.clipboard.writeText(renderedHtml())
      .then(function () { toast('Rendered HTML copied'); })
      .catch(function (error) { toast('Copy failed: ' + error.message, true); });
  }

  function exportHtml() {
    if (!window.showSaveFilePicker) {
      toast('This Chrome build cannot save files directly.', true);
      return;
    }
    fetch(chrome.runtime.getURL('src/lib/markdown.css'))
      .then(function (response) { return response.text(); })
      .then(function (css) {
        var title = state.name.replace(/\.[^.]+$/, '');
        var doc = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
          '<title>' + MD.escapeHtml(title) + '</title>\n<style>\n' + css +
          '\nbody{margin:0;padding:40px 20px}' +
          '\n.md-body{max-width:820px;margin:0 auto}\n</style>\n</head>\n<body>\n' +
          '<article class="md-body">\n' + renderedHtml() + '\n</article>\n</body>\n</html>\n';
        return window.showSaveFilePicker({
          suggestedName: title + '.html',
          types: [{ description: 'HTML', accept: { 'text/html': ['.html'] } }]
        }).then(function (handle) {
          return writeFile(handle, doc).then(function () { toast('Exported ' + handle.name); });
        });
      })
      .catch(ignoreAbort);
  }

  /** Tidy or compact the open JSON or XML document, in place. */
  function formatData(minify) {
    if (state.kind === 'markdown') {
      toast('That is a Markdown document.', true);
      return;
    }
    try {
      var next = minify
        ? Structured.minifyJson(dom.editor.value)
        : Structured.format(state.kind, dom.editor.value);
      if (next === dom.editor.value) {
        toast('Already tidy');
        return;
      }
      applyEdit(0, dom.editor.value.length, next, 0, 0);
      toast(minify ? 'Minified' : 'Formatted');
    } catch (error) {
      toast('Cannot format: ' + error.message, true);
    }
  }

  function showShortcuts() {
    var existing = document.querySelector('dialog.help-dialog');
    if (existing) { existing.showModal(); return; }
    var dialog = document.createElement('dialog');
    dialog.className = 'help-dialog';
    dialog.innerHTML = [
      '<h2>Keyboard shortcuts</h2>',
      '<table>',
      '<tr><td><kbd>Ctrl/Cmd+S</kbd></td><td>Save to disk</td></tr>',
      '<tr><td><kbd>Ctrl/Cmd+Shift+S</kbd></td><td>Save as</td></tr>',
      '<tr><td><kbd>Ctrl/Cmd+P</kbd></td><td>Go to file in the folder</td></tr>',
      '<tr><td><kbd>Ctrl/Cmd+O</kbd></td><td>Open a file</td></tr>',
      '<tr><td><kbd>Ctrl/Cmd+B</kbd> / <kbd>I</kbd> / <kbd>E</kbd></td><td>Bold, italic, inline code</td></tr>',
      '<tr><td><kbd>Ctrl/Cmd+K</kbd></td><td>Insert link</td></tr>',
      '<tr><td><kbd>Ctrl/Cmd+H</kbd></td><td>Cycle heading level</td></tr>',
      '<tr><td><kbd>Ctrl/Cmd+1..3</kbd></td><td>Edit / Split / Preview</td></tr>',
      '<tr><td><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd></td><td>Indent / outdent lines</td></tr>',
      '<tr><td><kbd>Enter</kbd></td><td>Continue lists and task lists</td></tr>',
      '</table>',
      '<form method="dialog"><button class="btn btn-primary">Close</button></form>'
    ].join('\n');
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  /* ---------------------------------------------------------------- wiring */

  function onInput() {
    renderPreview();
    refreshDirtyIndicator();
    updateCursor();
    if (state.prefs && state.prefs.autosave) scheduleAutosave();
  }

  var scheduleAutosave = debounce(function () {
    if (state.prefs && state.prefs.autosave && state.handle && isDirty()) saveDocument();
  }, 1200);

  function setView(view) {
    dom.body.dataset.view = view;
    Array.prototype.forEach.call(document.querySelectorAll('.segmented button'), function (button) {
      button.classList.toggle('is-active', button.dataset.view === view);
    });
    Store.setPrefs({ view: view }).then(function (prefs) { state.prefs = prefs; });
  }

  function setTheme(theme) {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
      dom.preview.removeAttribute('data-theme');
    } else {
      document.documentElement.dataset.theme = theme;
      dom.preview.dataset.theme = theme;
    }
    dom.themeState.textContent = theme;
    Store.setPrefs({ theme: theme }).then(function (prefs) { state.prefs = prefs; });
  }

  function setAutosave(enabled) {
    dom.autosaveState.textContent = enabled ? 'on' : 'off';
    Store.setPrefs({ autosave: enabled }).then(function (prefs) {
      state.prefs = prefs;
      if (enabled) scheduleAutosave();
    });
  }

  dom.editor.addEventListener('input', onInput);
  dom.editor.addEventListener('click', updateCursor);
  dom.editor.addEventListener('keyup', updateCursor);

  dom.editor.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (state.kind === 'markdown' && handleEnter(event)) return;
    }
    if (event.key === 'Tab') handleTab(event);
  });

  dom.toolbar.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-cmd]');
    if (!button) return;
    var command = COMMANDS[button.dataset.cmd];
    if (command) command();
  });

  Array.prototype.forEach.call(document.querySelectorAll('.segmented button'), function (button) {
    button.addEventListener('click', function () { setView(button.dataset.view); });
  });

  dom.save.addEventListener('click', function () { saveDocument(); });
  dom.openFile.addEventListener('click', pickFile);
  dom.openFolder.addEventListener('click', pickFolder);
  dom.refresh.addEventListener('click', function () {
    scanWorkspace().then(function () { toast('Folder rescanned'); });
  });
  dom.bannerDismiss.addEventListener('click', hideBanner);

  dom.menuBtn.addEventListener('click', function (event) {
    event.stopPropagation();
    dom.menu.hidden = !dom.menu.hidden;
  });

  document.addEventListener('click', function (event) {
    if (!dom.menu.hidden && !dom.menu.contains(event.target) && event.target !== dom.menuBtn) {
      dom.menu.hidden = true;
    }
  });

  dom.menu.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    dom.menu.hidden = true;
    var action = button.dataset.action;
    if (action === 'format-data') formatData(false);
    else if (action === 'minify-data') formatData(true);
    else if (action === 'save-as') saveDocumentAs();
    else if (action === 'new-file') newFile();
    else if (action === 'quick-open') openPalette();
    else if (action === 'toggle-autosave') setAutosave(!(state.prefs && state.prefs.autosave));
    else if (action === 'toggle-theme') {
      var order = ['system', 'light', 'dark'];
      var current = (state.prefs && state.prefs.theme) || 'system';
      setTheme(order[(order.indexOf(current) + 1) % order.length]);
    } else if (action === 'copy-html') copyHtml();
    else if (action === 'export-html') exportHtml();
    else if (action === 'shortcuts') showShortcuts();
  });

  dom.paletteInput.addEventListener('input', function () {
    renderPaletteResults(dom.paletteInput.value.trim());
  });

  dom.paletteInput.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { closePalette(); return; }
    if (event.key === 'ArrowDown') { movePaletteSelection(1); event.preventDefault(); return; }
    if (event.key === 'ArrowUp') { movePaletteSelection(-1); event.preventDefault(); return; }
    if (event.key === 'Enter') {
      var file = state.paletteMatches[state.paletteIndex];
      if (file) { closePalette(); openFileHandle(file.handle, { path: file.path }); }
      event.preventDefault();
    }
  });

  dom.palette.addEventListener('click', function (event) {
    if (event.target === dom.palette) closePalette();
  });

  document.addEventListener('keydown', function (event) {
    var mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    var key = event.key.toLowerCase();

    if (key === 's') {
      event.preventDefault();
      if (event.shiftKey) saveDocumentAs(); else saveDocument();
      return;
    }
    if (key === 'p' && !event.shiftKey) { event.preventDefault(); openPalette(); return; }
    if (key === 'o') { event.preventDefault(); pickFile(); return; }
    if (key === '1') { event.preventDefault(); setView('edit'); return; }
    if (key === '2') { event.preventDefault(); setView('split'); return; }
    if (key === '3') { event.preventDefault(); setView('preview'); return; }

    if (document.activeElement !== dom.editor) return;
    if (key === 'b') { event.preventDefault(); COMMANDS.bold(); }
    else if (key === 'i') { event.preventDefault(); COMMANDS.italic(); }
    else if (key === 'e') { event.preventDefault(); COMMANDS.code(); }
    else if (key === 'k') { event.preventDefault(); COMMANDS.link(); }
    else if (key === 'h') { event.preventDefault(); COMMANDS.heading(); }
  });

  // Proportional scroll sync, editor -> preview, in split view only.
  dom.editor.addEventListener('scroll', function () {
    if (dom.body.dataset.view !== 'split' || state.suppressScrollSync) return;
    var scrollable = dom.editor.scrollHeight - dom.editor.clientHeight;
    if (scrollable <= 0) return;
    var ratio = dom.editor.scrollTop / scrollable;
    var target = dom.preview.parentElement;
    state.suppressScrollSync = true;
    target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
    requestAnimationFrame(function () { state.suppressScrollSync = false; });
  });

  // Drag the divider to resize the panes.
  dom.divider.addEventListener('pointerdown', function (event) {
    event.preventDefault();
    var panes = dom.divider.parentElement;
    var editorPane = panes.querySelector('.pane-editor');
    var previewPane = panes.querySelector('.pane-preview');
    var move = function (moveEvent) {
      var rect = panes.getBoundingClientRect();
      var ratio = Math.min(0.85, Math.max(0.15, (moveEvent.clientX - rect.left) / rect.width));
      editorPane.style.flex = '1 1 ' + (ratio * 100) + '%';
      previewPane.style.flex = '1 1 ' + ((1 - ratio) * 100) + '%';
    };
    var up = function () {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // Drop a file onto the window to open it. Chrome hands over a real handle,
  // so Save still writes back to the original file.
  window.addEventListener('dragover', function (event) { event.preventDefault(); });
  window.addEventListener('drop', function (event) {
    event.preventDefault();
    var item = event.dataTransfer.items && event.dataTransfer.items[0];
    if (item && item.getAsFileSystemHandle) {
      item.getAsFileSystemHandle().then(function (handle) {
        if (!handle) return;
        if (handle.kind === 'directory') useWorkspace(handle);
        else openFileHandle(handle, { path: handle.name });
      });
      return;
    }
    var file = event.dataTransfer.files[0];
    if (file) {
      file.text().then(function (text) {
        loadDocument(text, { name: file.name, path: file.name, unsaved: true });
      });
    }
  });

  window.addEventListener('focus', checkExternalChange);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkExternalChange();
  });

  window.addEventListener('beforeunload', function (event) {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  /* --------------------------------------------------------------- startup */

  function consumeHandoff(handoff) {
    if (!handoff || !handoff.text) return false;
    if (Date.now() - (handoff.at || 0) > 60000) return false;
    chrome.storage.session.remove('handoff');
    if (!confirmDiscard()) return false;
    loadDocument(handoff.text, {
      name: handoff.name || 'untitled.md',
      path: handoff.sourceUrl || '',
      unsaved: true
    });
    showBanner('Opened from ' + (handoff.sourceUrl || 'the page viewer') +
      '. Chrome cannot write back to that location, so use Save as to store your edits.',
      'Save as', function () { saveDocumentAs(); });
    return true;
  }

  chrome.storage.session.onChanged.addListener(function (changes) {
    if (changes.handoff && changes.handoff.newValue) consumeHandoff(changes.handoff.newValue);
  });

  function restoreSession(prefs) {
    return Store.all().then(function (records) {
      var workspace = records.filter(function (r) { return r.key === prefs.lastWorkspaceKey; })[0];
      var file = records.filter(function (r) { return r.key === prefs.lastFileKey; })[0];

      var chain = Promise.resolve();
      if (workspace) {
        // Reopen silently only while permission is still granted; otherwise the
        // entry stays under Recent and one click re-grants it.
        chain = chain.then(function () {
          return workspace.handle.queryPermission({ mode: 'readwrite' }).then(function (permission) {
            if (permission === 'granted') return useWorkspace(workspace.handle, true);
          });
        });
      }
      if (file) {
        chain = chain.then(function () {
          return file.handle.queryPermission({ mode: 'read' }).then(function (permission) {
            if (permission === 'granted') return openFileHandle(file.handle, { path: file.path });
          });
        });
      }
      return chain.catch(function () { /* stale handles are not fatal */ });
    });
  }

  // Exposed for the repo's own end-to-end harness (tools/e2e.js). The editor
  // page loads no third-party code, so this is a test seam, not an entry point
  // for anyone else.
  window.MarkdownWizard = {
    state: state,
    loadDocument: loadDocument,
    openFileHandle: openFileHandle,
    useWorkspace: useWorkspace,
    saveDocument: saveDocument,
    checkExternalChange: checkExternalChange,
    isDirty: isDirty
  };

  Store.getPrefs().then(function (prefs) {
    state.prefs = prefs;
    setView(prefs.view);
    setTheme(prefs.theme);
    dom.autosaveState.textContent = prefs.autosave ? 'on' : 'off';
    loadDocument('', { name: 'Untitled.md', path: '' });
    renderTree();
    renderRecents();
    return chrome.storage.session.get('handoff').then(function (data) {
      if (consumeHandoff(data.handoff)) return null;
      return restoreSession(prefs);
    });
  }).catch(function (error) {
    toast('Startup problem: ' + error.message, true);
  });
})();
