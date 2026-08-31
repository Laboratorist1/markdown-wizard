/*
 * store.js - persistence for the editor.
 *
 * File System Access handles survive a browser restart only if they are kept in
 * IndexedDB (they are structured-cloneable but not JSON-serialisable), so
 * recents and the workspace live there. Plain preferences live in
 * chrome.storage.local.
 */
(function (root) {
  'use strict';

  var DB_NAME = 'markdown-wizard';
  var DB_VERSION = 1;
  var STORE = 'handles';
  var MAX_RECENT = 12;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('at', 'at');
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
        var result = run(transaction.objectStore(STORE));
        transaction.oncomplete = function () { db.close(); resolve(result && result.result); };
        transaction.onerror = function () { db.close(); reject(transaction.error); };
      });
    });
  }

  function all() {
    return tx('readonly', function (store) { return store.getAll(); })
      .then(function (records) {
        return (records || []).sort(function (a, b) { return b.at - a.at; });
      });
  }

  /** Records are keyed by kind+name; same-name entries are disambiguated by
      isSameEntry so reopening a file updates its entry instead of duplicating it. */
  function remember(record) {
    return all().then(function (records) {
      var candidates = records.filter(function (item) {
        return item.kind === record.kind && item.name === record.name;
      });
      return Promise.all(candidates.map(function (item) {
        return item.handle.isSameEntry(record.handle)
          .then(function (same) { return same ? item.key : null; })
          .catch(function () { return null; });
      })).then(function (matches) {
        var existing = matches.filter(Boolean)[0];
        var entry = {
          key: existing || (record.kind + ':' + record.name + ':' + Date.now()),
          kind: record.kind,
          name: record.name,
          path: record.path || record.name,
          handle: record.handle,
          at: Date.now()
        };
        return tx('readwrite', function (store) {
          store.put(entry);
          if (!existing) {
            // Trim history so the recents list cannot grow without bound.
            var stale = records
              .filter(function (item) { return item.kind === record.kind; })
              .slice(MAX_RECENT - 1);
            stale.forEach(function (item) { store.delete(item.key); });
          }
          return { result: entry };
        });
      });
    });
  }

  function forget(key) {
    return tx('readwrite', function (store) { store.delete(key); });
  }

  function recent(kind) {
    return all().then(function (records) {
      return records.filter(function (item) { return item.kind === kind; });
    });
  }

  var DEFAULT_PREFS = {
    view: 'split',
    theme: 'system',
    autosave: false,
    wrapColumn: false,
    lastWorkspaceKey: null,
    lastFileKey: null
  };

  function getPrefs() {
    return chrome.storage.local.get('prefs').then(function (data) {
      return Object.assign({}, DEFAULT_PREFS, data.prefs || {});
    });
  }

  function setPrefs(partial) {
    return getPrefs().then(function (prefs) {
      var next = Object.assign({}, prefs, partial);
      return chrome.storage.local.set({ prefs: next }).then(function () { return next; });
    });
  }

  root.Store = {
    remember: remember,
    forget: forget,
    recent: recent,
    all: all,
    getPrefs: getPrefs,
    setPrefs: setPrefs,
    DEFAULT_PREFS: DEFAULT_PREFS
  };
})(typeof self !== 'undefined' ? self : this);
