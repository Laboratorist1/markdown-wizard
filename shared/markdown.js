/*
 * markdown.js - a self-contained GitHub-flavoured Markdown renderer.
 *
 * Bundled on purpose: Manifest V3 forbids remote code, so no CDN parser.
 * Raw HTML in the source is escaped rather than passed through, which keeps
 * rendering of untrusted files XSS-free without a sanitizer dependency.
 *
 * Exposes a single global: MD.render(src) -> { html, headings }
 */
(function (root) {
  'use strict';

  var SENTINEL = String.fromCharCode(0);
  var SAFE_SCHEME = /^(https?:|mailto:|tel:|ftp:|#|\/|\.\/|\.\.\/|[^a-z0-9+.-]|$)/i;

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function safeUrl(url) {
    var trimmed = (url || '').trim();
    if (/^data:image\/(png|jpe?g|gif|webp);/i.test(trimmed)) return trimmed;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !SAFE_SCHEME.test(trimmed)) return '';
    return trimmed;
  }

  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'section';
  }

  /* ---------------------------------------------------------------- inline */

  function Inline() {
    this.codes = [];
  }

  Inline.prototype.render = function (text) {
    var self = this;
    this.codes = [];

    // Code spans are extracted first so nothing else rewrites their contents.
    var out = text.replace(/(`+)([\s\S]*?)\1/g, function (match, ticks, code) {
      var body = code.replace(/^ (.*?) $/, '$1');
      self.codes.push('<code>' + escapeHtml(body) + '</code>');
      return SENTINEL + (self.codes.length - 1) + SENTINEL;
    });

    out = escapeHtml(out);

    // Images before links: ![alt](src "title")
    out = out.replace(/!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
      function (m, alt, src, title) {
        var url = safeUrl(src);
        if (!url) return m;
        return '<img src="' + escapeHtml(url) + '" alt="' + alt + '"' +
          (title ? ' title="' + title + '"' : '') + ' loading="lazy">';
      });

    // Links: [text](href "title")
    out = out.replace(/\[([^\]]*)\]\(\s*([^\s)]*)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
      function (m, label, href, title) {
        var url = safeUrl(href);
        if (!url) return m;
        return '<a href="' + escapeHtml(url) + '"' + (title ? ' title="' + title + '"' : '') +
          ' rel="noopener noreferrer">' + label + '</a>';
      });

    // Autolinks: <https://example.com>
    out = out.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, function (m, href) {
      var url = safeUrl(href);
      if (!url) return m;
      return '<a href="' + escapeHtml(url) + '" rel="noopener noreferrer">' + escapeHtml(href) + '</a>';
    });

    // Bare URLs that are not already part of a markdown link.
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()"]+[^\s<>().,;:!?"])/g,
      function (m, lead, href) {
        return lead + '<a href="' + escapeHtml(href) + '" rel="noopener noreferrer">' + href + '</a>';
      });

    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
    out = out.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^\w_])_([^_\s][^_]*?)_(?![\w_])/g, '$1<em>$2</em>');
    out = out.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');

    // Hard breaks: two trailing spaces, or a trailing backslash.
    out = out.replace(/(?: {2,}|\\)\n/g, '<br>\n');

    // Escaped punctuation: \* \_ \# ...
    out = out.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1');

    return out.replace(new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g'), function (m, index) {
      return self.codes[Number(index)];
    });
  };

  /* ----------------------------------------------------------------- blocks */

  var RE = {
    fence: /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\n]*)$/,
    atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/,
    setext: /^ {0,3}(=+|-{2,})[ \t]*$/,
    hr: /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/,
    quote: /^ {0,3}>[ \t]?(.*)$/,
    bullet: /^( {0,3})([-*+])([ \t]+)(.*)$/,
    ordered: /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/,
    indentCode: /^(?: {4}|\t)(.*)$/,
    tableDelim: /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/,
    blank: /^[ \t]*$/
  };

  function Parser() {
    this.inline = new Inline();
    this.headings = [];
    this.slugs = Object.create(null);
  }

  Parser.prototype.uniqueSlug = function (text) {
    var base = slugify(text);
    var slug = base;
    var n = 1;
    while (this.slugs[slug]) slug = base + '-' + (++n);
    this.slugs[slug] = true;
    return slug;
  };

  Parser.prototype.heading = function (level, text) {
    var rendered = this.inline.render(text);
    var slug = this.uniqueSlug(text);
    this.headings.push({ level: level, text: text.replace(/[*_`~]/g, '').trim(), id: slug });
    return '<h' + level + ' id="' + slug + '">' + rendered + '</h' + level + '>';
  };

  Parser.prototype.parse = function (lines) {
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (RE.blank.test(line)) { i++; continue; }

      var fence = line.match(RE.fence);
      if (fence) {
        var marker = fence[1][0];
        var lang = (fence[2] || '').trim().split(/\s+/)[0];
        var closer = new RegExp('^ {0,3}\\' + marker + '{' + fence[1].length + ',}[ \\t]*$');
        var body = [];
        i++;
        while (i < lines.length && !closer.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // closing fence (or EOF)
        out.push('<pre class="md-code"' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '') +
          '><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
        continue;
      }

      var atx = line.match(RE.atx);
      if (atx) {
        out.push(this.heading(atx[1].length, (atx[2] || '').trim()));
        i++;
        continue;
      }

      if (RE.hr.test(line)) { out.push('<hr>'); i++; continue; }

      if (RE.quote.test(line)) {
        var quoted = [];
        while (i < lines.length && !RE.blank.test(lines[i])) {
          var q = lines[i].match(RE.quote);
          if (q) quoted.push(q[1]);
          else if (quoted.length) quoted.push(lines[i]); // lazy continuation
          else break;
          i++;
        }
        out.push('<blockquote>' + this.parse(quoted) + '</blockquote>');
        continue;
      }

      if (this.isListStart(line)) {
        var list = this.readList(lines, i);
        out.push(list.html);
        i = list.next;
        continue;
      }

      if (line.indexOf('|') !== -1 && i + 1 < lines.length && RE.tableDelim.test(lines[i + 1])) {
        var table = this.readTable(lines, i);
        if (table) { out.push(table.html); i = table.next; continue; }
      }

      if (RE.indentCode.test(line)) {
        var code = [];
        while (i < lines.length && (RE.indentCode.test(lines[i]) || RE.blank.test(lines[i]))) {
          if (RE.blank.test(lines[i]) && !RE.indentCode.test(lines[i + 1] || '')) break;
          code.push((lines[i].match(RE.indentCode) || [null, ''])[1]);
          i++;
        }
        out.push('<pre class="md-code"><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        continue;
      }

      // Paragraph: run until a blank line or the start of another block.
      var para = [];
      while (i < lines.length && !RE.blank.test(lines[i])) {
        var next = lines[i];
        if (para.length && RE.setext.test(next)) {
          out.push(this.heading(next.trim()[0] === '=' ? 1 : 2, para.join(' ').trim()));
          para = null;
          i++;
          break;
        }
        if (para.length && (RE.atx.test(next) || RE.fence.test(next) || RE.hr.test(next) ||
            RE.quote.test(next) || this.isListStart(next))) {
          break;
        }
        para.push(next);
        i++;
      }
      if (para && para.length) {
        out.push('<p>' + this.inline.render(para.join('\n').trim()) + '</p>');
      }
    }

    return out.join('\n');
  };

  Parser.prototype.isListStart = function (line) {
    if (line == null) return false;
    if (RE.hr.test(line)) return false;
    return RE.bullet.test(line) || RE.ordered.test(line);
  };

  Parser.prototype.readList = function (lines, start) {
    var first = lines[start];
    var ordered = RE.ordered.test(first);
    var startNum = ordered ? Number(first.match(RE.ordered)[2]) : 1;
    var items = [];
    var loose = false;
    var i = start;
    var pendingBlank = false;

    while (i < lines.length) {
      var line = lines[i];

      if (RE.blank.test(line)) {
        if (!items.length) break;
        pendingBlank = true;
        i++;
        continue;
      }

      var m = ordered ? line.match(RE.ordered) : line.match(RE.bullet);
      if (!m || RE.hr.test(line)) break;

      if (pendingBlank) { loose = true; pendingBlank = false; }
      var contentIndent = ordered
        ? m[1].length + m[2].length + m[3].length + m[4].length
        : m[1].length + m[2].length + m[3].length;
      items.push([ordered ? m[5] : m[4]]);
      i++;

      // Continuation lines belong to this item while indented far enough.
      while (i < lines.length) {
        if (RE.blank.test(lines[i])) {
          var lookahead = lines[i + 1];
          var indented = lookahead != null && !RE.blank.test(lookahead) &&
            indentWidth(lookahead) >= contentIndent;
          if (!indented) break;
          items[items.length - 1].push('');
          loose = true;
          i++;
          continue;
        }
        if (indentWidth(lines[i]) >= contentIndent) {
          items[items.length - 1].push(stripIndent(lines[i], contentIndent));
          i++;
          continue;
        }
        if (this.isListStart(lines[i]) || RE.atx.test(lines[i]) || RE.fence.test(lines[i]) ||
            RE.quote.test(lines[i]) || RE.hr.test(lines[i])) break;
        items[items.length - 1].push(lines[i].trim()); // lazy continuation
        i++;
      }
    }

    var self = this;
    var hasTask = false;
    var html = items.map(function (itemLines) {
      var text = itemLines.join('\n');
      var task = text.match(/^\[([ xX])\][ \t]+([\s\S]*)$/);
      var prefix = '';
      if (task) {
        hasTask = true;
        prefix = '<input type="checkbox" disabled' + (task[1] !== ' ' ? ' checked' : '') + '> ';
        text = task[2];
      }
      var inner = self.parse(text.split('\n'));
      if (!loose) {
        inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
      }
      return '<li' + (task ? ' class="md-task"' : '') + '>' + prefix + inner + '</li>';
    }).join('\n');

    var tag = ordered ? 'ol' : 'ul';
    var attrs = ordered && startNum !== 1 ? ' start="' + startNum + '"' : '';
    if (hasTask) attrs += ' class="md-tasklist"';

    return { html: '<' + tag + attrs + '>\n' + html + '\n</' + tag + '>', next: i };
  };

  Parser.prototype.readTable = function (lines, start) {
    var headerCells = splitRow(lines[start]);
    var aligns = splitRow(lines[start + 1]).map(function (cell) {
      var text = cell.trim();
      var left = text.indexOf(':') === 0;
      var right = /:$/.test(text);
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return '';
    });
    if (!headerCells.length || headerCells.length !== aligns.length) return null;

    var self = this;
    var rows = [];
    var i = start + 2;
    while (i < lines.length && !RE.blank.test(lines[i]) && lines[i].indexOf('|') !== -1) {
      rows.push(splitRow(lines[i]));
      i++;
    }

    function cells(list, tag) {
      return list.map(function (cell, index) {
        var align = aligns[index] ? ' style="text-align:' + aligns[index] + '"' : '';
        return '<' + tag + align + '>' + self.inline.render(cell.trim()) + '</' + tag + '>';
      }).join('');
    }

    var html = '<div class="md-table-wrap"><table>\n<thead><tr>' + cells(headerCells, 'th') +
      '</tr></thead>\n<tbody>' +
      rows.map(function (row) {
        while (row.length < headerCells.length) row.push('');
        return '<tr>' + cells(row.slice(0, headerCells.length), 'td') + '</tr>';
      }).join('\n') +
      '</tbody>\n</table></div>';

    return { html: html, next: i };
  };

  /* ------------------------------------------------------------------ utils */

  function indentWidth(line) {
    var width = 0;
    for (var i = 0; i < line.length; i++) {
      if (line[i] === ' ') width++;
      else if (line[i] === '\t') width += 4;
      else break;
    }
    return width;
  }

  function stripIndent(line, width) {
    var i = 0;
    var seen = 0;
    while (i < line.length && seen < width) {
      if (line[i] === ' ') seen++;
      else if (line[i] === '\t') seen += 4;
      else break;
      i++;
    }
    return line.slice(i);
  }

  function splitRow(line) {
    var trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    var cells = [];
    var current = '';
    for (var i = 0; i < trimmed.length; i++) {
      var ch = trimmed[i];
      if (ch === '\\' && trimmed[i + 1] === '|') { current += '|'; i++; continue; }
      if (ch === '|') { cells.push(current); current = ''; continue; }
      current += ch;
    }
    cells.push(current);
    return cells;
  }

  function splitFrontMatter(src) {
    var match = src.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!match) return { frontMatter: null, body: src };
    return { frontMatter: match[1], body: src.slice(match[0].length) };
  }

  /* ------------------------------------------------------------------- API */

  function render(src) {
    var split = splitFrontMatter(String(src == null ? '' : src).replace(/\r\n?/g, '\n'));
    var parser = new Parser();
    var html = parser.parse(split.body.split('\n'));
    if (split.frontMatter !== null) {
      html = '<details class="md-frontmatter"><summary>front matter</summary><pre><code>' +
        escapeHtml(split.frontMatter) + '</code></pre></details>\n' + html;
    }
    return { html: html, headings: parser.headings };
  }

  root.MD = { render: render, escapeHtml: escapeHtml, slugify: slugify };
})(typeof self !== 'undefined' ? self : this);
