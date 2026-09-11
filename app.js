/*
 * Markdown Wizard (mobile).
 *
 * One document = one record. A document's identity is a stable id, and its
 * bytes live in exactly one OPFS file (`docs/<id>.md`) for the life of that
 * document. Editing rewrites that file in place; renaming touches metadata
 * only; importing a name that already exists asks what you meant instead of
 * quietly forking a second copy. Making a duplicate is a deliberate menu item.
 */
(function () {
  'use strict';

  var DB_NAME = 'markdown-wizard';
  var DB_VERSION = 1;
  var STORE = 'docs';
  var DOC_DIR = 'docs';
  var AUTOSAVE_MS = 700;
  // Shown in the library footer so it is possible to tell which build is
  // actually running after an update; keep in step with the cache in sw.js.
  var BUILD = 'build 13';
  var PREVIEW_CHARS = 160;

  /* =====================================================================
     Storage: IndexedDB holds metadata, OPFS holds the bytes.
     ===================================================================== */

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function tx(mode, run) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(STORE, mode);
        var request = run(transaction.objectStore(STORE));
        transaction.oncomplete = function () { db.close(); resolve(request && request.result); };
        transaction.onerror = function () { db.close(); reject(transaction.error); };
      });
    });
  }

  function docsDir() {
    return navigator.storage.getDirectory().then(function (root) {
      return root.getDirectoryHandle(DOC_DIR, { create: true });
    });
  }

  function docFile(id, create) {
    return docsDir().then(function (dir) {
      return dir.getFileHandle(id + '.md', { create: !!create });
    });
  }

  function newId() {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** First line of real prose, for the library list. Structural markup makes a
      poor summary, so headings, fences, tables and front matter are skipped and
      list markers are stripped. */
  function summarise(text, kind) {
    if (kind === 'json' || kind === 'xml') {
      // Structure, not prose: a squashed head of the document reads better than
      // a lone brace or the XML prolog.
      return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
    }
    var line = text.split('\n').find(function (candidate) {
      var trimmed = candidate.trim();
      return trimmed &&
        !/^#{1,6}\s/.test(trimmed) &&
        !/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed) &&
        !/^(```|~~~)/.test(trimmed) &&
        !/^\|/.test(trimmed);
    }) || '';
    return line
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/[#*_`>~\[\]]/g, '')
      .trim()
      .slice(0, PREVIEW_CHARS);
  }

  var Library = {
    list: function () {
      return tx('readonly', function (store) { return store.getAll(); }).then(function (rows) {
        return (rows || []).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      });
    },

    get: function (id) {
      return tx('readonly', function (store) { return store.get(id); });
    },

    create: function (title, text, kind) {
      var now = Date.now();
      var documentKind = kind || Structured.detect(title, text);
      var meta = {
        id: newId(),
        title: title || 'Untitled',
        kind: documentKind,
        createdAt: now,
        updatedAt: now,
        size: text.length,
        preview: summarise(text, documentKind)
      };
      return docFile(meta.id, true).then(function (handle) {
        return write(handle, text);
      }).then(function () {
        return tx('readwrite', function (store) { store.put(meta); });
      }).then(function () { return meta; });
    },

    read: function (id) {
      return Library.get(id).then(function (meta) {
        if (!meta) return null;
        return docFile(meta.id).then(function (handle) {
          return handle.getFile();
        }).then(function (file) {
          return file.text().then(function (text) {
            return { meta: meta, text: text, lastModified: file.lastModified };
          });
        });
      });
    },

    /** Writes back to the document's own file. Never creates a second one. */
    save: function (id, text) {
      return Library.get(id).then(function (meta) {
        if (!meta) throw new Error('That document no longer exists.');
        return docFile(id, true).then(function (handle) {
          return write(handle, text).then(function () { return handle.getFile(); });
        }).then(function (file) {
          meta.updatedAt = Date.now();
          meta.size = text.length;
          meta.kind = meta.kind || Structured.detect(meta.title, text);
          meta.preview = summarise(text, meta.kind);
          return tx('readwrite', function (store) { store.put(meta); }).then(function () {
            return { meta: meta, lastModified: file.lastModified };
          });
        });
      });
    },

    rename: function (id, title) {
      return Library.get(id).then(function (meta) {
        if (!meta) return null;
        // The file is named after the id, so a rename is metadata only - there
        // is nothing to copy and no way to end up with two files.
        meta.title = title;
        meta.updatedAt = Date.now();
        return tx('readwrite', function (store) { store.put(meta); }).then(function () { return meta; });
      });
    },

    /** Hiding is a view decision, not an edit: the file is untouched and the
        document keeps its place in the sort, so unhiding puts it back exactly
        where it was. */
    setHidden: function (id, hidden) {
      return Library.get(id).then(function (meta) {
        if (!meta) return null;
        if (hidden) meta.hidden = true; else delete meta.hidden;
        return tx('readwrite', function (store) { store.put(meta); }).then(function () { return meta; });
      });
    },

    remove: function (id) {
      return docsDir().then(function (dir) {
        return dir.removeEntry(id + '.md').catch(function () { /* already gone */ });
      }).then(function () {
        return tx('readwrite', function (store) { store.delete(id); });
      });
    },

    duplicate: function (id) {
      return Library.read(id).then(function (doc) {
        if (!doc) return null;
        return Library.create(doc.meta.title + ' copy', doc.text, doc.meta.kind);
      });
    },

    findByTitle: function (title) {
      var needle = String(title).trim().toLowerCase();
      return Library.list().then(function (rows) {
        return rows.filter(function (row) { return row.title.trim().toLowerCase() === needle; })[0] || null;
      });
    },

    /** Replaces an existing document's contents, keeping its id and history. */
    replaceContents: function (id, text) {
      return Library.save(id, text);
    }
  };

  function write(handle, text) {
    return handle.createWritable().then(function (writable) {
      return writable.write(text).then(function () { return writable.close(); });
    });
  }

  var LEGACY_DB_NAME = 'markdown-studio';

  /** The app was renamed, which moved the metadata database. Document bytes are
      unaffected (they live in OPFS under docs/), so a rename only has to carry
      the metadata rows across, once, into an empty library. */
  function migrateLegacyLibrary() {
    return Library.list().then(function (rows) {
      if (rows.length) return null;
      return openLegacyDb().then(function (db) {
        if (!db) return null;
        return readLegacyRows(db).then(function (legacy) {
          db.close();
          if (!legacy.length) return null;
          return tx('readwrite', function (store) {
            legacy.forEach(function (row) { store.put(row); });
          }).then(function () {
            toast('Restored ' + legacy.length +
              (legacy.length === 1 ? ' document' : ' documents'));
          });
        });
      });
    }).catch(function () { /* a failed migration must not block startup */ });
  }

  function openLegacyDb() {
    return new Promise(function (resolve) {
      var request = indexedDB.open(LEGACY_DB_NAME);
      request.onerror = function () { resolve(null); };
      request.onsuccess = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // Opening created an empty database; drop it again rather than
          // leaving litter behind.
          db.close();
          indexedDB.deleteDatabase(LEGACY_DB_NAME);
          resolve(null);
          return;
        }
        resolve(db);
      };
      request.onupgradeneeded = function () { /* legacy store is absent */ };
    });
  }

  function readLegacyRows(db) {
    return new Promise(function (resolve) {
      try {
        var request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        request.onsuccess = function () { resolve(request.result || []); };
        request.onerror = function () { resolve([]); };
      } catch (error) {
        resolve([]);
      }
    });
  }

  /* =====================================================================
     Cross-tab coordination
     ===================================================================== */

  var channel = ('BroadcastChannel' in self) ? new BroadcastChannel('markdown-wizard') : null;

  function announce(message) {
    if (channel) channel.postMessage(message);
  }

  /* =====================================================================
     DOM helpers
     ===================================================================== */

  var el = function (id) { return document.getElementById(id); };

  var dom = {
    library: el('screen-library'),
    editorScreen: el('screen-editor'),
    list: el('doc-list'),
    libraryEmpty: el('library-empty'),
    search: el('search'),
    storageLine: el('storage-line'),
    newBtn: el('btn-new'),
    importBtn: el('btn-import'),
    fileInput: el('file-input'),
    back: el('btn-back'),
    title: el('editor-title'),
    saveState: el('save-state'),
    viewBtn: el('btn-view'),
    moreBtn: el('btn-more'),
    editor: el('editor'),
    preview: el('preview'),
    dataView: el('data-view'),
    formatBar: el('format-bar'),
    dataBar: el('data-bar'),
    dataStatus: el('data-status'),
    conflict: el('conflict'),
    conflictText: el('conflict-text'),
    conflictReload: el('conflict-reload'),
    conflictKeep: el('conflict-keep'),
    sheet: el('sheet'),
    sheetTitle: el('sheet-title'),
    sheetBody: el('sheet-body'),
    prompt: el('prompt'),
    promptTitle: el('prompt-title'),
    promptText: el('prompt-text'),
    promptInput: el('prompt-input'),
    promptActions: el('prompt-actions'),
    toast: el('toast')
  };

  var toastTimer = null;
  function toast(message, isError, action) {
    dom.toast.textContent = message;
    dom.toast.classList.toggle('is-error', !!isError);

    if (action) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action';
      button.textContent = action.label;
      button.addEventListener('click', function () {
        dom.toast.hidden = true;
        clearTimeout(toastTimer);
        action.onClick();
      });
      dom.toast.appendChild(button);
    }

    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    // An action needs long enough to be read and reached for.
    toastTimer = setTimeout(function () { dom.toast.hidden = true; },
      action ? 6000 : (isError ? 4000 : 2000));
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  function relativeTime(stamp) {
    var seconds = Math.round((Date.now() - stamp) / 1000);
    if (seconds < 60) return 'just now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours === 1 ? 'an hour ago' : hours + ' hours ago';
    var days = Math.round(hours / 24);
    if (days < 7) return days === 1 ? 'yesterday' : days + ' days ago';
    return new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ----------------------------------------------------- sheet + prompt */

  function openSheet(title, items) {
    dom.sheetTitle.textContent = title;
    dom.sheetBody.textContent = '';
    items.forEach(function (item) {
      if (item.separator) {
        dom.sheetBody.appendChild(document.createElement('hr'));
        return;
      }
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'sheet-item' + (item.danger ? ' danger' : '');
      var label = document.createElement('span');
      label.textContent = item.label;
      button.appendChild(label);
      if (item.detail) {
        var detail = document.createElement('small');
        detail.textContent = item.detail;
        button.appendChild(detail);
      }
      button.addEventListener('click', function () {
        closeSheet();
        if (item.onClick) item.onClick();
      });
      dom.sheetBody.appendChild(button);
    });
    dom.sheet.hidden = false;
  }

  function closeSheet() { dom.sheet.hidden = true; }

  dom.sheet.addEventListener('click', function (event) {
    if (event.target === dom.sheet) closeSheet();
  });

  /** A promise-based replacement for confirm()/prompt(), which are unreliable
      (and ugly) in an installed PWA. */
  function ask(options) {
    return new Promise(function (resolve) {
      dom.promptTitle.textContent = options.title;
      dom.promptText.textContent = options.text || '';
      dom.promptText.hidden = !options.text;
      dom.promptInput.hidden = !options.input;
      if (options.input) {
        dom.promptInput.value = options.input.value || '';
        dom.promptInput.placeholder = options.input.placeholder || '';
      }
      dom.promptActions.textContent = '';

      var finish = function (value) {
        dom.prompt.hidden = true;
        dom.promptActions.textContent = '';
        resolve(value);
      };

      (options.actions || []).forEach(function (action) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'prompt-button' +
          (action.primary ? ' primary' : '') + (action.danger ? ' danger' : '');
        button.textContent = action.label;
        button.addEventListener('click', function () {
          finish(options.input ? { value: action.value, text: dom.promptInput.value.trim() } : action.value);
        });
        dom.promptActions.appendChild(button);
      });

      dom.prompt.hidden = false;
      if (options.input) {
        dom.promptInput.focus();
        dom.promptInput.select();
      }
      dom.prompt.onclick = function (event) { if (event.target === dom.prompt) finish(null); };
    });
  }

  /* =====================================================================
     Library screen
     ===================================================================== */

  var libraryRows = [];
  // Hidden documents are out of the list until this is turned on.
  var showingHidden = false;

  function renderLibrary() {
    return Library.list().then(function (rows) {
      libraryRows = rows;
      paintLibrary();
      updateStorageLine(rows);
    });
  }

  function paintLibrary() {
    var query = dom.search.value.trim().toLowerCase();
    var listed = libraryRows.filter(function (row) { return showingHidden || !row.hidden; });
    var rows = !query ? listed : listed.filter(function (row) {
      return (row.title + ' ' + (row.preview || '')).toLowerCase().indexOf(query) !== -1;
    });

    dom.list.textContent = '';
    dom.libraryEmpty.hidden = libraryRows.length > 0;

    if (listed.length && !rows.length) {
      var none = document.createElement('p');
      none.className = 'empty-state';
      none.textContent = 'Nothing matches "' + dom.search.value.trim() + '".';
      dom.list.appendChild(none);
      return;
    }

    rows.forEach(function (row) {
      var item = document.createElement('div');
      item.className = 'doc-item' + (row.hidden ? ' is-hidden-doc' : '');
      item.setAttribute('role', 'listitem');

      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'doc-open';
      open.dataset.id = row.id;

      var name = document.createElement('span');
      name.className = 'doc-name';
      name.textContent = row.title;
      var rowKind = row.kind || 'markdown';
      if (rowKind !== 'markdown') {
        var badge = document.createElement('span');
        badge.className = 'doc-kind';
        badge.textContent = Structured.label(rowKind);
        name.appendChild(badge);
      }
      if (row.hidden) {
        var mark = document.createElement('span');
        mark.className = 'doc-kind';
        mark.textContent = 'Hidden';
        name.appendChild(mark);
      }

      var meta = document.createElement('span');
      meta.className = 'doc-meta';
      meta.textContent = relativeTime(row.updatedAt) + ' · ' + formatBytes(row.size || 0);

      var preview = document.createElement('span');
      preview.className = 'doc-preview';
      preview.textContent = row.preview || 'Empty document';

      open.appendChild(name);
      open.appendChild(preview);
      open.appendChild(meta);
      open.addEventListener('click', function (event) {
        // A swipe ends in a click; that click is not a tap on the document.
        if (Swipe.wasSwipe(open)) {
          event.preventDefault();
          return;
        }
        location.hash = '#/d/' + row.id;
      });

      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'doc-more';
      more.textContent = '⋯';
      more.setAttribute('aria-label', 'Actions for ' + row.title);
      more.addEventListener('click', function (event) {
        event.stopPropagation();
        documentActions(row, false);
      });

      var hint = document.createElement('span');
      hint.className = 'doc-hint';
      hint.dataset.word = row.hidden ? 'Show' : 'Hide';

      item.appendChild(hint);
      item.appendChild(open);
      item.appendChild(more);
      Swipe.enable(item, open, function () { setDocumentHidden(row, !row.hidden); });
      dom.list.appendChild(item);
    });
  }

  /** Takes a document out of the list, or puts it back. Nothing is deleted:
      the document stays on the device with its text intact, which is the whole
      point of having this as well as Delete. */
  function setDocumentHidden(row, hidden) {
    return Library.setHidden(row.id, hidden).then(function () {
      announce({ type: 'library' });
      return renderLibrary();
    }).then(function () {
      toast(hidden ? 'Hidden from the list · ' + row.title : 'Back in the list · ' + row.title,
        false, hidden ? {
          label: 'Undo',
          onClick: function () { setDocumentHidden(row, false); }
        } : null);
    });
  }

  function updateStorageLine(rows) {
    var count = rows.length;
    var bytes = rows.reduce(function (total, row) { return total + (row.size || 0); }, 0);
    var away = rows.filter(function (row) { return row.hidden; }).length;

    dom.storageLine.textContent = count
      ? count + (count === 1 ? ' document' : ' documents') + ' · ' + formatBytes(bytes) + ' on this device'
      : 'No documents yet';

    // Hidden documents are still counted above, because they are still here.
    // Saying so, and offering the way back, is what keeps hiding from feeling
    // like losing something.
    if (away) {
      dom.storageLine.appendChild(document.createTextNode(' · ' + away + ' hidden '));
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'line-action';
      toggle.id = 'show-hidden';
      toggle.textContent = showingHidden ? 'Hide them again' : 'Show hidden';
      toggle.addEventListener('click', function () {
        showingHidden = !showingHidden;
        paintLibrary();
        updateStorageLine(libraryRows);
      });
      dom.storageLine.appendChild(toggle);
    } else if (showingHidden) {
      showingHidden = false;
    }

    dom.storageLine.appendChild(document.createTextNode(' · ' + BUILD));
  }

  dom.search.addEventListener('input', paintLibrary);

  dom.newBtn.addEventListener('click', function () {
    ask({
      title: 'New document',
      text: 'End the name with .json or .xml for a data file; anything else is Markdown.',
      input: { value: '', placeholder: 'Title' },
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Create', value: 'create', primary: true }
      ]
    }).then(function (result) {
      if (!result || result.value !== 'create') return;
      var title = result.text || 'Untitled';
      var kind = Structured.detect(title, '');
      var seed = kind === 'json' ? '{\n  \n}\n'
        : kind === 'xml' ? '<root>\n  \n</root>\n'
        : '# ' + title + '\n\n';
      return Library.create(title, seed, kind).then(function (meta) {
        announce({ type: 'library' });
        openForWriting = meta.id;
        location.hash = '#/d/' + meta.id;
      });
    });
  });

  /* ------------------------------------------------------------ import */

  dom.importBtn.addEventListener('click', function () { dom.fileInput.click(); });

  dom.fileInput.addEventListener('change', function () {
    var files = Array.prototype.slice.call(dom.fileInput.files || []);
    dom.fileInput.value = '';
    if (!files.length) return;
    importSequentially(files, 0);
  });

  function importSequentially(files, index) {
    if (index >= files.length) {
      renderLibrary();
      return;
    }
    importOne(files[index]).then(function () {
      importSequentially(files, index + 1);
    });
  }

  function importOne(file) {
    var title = file.name.replace(/\.[^.]+$/, '');
    return file.text().then(function (text) {
      var kind = Structured.detect(file.name, text);
      return Library.findByTitle(title).then(function (existing) {
        if (!existing) {
          return Library.create(title, text, kind).then(function () {
            toast('Imported ' + title);
          });
        }
        return Library.read(existing.id).then(function (doc) {
          if (doc && doc.text === text) {
            toast(title + ' is already in your library');
            return;
          }
          // The whole point of this dialog: importing the same name twice must
          // not silently leave you with two documents.
          return ask({
            title: '"' + title + '" already exists',
            text: 'Updated ' + relativeTime(existing.updatedAt) +
              '. Update that document, or keep both as separate documents?',
            actions: [
              { label: 'Cancel', value: null },
              { label: 'Keep both', value: 'both' },
              { label: 'Update it', value: 'replace', primary: true }
            ]
          }).then(function (choice) {
            if (choice === 'replace') {
              return Library.replaceContents(existing.id, text).then(function () {
                announce({ type: 'saved', id: existing.id });
                toast('Updated ' + title);
              });
            }
            if (choice === 'both') {
              return Library.create(title + ' (imported)', text, kind).then(function () {
                toast('Imported as "' + title + ' (imported)"');
              });
            }
          });
        });
      });
    }).catch(function (error) {
      toast('Could not import ' + file.name + ': ' + error.message, true);
    });
  }

  /* ------------------------------------------------------ doc actions */

  function documentActions(meta, fromEditor) {
    openSheet(meta.title, [
      {
        label: 'Rename',
        onClick: function () {
          ask({
            title: 'Rename',
            input: { value: meta.title, placeholder: 'Title' },
            actions: [
              { label: 'Cancel', value: null },
              { label: 'Rename', value: 'rename', primary: true }
            ]
          }).then(function (result) {
            if (!result || result.value !== 'rename' || !result.text) return;
            return Library.rename(meta.id, result.text).then(function (updated) {
              announce({ type: 'library' });
              if (current && current.id === meta.id) {
                current.title = updated.title;
                dom.title.textContent = updated.title;
              }
              renderLibrary();
              toast('Renamed');
            });
          });
        }
      },
      {
        label: 'Share or save a copy',
        detail: 'Sends a .md file out. Your document stays here.',
        onClick: function () { exportDoc(meta); }
      },
      {
        label: 'Copy Markdown',
        onClick: function () {
          Library.read(meta.id).then(function (doc) {
            return navigator.clipboard.writeText(doc.text);
          }).then(function () { toast('Copied'); })
            .catch(function (error) { toast('Copy failed: ' + error.message, true); });
        }
      },
      {
        label: 'Duplicate',
        detail: 'Deliberately makes a second document.',
        onClick: function () {
          Library.duplicate(meta.id).then(function () {
            renderLibrary();
            toast('Duplicated');
          });
        }
      },
      { separator: true },
      {
        label: meta.hidden ? 'Show in list' : 'Hide from list',
        detail: meta.hidden
          ? 'Puts it back among the documents.'
          : 'Tidies the list only. The document stays on this device.',
        onClick: function () { setDocumentHidden(meta, !meta.hidden); }
      },
      {
        label: 'Document info',
        onClick: function () { showInfo(meta); }
      },
      {
        label: 'Copy image report',
        detail: 'What this app sees for each picture, for troubleshooting.',
        onClick: function () { copyImageReport(meta); }
      },
      {
        label: 'Delete',
        danger: true,
        onClick: function () {
          ask({
            title: 'Delete "' + meta.title + '"?',
            text: 'This erases it from this device, text and all. It cannot be undone. ' +
              'To tidy the list without losing anything, use Hide from list instead.',
            actions: [
              { label: 'Cancel', value: null },
              { label: 'Delete', value: 'delete', danger: true }
            ]
          }).then(function (choice) {
            if (choice !== 'delete') return;
            return Library.remove(meta.id).then(function () {
              announce({ type: 'library' });
              toast('Deleted');
              if (fromEditor || (current && current.id === meta.id)) {
                current = null;
                location.hash = '#/';
              }
              renderLibrary();
            });
          });
        }
      }
    ]);
  }

  /** When a picture will not appear, the useful facts are what the file asked
      for and what that was turned into. This puts both on the clipboard. */
  function copyImageReport(meta) {
    Library.read(meta.id).then(function (doc) {
      var lines = [BUILD, 'document: ' + meta.title, 'kind: ' + (meta.kind || 'unknown')];

      var parsed = Structured.parseXml(doc.text);
      var model = parsed.error ? null : Book.parse(parsed.doc);
      if (!model) {
        lines.push('not read as a book' + (parsed.error ? ' (' + parsed.error + ')' : ''));
      } else {
        var catalogued = Object.keys(model.images || {});
        lines.push('book: ' + model.title);
        lines.push('base url: ' + (model.baseUrl || '(none found)'));
        lines.push('catalogued images: ' + catalogued.length);
        catalogued.slice(0, 3).forEach(function (key) {
          lines.push('  ' + key + ' -> ' + model.images[key]);
        });

        var withImages = model.reading.filter(function (entry) { return /<img/i.test(entry.html); });
        lines.push('sections with images: ' + withImages.length + ' of ' + model.reading.length);

        var entry = withImages[0];
        if (entry) {
          lines.push('');
          lines.push('first section with images: ' + entry.title);
          lines.push('section url: ' + (entry.url || '(none)'));
          (entry.html.match(/<img[^>]*>/gi) || []).slice(0, 4).forEach(function (tag) {
            lines.push('  as written: ' + tag.slice(0, 240));
          });
          var host = document.createElement('div');
          host.appendChild(Book.sanitize(entry.html, entry.url || model.baseUrl, model.images));
          Array.prototype.slice.call(host.querySelectorAll('img'), 0, 4).forEach(function (image) {
            lines.push('  resolved to: ' + image.getAttribute('src'));
          });
        }
      }

      var report = lines.join('\n');
      return navigator.clipboard.writeText(report).then(function () {
        toast('Image report copied');
      }).catch(function () {
        // Clipboard access can be refused; show it so it can still be read.
        openSheet('Image report', report.split('\n').map(function (line) {
          return { label: line || ' ' };
        }));
      });
    }).catch(function (error) {
      toast('Could not build the report: ' + error.message, true);
    });
  }

  function showInfo(meta) {
    Library.read(meta.id).then(function (doc) {
      var words = doc.text.trim() ? doc.text.trim().split(/\s+/).length : 0;
      var lines = doc.text.split('\n').length;
      openSheet(meta.title, [
        { label: words.toLocaleString() + ' words', detail: lines + ' lines · ' + formatBytes(doc.text.length) },
        { label: 'Updated ' + relativeTime(meta.updatedAt), detail: new Date(meta.updatedAt).toLocaleString() },
        { label: 'Created ' + relativeTime(meta.createdAt), detail: new Date(meta.createdAt).toLocaleString() },
        { label: Structured.label(meta.kind || Structured.detect(meta.title, doc.text)),
          detail: 'docs/' + meta.id + '.md in this browser' }
      ]);
    });
  }

  function exportDoc(meta) {
    Library.read(meta.id).then(function (doc) {
      var kind = meta.kind || Structured.detect(meta.title, doc.text);
      var extension = Structured.extensionFor(kind);
      var base = meta.title.replace(/[\\/:*?"<>|]/g, '-');
      // Do not end up with "config.json.json".
      var fileName = base.toLowerCase().endsWith(extension) ? base : base + extension;
      var file = new File([doc.text], fileName, { type: Structured.mimeFor(kind) });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: meta.title })
          .catch(function (error) {
            if (error && error.name === 'AbortError') return;
            downloadFile(file, fileName);
          });
      }
      downloadFile(file, fileName);
    }).catch(function (error) {
      toast('Export failed: ' + error.message, true);
    });
  }

  function downloadFile(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    toast('Saved a copy of ' + fileName);
  }

  /* =====================================================================
     Editor screen
     ===================================================================== */

  var current = null;      // { id, title, savedText, lastModified }
  var showingPreview = false;
  // Set when a document is created, so making one lands in the editor.
  var openForWriting = null;

  function openDocument(id) {
    return Library.read(id).then(function (doc) {
      if (!doc) {
        toast('That document is gone.', true);
        location.hash = '#/';
        return;
      }
      current = {
        id: doc.meta.id,
        title: doc.meta.title,
        // Rows written before JSON and XML were supported have no kind.
        kind: doc.meta.kind || Structured.detect(doc.meta.title, doc.text),
        savedText: doc.text,
        lastModified: doc.lastModified
      };
      dom.editor.value = doc.text;
      dom.title.textContent = doc.meta.title;
      rich = { text: null, kind: null, widget: null, label: '', mode: 'rich', root: null };
      applyKind(current.kind);
      hideConflict();
      // A document is opened to be read: the formatted view leads, and the
      // text is one tap away. A new or empty one is opened to be written.
      setPreview(doc.text.trim().length > 0 && openForWriting !== doc.meta.id);
      openForWriting = null;
      setSaveState('saved');
      renderPreview();
    });
  }

  function setSaveState(state) {
    var labels = { saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved', error: 'Not saved' };
    dom.saveState.textContent = labels[state] || '';
    dom.saveState.className = 'save-state is-' + state;
  }

  var queueSave = debounce(function () { saveNow(); }, AUTOSAVE_MS);

  function saveNow() {
    if (!current) return Promise.resolve();
    var text = dom.editor.value;
    if (text === current.savedText) {
      setSaveState('saved');
      return Promise.resolve();
    }
    setSaveState('saving');
    var id = current.id;
    return Library.save(id, text).then(function (result) {
      if (!current || current.id !== id) return;
      current.savedText = text;
      current.lastModified = result.lastModified;
      setSaveState('saved');
      announce({ type: 'saved', id: id, at: result.meta.updatedAt });
    }).catch(function (error) {
      setSaveState('error');
      toast('Could not save: ' + error.message, true);
    });
  }

  dom.editor.addEventListener('input', function () {
    setSaveState('unsaved');
    queueSave();
    if (showingPreview) renderPreview();
    if (current && current.kind !== 'markdown') queueValidate();
  });

  var queueValidate = debounce(validate, 250);

  var renderPreview = debounce(function () {
    if (!showingPreview) return;
    paintPreview();
  }, 90);

  /* Some XML is really a book or a feed - a WordPress or Pressbooks export
     carries chapters as <item> elements - and a tree of 5,000 elements is a
     useless way to read one. Those get a table of contents instead, with the
     raw tree still a button away. */
  /* A tree is right for arbitrary data and wrong for data with a shape: a
     WordPress export is a book, and an array of like objects is a table. Both
     get a view of their own, with the tree still a tap away. */
  var rich = { text: null, kind: null, widget: null, label: '', mode: 'rich', root: null };

  function bookFor(text) {
    if (rich.text === text && rich.kind === 'xml') return rich.widget;
    resetRich(text, 'xml');
    var parsed = Structured.parseXml(text);
    if (parsed.error) return null;
    var model = Book.parse(parsed.doc);
    if (model) {
      rich.widget = Book.create(model);
      rich.label = model.title + ' · ' + model.reading.length +
        (model.reading.length === 1 ? ' section' : ' sections');
      rich.alternateName = 'Contents';
    }
    return rich.widget;
  }

  function recordsFor(text) {
    if (rich.text === text && rich.kind === 'json') return rich.widget;
    resetRich(text, 'json');

    var root;
    try {
      root = JSON.parse(text);
    } catch (error) {
      return null;
    }

    var found = Records.collections(root);
    if (!found.length) return null;
    var collection = found[0];

    rich.root = root;
    rich.widget = Records.create({
      collection: collection,
      onEdit: editRecordField,
      onDelete: confirmRecordDelete,
      onRemoved: announceRemoval,
      onHidden: announceHidden,
      onChange: writeBackRecords
    });
    rich.label = (collection.label === 'root' ? 'records' : collection.label) + ' · ' +
      collection.count + (collection.count === 1 ? ' record' : ' records');
    rich.alternateName = 'Records';
    return rich.widget;
  }

  function resetRich(text, kind) {
    rich.text = text;
    rich.kind = kind;
    rich.widget = null;
    rich.root = null;
    rich.label = '';
    rich.alternateName = 'Rich';
  }

  /** Editing goes through the parsed value and the document is written back
      with JSON.stringify, so a document cannot be left invalid by editing. */
  function writeBackRecords() {
    if (!rich.root) return;
    var next = Records.serialise(rich.root, dom.editor.value);
    dom.editor.value = next;
    // Keep the cache in step so the open record and filter survive the save.
    rich.text = next;
    dom.editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Asks for a new value, keeping the type the field already had. */
  function editRecordField(record, field, value) {
    var kind = Records.typeOf(value);

    if (kind === 'boolean') {
      return ask({
        title: field,
        text: 'Currently ' + value + '.',
        actions: [
          { label: 'Cancel', value: null },
          { label: 'false', value: 'false' },
          { label: 'true', value: 'true', primary: true }
        ]
      }).then(function (choice) {
        if (choice === null) return null;
        return { value: choice === 'true' };
      });
    }

    var asText = kind === 'object' || kind === 'array'
      ? JSON.stringify(value, null, 2)
      : (value === undefined || value === null ? '' : String(value));

    return ask({
      title: field,
      text: kind === 'object' || kind === 'array'
        ? 'Edited as JSON; it has to parse before it will be saved.'
        : 'Currently a ' + kind + '.',
      input: { value: asText, placeholder: field },
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Save', value: 'save', primary: true }
      ]
    }).then(function (result) {
      if (!result || result.value !== 'save') return null;
      var text = result.text;

      if (kind === 'object' || kind === 'array') {
        try {
          return { value: JSON.parse(text) };
        } catch (error) {
          toast('That is not valid JSON, so nothing was changed.', true);
          return null;
        }
      }
      if (kind === 'number') {
        var number = Number(text);
        if (text.trim() === '' || isNaN(number)) {
          toast('That field holds a number.', true);
          return null;
        }
        return { value: number };
      }
      if (kind === 'string') return { value: text };

      // Null or absent: take whatever JSON it parses as, or a plain string.
      try {
        return { value: JSON.parse(text) };
      } catch (error) {
        return { value: text };
      }
    });
  }

  /** Swiping a row aside only takes it out of the list being shown; the
      document is not touched, and the row comes back with Show all. */
  function announceHidden(record, restore) {
    var name = Records.preview(record[rich.widget.headline]);
    toast('Hidden from the list · ' + name, false, { label: 'Undo', onClick: restore });
  }

  /** Deleting really does change the document, so it says so. */
  function announceRemoval(record, restore) {
    var name = Records.preview(record[rich.widget.headline]);
    toast('Deleted ' + name + ' from the document', false,
      { label: 'Undo', onClick: restore });
  }

  function confirmRecordDelete(record) {
    return ask({
      title: 'Delete this record?',
      text: 'It is removed from the document when you save.',
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Delete', value: 'delete', danger: true }
      ]
    }).then(function (choice) { return choice === 'delete'; });
  }

  /** Markdown renders to HTML; JSON and XML render to a tree of real nodes,
      unless the XML turns out to be a book. */
  function paintPreview() {
    var kind = current ? current.kind : 'markdown';
    if (kind === 'markdown') {
      dom.preview.innerHTML = MD.render(dom.editor.value).html;
      return;
    }

    var widget = kind === 'xml' ? bookFor(dom.editor.value)
      : kind === 'json' ? recordsFor(dom.editor.value) : null;
    updateDataBar(!!widget);

    if (widget && rich.mode === 'rich') {
      if (dom.dataView.firstChild !== widget.node) dom.dataView.replaceChildren(widget.node);
      setDataStatus(rich.label, false);
      return;
    }

    var result = Structured.render(kind, dom.editor.value);
    dom.dataView.replaceChildren(result.node);
    setDataStatus(result.error || result.summary, !!result.error);
  }

  /** The book toggle only exists for documents that are one, and Expand and
      Collapse only mean something in the tree. */
  function updateDataBar(hasRichView) {
    var modeButton = dom.dataBar.querySelector('[data-data-cmd="mode"]');
    var reading = hasRichView && rich.mode === 'rich';
    if (modeButton) {
      modeButton.hidden = !hasRichView;
      modeButton.textContent = reading ? 'Tree' : (rich.alternateName || 'Rich');
    }
    ['expand', 'collapse'].forEach(function (name) {
      var node = dom.dataBar.querySelector('[data-data-cmd="' + name + '"]');
      if (node) node.hidden = reading;
    });
  }

  function setDataStatus(text, isError) {
    dom.dataStatus.textContent = text || '';
    dom.dataStatus.classList.toggle('is-error', !!isError);
  }

  /** Swaps the toolbars and the preview host for the document's format. */
  function applyKind(kind) {
    var isData = kind === 'json' || kind === 'xml';
    document.body.dataset.kind = kind;
    var minify = dom.dataBar.querySelector('[data-data-cmd="minify"]');
    if (minify) minify.hidden = kind !== 'json';
    dom.formatBar.hidden = isData || showingPreview;
    dom.dataBar.hidden = !isData;
    if (isData) validate();
  }

  /** Data files get a running verdict even while editing, so a stray comma is
      obvious before you leave the document. */
  function validate() {
    if (!current || current.kind === 'markdown') return;
    var result = Structured.render(current.kind, dom.editor.value);
    setDataStatus(result.error || result.summary, !!result.error);
  }

  function setPreview(on) {
    showingPreview = on;
    var kind = current ? current.kind : 'markdown';
    var isData = kind === 'json' || kind === 'xml';
    dom.preview.hidden = !on || isData;
    dom.dataView.hidden = !on || !isData;
    dom.editor.hidden = on;
    dom.formatBar.hidden = on || isData;
    dom.dataBar.hidden = !isData;
    dom.viewBtn.classList.toggle('is-active', on);
    dom.viewBtn.setAttribute('aria-label', on ? 'Back to editing' : 'Preview');
    if (on) paintPreview();
  }

  dom.viewBtn.addEventListener('click', function () { setPreview(!showingPreview); });

  dom.moreBtn.addEventListener('click', function () {
    if (!current) return;
    Library.get(current.id).then(function (meta) { documentActions(meta, true); });
  });

  dom.back.addEventListener('click', function () {
    saveNow().then(function () { location.hash = '#/'; });
  });

  /* ------------------------------------------------- formatting commands */

  function applyEdit(start, end, text, selStart, selEnd) {
    dom.editor.focus();
    dom.editor.setSelectionRange(start, end);
    var inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      // Safari can refuse execCommand; fall back to a manual splice.
      var value = dom.editor.value;
      dom.editor.value = value.slice(0, start) + text + value.slice(end);
    }
    if (selStart != null) dom.editor.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
    dom.editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function selection() {
    return { start: dom.editor.selectionStart, end: dom.editor.selectionEnd, value: dom.editor.value };
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
    var next = bounds.text.split('\n').map(transform).join('\n');
    applyEdit(bounds.start, bounds.end, next, bounds.start + next.length);
  }

  function togglePrefix(prefix) {
    var bounds = lineBounds();
    var pattern = new RegExp('^\\s*' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    var allPrefixed = bounds.text.split('\n').every(function (line) {
      return !line.trim() || pattern.test(line);
    });
    mapLines(function (line) {
      if (!line.trim()) return line;
      return allPrefixed ? line.replace(pattern, '') : prefix + line;
    });
  }

  var COMMANDS = {
    bold: function () { wrap('**', 'bold'); },
    italic: function () { wrap('*', 'italic'); },
    code: function () { wrap('`', 'code'); },
    heading: function () {
      mapLines(function (line) {
        var match = line.match(/^(#{1,6})\s+/);
        if (!match) return '# ' + line;
        if (match[1].length >= 3) return line.replace(/^#{1,6}\s+/, '');
        return '#' + line;
      });
    },
    link: function () {
      var sel = selection();
      var chosen = sel.value.slice(sel.start, sel.end);
      if (/^https?:\/\/\S+$/i.test(chosen)) {
        applyEdit(sel.start, sel.end, '[](' + chosen + ')', sel.start + 1, sel.start + 1);
        return;
      }
      var label = chosen || 'link text';
      applyEdit(sel.start, sel.end, '[' + label + '](url)',
        sel.start + label.length + 3, sel.start + label.length + 6);
    },
    ul: function () { togglePrefix('- '); },
    task: function () { togglePrefix('- [ ] '); },
    quote: function () { togglePrefix('> '); },
    codeblock: function () {
      var sel = selection();
      var chosen = sel.value.slice(sel.start, sel.end) || 'code';
      var block = '```\n' + chosen + '\n```\n';
      applyEdit(sel.start, sel.end, block, sel.start + 3, sel.start + 3);
    },
    hr: function () {
      var sel = selection();
      applyEdit(sel.start, sel.end, '\n---\n\n', sel.start + 6);
    }
  };

  dom.dataBar.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-data-cmd]');
    if (!button || !current) return;
    var action = button.dataset.dataCmd;

    if (action === 'mode') {
      rich.mode = rich.mode === 'rich' ? 'tree' : 'rich';
      if (!showingPreview) setPreview(true);
      else paintPreview();
      return;
    }

    if (action === 'expand' || action === 'collapse') {
      if (!showingPreview) setPreview(true);
      Structured.expandAll(dom.dataView, action === 'expand');
      return;
    }

    try {
      var next = action === 'minify'
        ? Structured.minifyJson(dom.editor.value)
        : Structured.format(current.kind, dom.editor.value);
      if (next === dom.editor.value) {
        toast('Already tidy');
        return;
      }
      dom.editor.value = next;
      dom.editor.dispatchEvent(new Event('input', { bubbles: true }));
      toast(action === 'minify' ? 'Minified' : 'Formatted');
    } catch (error) {
      toast('Cannot ' + action + ': ' + error.message, true);
    }
  });

  dom.formatBar.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-cmd]');
    if (!button) return;
    event.preventDefault();
    var command = COMMANDS[button.dataset.cmd];
    if (command) command();
  });

  // Keep the format bar from being covered by the on-screen keyboard.
  if (window.visualViewport) {
    var syncViewport = function () {
      var inset = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
      document.documentElement.style.setProperty('--keyboard-inset', inset + 'px');
    };
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
    syncViewport();
  }

  // Continue lists on Enter, the one editing nicety that really matters on a phone.
  var LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/;
  dom.editor.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (current && current.kind !== 'markdown') return;
    var sel = selection();
    if (sel.start !== sel.end) return;
    var lineStart = sel.value.lastIndexOf('\n', Math.max(0, sel.start - 1)) + 1;
    var match = sel.value.slice(lineStart, sel.start).match(LIST_ITEM);
    if (!match) return;

    event.preventDefault();
    if (!match[7].trim()) {
      applyEdit(lineStart, sel.start, '', lineStart, lineStart);
      return;
    }
    var marker = match[2] ? match[2] + match[5] : (Number(match[3]) + 1) + match[4] + match[5];
    applyEdit(sel.start, sel.start, '\n' + match[1] + marker + (match[6] ? '[ ] ' : ''));
  });

  /* ------------------------------------------------------ save on leave */

  function flush() {
    if (current && dom.editor.value !== current.savedText) saveNow();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  window.addEventListener('blur', flush);

  /* ------------------------------------------------- another tab saved */

  function hideConflict() { dom.conflict.hidden = true; }

  if (channel) {
    channel.onmessage = function (event) {
      var message = event.data || {};
      if (message.type === 'library' && !dom.library.hidden) renderLibrary();
      if (message.type !== 'saved') return;
      if (!dom.library.hidden) renderLibrary();
      if (!current || current.id !== message.id) return;

      if (dom.editor.value === current.savedText) {
        // Nothing of ours to lose - just show the newest text.
        Library.read(current.id).then(function (doc) {
          if (!doc || !current) return;
          current.savedText = doc.text;
          current.lastModified = doc.lastModified;
          dom.editor.value = doc.text;
          if (showingPreview) renderPreview();
          setSaveState('saved');
        });
        return;
      }
      dom.conflictText.textContent = 'This document was changed somewhere else.';
      dom.conflict.hidden = false;
    };
  }

  dom.conflictReload.addEventListener('click', function () {
    if (!current) return;
    Library.read(current.id).then(function (doc) {
      if (!doc) return;
      current.savedText = doc.text;
      current.lastModified = doc.lastModified;
      dom.editor.value = doc.text;
      if (showingPreview) renderPreview();
      setSaveState('saved');
      hideConflict();
    });
  });

  dom.conflictKeep.addEventListener('click', function () {
    hideConflict();
    saveNow();
  });

  /* =====================================================================
     Routing
     ===================================================================== */

  function route() {
    var match = location.hash.match(/^#\/d\/([\w-]+)/);
    if (match) {
      dom.library.hidden = true;
      dom.editorScreen.hidden = false;
      if (!current || current.id !== match[1]) openDocument(match[1]);
      return;
    }
    flush();
    current = null;
    dom.editorScreen.hidden = true;
    dom.library.hidden = false;
    renderLibrary();
  }

  window.addEventListener('hashchange', route);

  /* =====================================================================
     Install hint + service worker
     ===================================================================== */

  var installEvent = null;

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installEvent = event;
    showInstallHint('Install Markdown Wizard', 'Add it to your home screen so it opens like an app.', function () {
      installEvent.prompt();
      installEvent = null;
    });
  });

  function showInstallHint(title, text, onClick) {
    if (document.getElementById('install-hint')) return;
    var hint = document.createElement('button');
    hint.id = 'install-hint';
    hint.type = 'button';
    hint.className = 'install-hint';
    var strong = document.createElement('strong');
    strong.textContent = title;
    var span = document.createElement('span');
    span.textContent = text;
    hint.appendChild(strong);
    hint.appendChild(span);
    hint.addEventListener('click', function () {
      hint.remove();
      try { localStorage.setItem('install-hint-dismissed', '1'); } catch (error) { /* private mode */ }
      if (onClick) onClick();
    });
    dom.library.insertBefore(hint, dom.list);
  }

  function maybeIosHint() {
    var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    var dismissed = false;
    try { dismissed = localStorage.getItem('install-hint-dismissed') === '1'; } catch (error) { /* private mode */ }
    if (isIos && !standalone && !dismissed) {
      showInstallHint('Add to Home Screen', 'Share → Add to Home Screen keeps your documents one tap away.', null);
    }
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
    });
  }

  /* =====================================================================
     Start
     ===================================================================== */

  function start() {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      dom.libraryEmpty.hidden = false;
      dom.libraryEmpty.textContent =
        'This browser cannot store documents locally (it lacks the Origin Private File System). ' +
        'Try a current Chrome, Edge, Safari or Firefox.';
      return;
    }
    // Ask the browser not to evict the library under storage pressure.
    if (navigator.storage.persist) navigator.storage.persist().catch(function () {});
    migrateLegacyLibrary().then(function () {
      route();
      maybeIosHint();
    });
  }

  window.MarkdownWizardMobile = { Library: Library, saveNow: saveNow, route: route };

  start();
})();
