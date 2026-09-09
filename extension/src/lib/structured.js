/*
 * structured.js - viewers for JSON and XML, alongside the Markdown renderer.
 *
 * These build real DOM nodes rather than HTML strings: collapsing is native
 * <details>, and no document content is ever parsed as HTML, so a hostile file
 * cannot inject anything. XML is parsed with DOMParser in XML mode, which does
 * not execute scripts or resolve entities to remote content.
 *
 * Exposes a single global: Structured
 */
(function (root) {
  'use strict';

  var JSON_EXT = /\.(json|jsonc|geojson|jsonl|map|webmanifest)$/i;
  var XML_EXT = /\.(xml|svg|xsd|xsl|xslt|rss|atom|plist|pom|kml|gpx)$/i;
  var MD_EXT = /\.(md|markdown|mdown|mkd|mdx)$/i;

  var MAX_NODES = 20000;

  /* ------------------------------------------------------------- detection */

  /** Extension wins; content sniffing only decides when there is no useful
      extension (an imported file may have lost it, or have none). */
  function detect(name, text) {
    var fileName = name || '';
    if (JSON_EXT.test(fileName)) return 'json';
    if (XML_EXT.test(fileName)) return 'xml';
    if (MD_EXT.test(fileName)) return 'markdown';

    var head = String(text == null ? '' : text).slice(0, 4096).trim();
    if (!head) return 'markdown';
    if (head[0] === '{' || head[0] === '[') {
      try {
        JSON.parse(String(text).trim());
        return 'json';
      } catch (error) { /* not JSON after all */ }
    }
    if (/^<\?xml[\s?]/.test(head) || /^<!DOCTYPE\s/i.test(head) || /^<[a-zA-Z][\w:.-]*[\s>/]/.test(head)) {
      return 'xml';
    }
    return 'markdown';
  }

  function extensionFor(kind) {
    if (kind === 'json') return '.json';
    if (kind === 'xml') return '.xml';
    return '.md';
  }

  function mimeFor(kind) {
    if (kind === 'json') return 'application/json';
    if (kind === 'xml') return 'application/xml';
    return 'text/markdown';
  }

  function label(kind) {
    if (kind === 'json') return 'JSON';
    if (kind === 'xml') return 'XML';
    return 'Markdown';
  }

  /* ------------------------------------------------------- DOM conveniences */

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function punctuation(text) { return element('span', 'st-punct', text); }

  function errorNode(message, detail) {
    var box = element('div', 'st-error');
    box.appendChild(element('strong', null, message));
    if (detail) box.appendChild(element('pre', 'st-error-detail', detail));
    return box;
  }

  /** Finds the first character JSON cannot accept.

      V8's own message is no help here: it carries a position for some errors
      and quotes the document back for others, and probing with prefixes is
      unsound because a truncated document produces errors of its own. So this
      scans the grammar directly and returns an offset, or null when the text
      is valid JSON. */
  function scanJson(text) {
    var length = text.length;
    var at = 0;

    function fail(index) {
      throw { at: index === undefined ? at : index };
    }

    function whitespace() {
      while (at < length) {
        var c = text.charAt(at);
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') at += 1;
        else break;
      }
    }

    function digits() {
      var seen = 0;
      while (at < length && text.charAt(at) >= '0' && text.charAt(at) <= '9') {
        at += 1;
        seen += 1;
      }
      return seen;
    }

    function string() {
      at += 1; // opening quote
      while (at < length) {
        var c = text.charAt(at);
        if (c === '"') { at += 1; return; }
        if (c === '\\') {
          at += 1;
          var escape = text.charAt(at);
          if ('"\\/bfnrt'.indexOf(escape) !== -1 && escape !== '') { at += 1; continue; }
          if (escape === 'u') {
            for (var k = 1; k <= 4; k++) {
              if (!/[0-9a-fA-F]/.test(text.charAt(at + k))) fail(at + k);
            }
            at += 5;
            continue;
          }
          fail(at);
        }
        if (c < ' ') fail(at); // a raw control character is not allowed
        at += 1;
      }
      fail(length); // unterminated
    }

    function number() {
      if (text.charAt(at) === '-') at += 1;
      if (text.charAt(at) === '0') at += 1;
      else if (!digits()) fail();
      if (text.charAt(at) === '.') {
        at += 1;
        if (!digits()) fail();
      }
      if (text.charAt(at) === 'e' || text.charAt(at) === 'E') {
        at += 1;
        if (text.charAt(at) === '+' || text.charAt(at) === '-') at += 1;
        if (!digits()) fail();
      }
    }

    function literal(word) {
      if (text.substr(at, word.length) !== word) fail();
      at += word.length;
    }

    function collection(closer, readEntry) {
      at += 1; // opening bracket
      whitespace();
      if (text.charAt(at) === closer) { at += 1; return; }
      for (;;) {
        readEntry();
        whitespace();
        var c = text.charAt(at);
        if (c === ',') { at += 1; whitespace(); continue; }
        if (c === closer) { at += 1; return; }
        fail();
      }
    }

    function value(depth) {
      if (depth > 500) fail();
      whitespace();
      if (at >= length) fail(length);
      var c = text.charAt(at);

      if (c === '{') {
        collection('}', function () {
          whitespace();
          if (text.charAt(at) !== '"') fail();
          string();
          whitespace();
          if (text.charAt(at) !== ':') fail();
          at += 1;
          value(depth + 1);
        });
        return;
      }
      if (c === '[') {
        collection(']', function () { value(depth + 1); });
        return;
      }
      if (c === '"') { string(); return; }
      if (c === '-' || (c >= '0' && c <= '9')) { number(); return; }
      if (c === 't') { literal('true'); return; }
      if (c === 'f') { literal('false'); return; }
      if (c === 'n') { literal('null'); return; }
      fail();
    }

    try {
      value(0);
      whitespace();
      if (at < length) return at; // trailing rubbish after a complete document
      return null;
    } catch (error) {
      return typeof error.at === 'number' ? Math.min(error.at, length) : null;
    }
  }

  function positionOf(text) {
    var index = scanJson(text);
    if (index === null) return null;
    var before = text.slice(0, index);
    var line = before.split('\n').length;
    var column = index - (before.lastIndexOf('\n') + 1) + 1;
    return { line: line, column: column, index: index };
  }

  /* ------------------------------------------------------------------ JSON */

  function renderJson(text) {
    var value;
    try {
      value = JSON.parse(text);
    } catch (error) {
      var where = positionOf(text);
      var headline = where
        ? 'Invalid JSON at line ' + where.line + ', column ' + where.column
        : 'Invalid JSON';
      return {
        node: errorNode(headline, error.message),
        error: headline,
        summary: 'invalid JSON'
      };
    }

    var counter = { nodes: 0, truncated: false };
    var tree = element('div', 'st-tree st-json');
    tree.appendChild(jsonValue(value, 0, counter));

    return {
      node: tree,
      error: null,
      summary: 'valid JSON · ' + counter.nodes.toLocaleString() +
        (counter.nodes === 1 ? ' value' : ' values') +
        (counter.truncated ? ' (truncated)' : '')
    };
  }

  function jsonValue(value, depth, counter) {
    counter.nodes += 1;
    if (counter.nodes > MAX_NODES) {
      counter.truncated = true;
      return element('span', 'st-muted', '…');
    }

    if (value === null) return element('span', 'st-null', 'null');
    var type = typeof value;
    if (type === 'string') return element('span', 'st-string', JSON.stringify(value));
    if (type === 'number') return element('span', 'st-number', String(value));
    if (type === 'boolean') return element('span', 'st-boolean', String(value));

    var isArray = Array.isArray(value);
    var keys = isArray ? null : Object.keys(value);
    var length = isArray ? value.length : keys.length;

    if (!length) return element('span', 'st-punct', isArray ? '[ ]' : '{ }');

    var details = element('details', 'st-node');
    details.open = depth < 2;

    var summary = element('summary', 'st-summary');
    summary.appendChild(punctuation(isArray ? '[' : '{'));
    summary.appendChild(element('span', 'st-count',
      length + (isArray ? (length === 1 ? ' item' : ' items') : (length === 1 ? ' key' : ' keys'))));
    summary.appendChild(punctuation(isArray ? ']' : '}'));
    details.appendChild(summary);

    var children = element('div', 'st-children');
    for (var i = 0; i < length; i++) {
      var key = isArray ? i : keys[i];
      var row = element('div', 'st-row');
      row.appendChild(element('span', isArray ? 'st-index' : 'st-key',
        isArray ? String(key) : JSON.stringify(key)));
      row.appendChild(punctuation(': '));
      row.appendChild(jsonValue(isArray ? value[i] : value[key], depth + 1, counter));
      children.appendChild(row);
      if (counter.truncated) break;
    }
    details.appendChild(children);
    return details;
  }

  /* ------------------------------------------------------------------- XML */

  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    var failure = doc.getElementsByTagName('parsererror')[0];
    if (failure) return { doc: null, error: (failure.textContent || 'Invalid XML').trim() };
    if (!doc.documentElement) return { doc: null, error: 'Invalid XML: no root element' };
    return { doc: doc, error: null };
  }

  function renderXml(text) {
    var parsed = parseXml(text);
    if (parsed.error) {
      return {
        node: errorNode('Invalid XML', parsed.error),
        error: 'Invalid XML',
        summary: 'invalid XML'
      };
    }

    var counter = { nodes: 0, truncated: false };
    var tree = element('div', 'st-tree st-xml');
    tree.appendChild(xmlNode(parsed.doc.documentElement, 0, counter));

    return {
      node: tree,
      error: null,
      summary: 'well-formed XML · ' + counter.nodes.toLocaleString() +
        (counter.nodes === 1 ? ' element' : ' elements') +
        (counter.truncated ? ' (truncated)' : '')
    };
  }

  /** Child nodes that are worth showing: elements, comments, and text that is
      not just the whitespace between tags. */
  function meaningfulChildren(node) {
    var kept = [];
    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (child.nodeType === 1 || child.nodeType === 8) kept.push(child);
      else if ((child.nodeType === 3 || child.nodeType === 4) && child.nodeValue.trim()) kept.push(child);
    }
    return kept;
  }

  /** mode: 'open' for <tag attrs>, 'close' for </tag>, 'self' for <tag attrs/>. */
  function tagPieces(el, target, mode) {
    target.appendChild(punctuation(mode === 'close' ? '</' : '<'));
    target.appendChild(element('span', 'st-tag', el.nodeName));
    if (mode !== 'close') {
      for (var i = 0; i < el.attributes.length; i++) {
        var attribute = el.attributes[i];
        target.appendChild(document.createTextNode(' '));
        target.appendChild(element('span', 'st-attr', attribute.name));
        target.appendChild(punctuation('='));
        target.appendChild(element('span', 'st-string', '"' + attribute.value + '"'));
      }
    }
    target.appendChild(punctuation(mode === 'self' ? '/>' : '>'));
  }

  function xmlNode(node, depth, counter) {
    if (node.nodeType === 8) {
      return element('div', 'st-comment', '<!--' + node.nodeValue + '-->');
    }
    if (node.nodeType === 3 || node.nodeType === 4) {
      return element('span', 'st-text', node.nodeValue.trim());
    }

    counter.nodes += 1;
    if (counter.nodes > MAX_NODES) {
      counter.truncated = true;
      return element('span', 'st-muted', '…');
    }

    var children = meaningfulChildren(node);

    // An empty element, or one holding a single piece of text, reads better on
    // one line than as something to expand.
    if (!children.length) {
      var empty = element('div', 'st-leaf');
      tagPieces(node, empty, 'self');
      return empty;
    }
    if (children.length === 1 && children[0].nodeType !== 1 && children[0].nodeType !== 8) {
      var single = element('div', 'st-leaf');
      tagPieces(node, single, 'open');
      single.appendChild(element('span', 'st-text', children[0].nodeValue.trim()));
      tagPieces(node, single, 'close');
      return single;
    }

    var details = element('details', 'st-node');
    details.open = depth < 2;

    var summary = element('summary', 'st-summary');
    tagPieces(node, summary, 'open');
    var elementCount = 0;
    children.forEach(function (child) { if (child.nodeType === 1) elementCount += 1; });
    if (elementCount) {
      summary.appendChild(element('span', 'st-count',
        elementCount + (elementCount === 1 ? ' child' : ' children')));
    }
    details.appendChild(summary);

    var box = element('div', 'st-children');
    for (var i = 0; i < children.length; i++) {
      box.appendChild(xmlNode(children[i], depth + 1, counter));
      if (counter.truncated) break;
    }
    details.appendChild(box);
    return details;
  }

  /* ------------------------------------------------------------ formatting */

  function formatJson(text, indent) {
    return JSON.stringify(JSON.parse(text), null, indent == null ? 2 : indent);
  }

  function minifyJson(text) {
    return JSON.stringify(JSON.parse(text));
  }

  function escapeXmlText(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeXmlAttribute(value) {
    return escapeXmlText(value).replace(/"/g, '&quot;');
  }

  function formatXml(text, indent) {
    var parsed = parseXml(text);
    if (parsed.error) throw new Error(parsed.error);
    var pad = new Array((indent == null ? 2 : indent) + 1).join(' ');
    var prolog = /^\s*(<\?xml[^?]*\?>)/.exec(text);
    var lines = serializeXml(parsed.doc.documentElement, 0, pad);
    return (prolog ? prolog[1] + '\n' : '') + lines + '\n';
  }

  function serializeXml(node, depth, pad) {
    var margin = new Array(depth + 1).join(pad);

    if (node.nodeType === 8) return margin + '<!--' + node.nodeValue + '-->';
    if (node.nodeType === 3 || node.nodeType === 4) return margin + escapeXmlText(node.nodeValue.trim());

    var open = '<' + node.nodeName;
    for (var i = 0; i < node.attributes.length; i++) {
      open += ' ' + node.attributes[i].name + '="' + escapeXmlAttribute(node.attributes[i].value) + '"';
    }

    var children = meaningfulChildren(node);
    if (!children.length) return margin + open + '/>';

    if (children.length === 1 && children[0].nodeType !== 1 && children[0].nodeType !== 8) {
      return margin + open + '>' + escapeXmlText(children[0].nodeValue.trim()) + '</' + node.nodeName + '>';
    }

    var parts = [margin + open + '>'];
    for (var c = 0; c < children.length; c++) {
      parts.push(serializeXml(children[c], depth + 1, pad));
    }
    parts.push(margin + '</' + node.nodeName + '>');
    return parts.join('\n');
  }

  function format(kind, text, indent) {
    if (kind === 'json') return formatJson(text, indent);
    if (kind === 'xml') return formatXml(text, indent);
    return text;
  }

  /* ------------------------------------------------------------------- API */

  function render(kind, text) {
    if (kind === 'json') return renderJson(text);
    if (kind === 'xml') return renderXml(text);
    return null;
  }

  function expandAll(container, open) {
    var nodes = container.querySelectorAll('details.st-node');
    for (var i = 0; i < nodes.length; i++) nodes[i].open = !!open;
  }

  root.Structured = {
    detect: detect,
    render: render,
    format: format,
    minifyJson: minifyJson,
    expandAll: expandAll,
    extensionFor: extensionFor,
    mimeFor: mimeFor,
    label: label,
    JSON_EXT: JSON_EXT,
    XML_EXT: XML_EXT
  };
})(typeof self !== 'undefined' ? self : this);
