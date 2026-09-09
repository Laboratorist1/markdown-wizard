/*
 * records.js - a table-shaped view for JSON that is really a list of records.
 *
 * A tree is the right shape for arbitrary JSON and the wrong one for
 * {"books": [ …29 objects, 11 fields each… ]}: "0: { 11 keys }" repeated
 * twenty-nine times tells you nothing. Such a collection is a table, so this
 * shows it as one - a row per record, the telling fields up front - with a
 * filter, a sort, and editing.
 *
 * Edits are applied to the parsed value and the document is re-serialised from
 * it, so a document cannot be left invalid by editing: the only text ever
 * written is the output of JSON.stringify.
 *
 * Exposes a single global: Records
 */
(function (root) {
  'use strict';

  var MIN_ITEMS = 2;
  // In preference order: a row leads with the field a person would read.
  var HEADLINE = ['title', 'name', 'label', 'heading', 'subject', 'summary', 'slug', 'key', 'id'];
  var SECONDARY_LIMIT = 3;
  // Identifiers say nothing about a record at a glance.
  var IDENTIFIER = /^(_?id|_?key|uuid|guid|slug|href|url)$/i;

  /* -------------------------------------------------------------- finding */

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /** An array is a record collection when it holds objects that mostly agree
      about their fields - the shape a table can show. */
  function describeCollection(items) {
    var records = items.filter(isRecord);
    if (records.length < MIN_ITEMS || records.length < items.length * 0.6) return null;

    var counts = {};
    records.forEach(function (item) {
      Object.keys(item).forEach(function (key) {
        counts[key] = (counts[key] || 0) + 1;
      });
    });

    var fields = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    if (!fields.length) return null;

    // Objects that share nothing are not rows of one table, so require a field
    // that more than half of them carry - "half" itself is what two unrelated
    // objects produce.
    var shared = fields.filter(function (key) { return counts[key] > records.length * 0.5; });
    if (!shared.length) return null;

    return { fields: fields, counts: counts, records: records };
  }

  /** Every collection in the document, biggest first, each with the path it
      was found at. */
  function find(value, path, out, depth) {
    var found = out || [];
    var here = path || [];
    if (depth > 6 || found.length > 40) return found;

    if (Array.isArray(value)) {
      var described = describeCollection(value);
      if (described) {
        found.push({
          path: here,
          label: here.length ? here.join('.') : 'root',
          items: value,
          fields: described.fields,
          counts: described.counts,
          count: described.records.length
        });
      }
      value.slice(0, 40).forEach(function (item, index) {
        find(item, here.concat(String(index)), found, (depth || 0) + 1);
      });
      return found;
    }

    if (isRecord(value)) {
      Object.keys(value).forEach(function (key) {
        find(value[key], here.concat(key), found, (depth || 0) + 1);
      });
    }
    return found;
  }

  function collections(value) {
    return find(value, [], [], 0).sort(function (a, b) { return b.count - a.count; });
  }

  /* ------------------------------------------------------------ formatting */

  function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  /** A cell's worth of a value: scalars as themselves, containers as a size. */
  function preview(value) {
    var kind = typeOf(value);
    if (kind === 'string') return value;
    if (kind === 'number' || kind === 'boolean') return String(value);
    if (kind === 'null') return 'null';
    if (kind === 'array') return value.length + (value.length === 1 ? ' item' : ' items');
    var keys = Object.keys(value).length;
    return keys + (keys === 1 ? ' field' : ' fields');
  }

  function searchText(value) {
    var kind = typeOf(value);
    if (kind === 'string') return value;
    if (kind === 'number' || kind === 'boolean' || kind === 'null') return String(value);
    try {
      return JSON.stringify(value);
    } catch (error) {
      return '';
    }
  }

  /** The field to lead a row with: an obvious name if there is one, otherwise
      the first field most records carry a short string in. */
  function headlineField(fields, records) {
    var lower = {};
    fields.forEach(function (key) { lower[key.toLowerCase()] = key; });
    for (var i = 0; i < HEADLINE.length; i++) {
      if (lower[HEADLINE[i]]) return lower[HEADLINE[i]];
    }

    var scored = fields.filter(function (key) {
      var strings = 0;
      records.forEach(function (item) {
        if (typeof item[key] === 'string' && item[key].length < 80) strings += 1;
      });
      return strings >= records.length * 0.6;
    });
    return scored[0] || fields[0];
  }

  /** The two or three fields worth showing under a row's title: real
      attributes, not identifiers, and things that fit on a line. */
  function summaryFields(fields, records, headline) {
    var candidates = fields.filter(function (key) {
      return key !== headline && !IDENTIFIER.test(key);
    });

    var scalar = candidates.filter(function (key) {
      var hits = 0;
      records.forEach(function (item) {
        var kind = typeOf(item[key]);
        if (kind === 'string' || kind === 'number' || kind === 'boolean') hits += 1;
      });
      return hits >= records.length * 0.5;
    });

    var chosen = (scalar.length ? scalar : candidates).slice(0, SECONDARY_LIMIT);
    if (chosen.length) return chosen;
    return fields.filter(function (key) { return key !== headline; }).slice(0, SECONDARY_LIMIT);
  }

  function compare(a, b) {
    var left = typeOf(a);
    var right = typeOf(b);
    if (left === 'null' || a === undefined) return right === 'null' || b === undefined ? 0 : 1;
    if (right === 'null' || b === undefined) return -1;
    if (left === 'number' && right === 'number') return a - b;
    if (left === 'boolean' && right === 'boolean') return (a === b) ? 0 : (a ? -1 : 1);
    return String(searchText(a)).localeCompare(String(searchText(b)), undefined, { numeric: true });
  }

  /** Matches the indentation the document already uses, so editing one value
      does not reformat every line. */
  function indentOf(text) {
    var match = /\n([ \t]+)\S/.exec(String(text || ''));
    if (!match) return 2;
    if (match[1].charAt(0) === '\t') return '\t';
    return match[1].length;
  }

  function serialise(value, text) {
    return JSON.stringify(value, null, indentOf(text)) + '\n';
  }

  /* ----------------------------------------------------------------- view */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * options:
   *   collection  the chosen collection, from collections()
   *   onEdit(record, field)  optional; resolves with { value } or null.
   *                          Absent means the view is read-only.
   *   onChange()  called after the value has been changed, to save.
   *   onDelete(record)  optional; resolves true to remove the record.
   */
  function create(options) {
    var collection = options.collection;
    var fields = collection.fields;
    var records = collection.items.filter(isRecord);
    var headline = headlineField(fields, records);
    var secondary = summaryFields(fields, records, headline);

    var state = { query: '', field: '', sort: '', descending: false, open: null };

    var wrap = el('div', 'rc');

    /* ------------------------------------------------------------ controls */

    var controls = el('div', 'rc-controls');

    var search = el('input', 'rc-search');
    search.type = 'search';
    search.placeholder = 'Filter records';
    search.setAttribute('aria-label', 'Filter records');
    controls.appendChild(search);

    var fieldPicker = el('select', 'rc-select');
    fieldPicker.setAttribute('aria-label', 'Field to filter');
    fieldPicker.appendChild(new Option('All fields', ''));
    fields.forEach(function (key) { fieldPicker.appendChild(new Option(key, key)); });
    controls.appendChild(fieldPicker);

    var sortPicker = el('select', 'rc-select');
    sortPicker.setAttribute('aria-label', 'Sort by');
    sortPicker.appendChild(new Option('In order', ''));
    fields.forEach(function (key) { sortPicker.appendChild(new Option('By ' + key, key)); });
    controls.appendChild(sortPicker);

    var direction = el('button', 'rc-direction', 'A→Z');
    direction.type = 'button';
    direction.title = 'Reverse the order';
    controls.appendChild(direction);

    wrap.appendChild(controls);

    var count = el('p', 'rc-count');
    wrap.appendChild(count);

    var list = el('div', 'rc-list');
    wrap.appendChild(list);

    /* -------------------------------------------------------------- detail */

    var detail = el('div', 'rc-detail');
    detail.hidden = true;
    wrap.appendChild(detail);

    function visible() {
      var query = state.query.trim().toLowerCase();
      var rows = records.filter(function (item) {
        if (!query) return true;
        var keys = state.field ? [state.field] : fields;
        return keys.some(function (key) {
          return searchText(item[key]).toLowerCase().indexOf(query) !== -1;
        });
      });

      if (state.sort) {
        rows = rows.slice().sort(function (a, b) { return compare(a[state.sort], b[state.sort]); });
        if (state.descending) rows.reverse();
      } else if (state.descending) {
        rows = rows.slice().reverse();
      }
      return rows;
    }

    function paint() {
      var rows = visible();
      count.textContent = rows.length === records.length
        ? records.length + ' records · ' + fields.length + ' fields'
        : rows.length + ' of ' + records.length + ' records';

      list.textContent = '';
      if (!rows.length) {
        list.appendChild(el('p', 'rc-empty', 'Nothing matches.'));
        return;
      }

      rows.forEach(function (item) {
        var card = el('button', 'rc-card');
        card.type = 'button';
        card.appendChild(el('span', 'rc-card-title', preview(item[headline])));

        var line = el('span', 'rc-card-meta');
        secondary.forEach(function (key, index) {
          if (item[key] === undefined) return;
          if (line.childNodes.length) line.appendChild(el('span', 'rc-dot', '·'));
          line.appendChild(el('span', 'rc-card-field', key + ': '));
          line.appendChild(el('span', 'rc-card-value', preview(item[key])));
        });
        if (line.childNodes.length) card.appendChild(line);

        card.addEventListener('click', function () { openRecord(item); });
        list.appendChild(card);
      });
    }

    function openRecord(item) {
      state.open = item;
      detail.textContent = '';
      detail.hidden = false;
      list.hidden = true;
      controls.hidden = true;
      count.hidden = true;

      var bar = el('div', 'rc-bar');
      var back = el('button', 'rc-back', 'All records');
      back.type = 'button';
      back.addEventListener('click', closeRecord);
      bar.appendChild(back);

      var position = records.indexOf(item);
      bar.appendChild(el('span', 'rc-where', 'record ' + (position + 1) + ' of ' + records.length));
      detail.appendChild(bar);

      detail.appendChild(el('h2', 'rc-detail-title', preview(item[headline])));

      var table = el('div', 'rc-fields');
      fields.forEach(function (key) {
        var row = el(options.onEdit ? 'button' : 'div', 'rc-field');
        if (options.onEdit) row.type = 'button';
        row.appendChild(el('span', 'rc-field-name', key));

        var value = item[key];
        var valueNode = el('span', 'rc-field-value rc-type-' + typeOf(value),
          value === undefined ? '(not set)' : preview(value));
        row.appendChild(valueNode);

        if (options.onEdit) {
          row.addEventListener('click', function () {
            options.onEdit(item, key, value).then(function (result) {
              if (!result) return;
              item[key] = result.value;
              if (options.onChange) options.onChange();
              openRecord(item);
            });
          });
        }
        table.appendChild(row);
      });
      detail.appendChild(table);

      if (options.onDelete) {
        var remove = el('button', 'rc-delete', 'Delete this record');
        remove.type = 'button';
        remove.addEventListener('click', function () {
          options.onDelete(item).then(function (confirmed) {
            if (!confirmed) return;
            var at = collection.items.indexOf(item);
            if (at !== -1) collection.items.splice(at, 1);
            records = collection.items.filter(isRecord);
            if (options.onChange) options.onChange();
            closeRecord();
          });
        });
        detail.appendChild(remove);
      }
    }

    function closeRecord() {
      state.open = null;
      detail.hidden = true;
      list.hidden = false;
      controls.hidden = false;
      count.hidden = false;
      paint();
    }

    search.addEventListener('input', function () {
      state.query = search.value;
      paint();
    });
    fieldPicker.addEventListener('change', function () {
      state.field = fieldPicker.value;
      paint();
    });
    sortPicker.addEventListener('change', function () {
      state.sort = sortPicker.value;
      paint();
    });
    direction.addEventListener('click', function () {
      state.descending = !state.descending;
      direction.textContent = state.descending ? 'Z→A' : 'A→Z';
      paint();
    });

    paint();

    return {
      node: wrap,
      refresh: paint,
      showList: closeRecord,
      fields: fields,
      headline: headline
    };
  }

  root.Records = {
    collections: collections,
    create: create,
    serialise: serialise,
    indentOf: indentOf,
    typeOf: typeOf,
    preview: preview
  };
})(typeof self !== 'undefined' ? self : this);
