/*
 * book.js - a reader for XML documents that are really books or feeds.
 *
 * A WordPress/Pressbooks export (WXR) carries a whole book: <item> elements
 * whose wp:post_type is part, chapter, front-matter or back-matter, ordered by
 * wp:menu_order and nested by wp:post_parent, with the prose as HTML inside
 * <content:encoded>. Shown as a generic element tree that is unreadable, so
 * this turns it back into a table of contents you can navigate.
 *
 * Plain RSS and Atom feeds get the same treatment: a list of pieces you can
 * open and read.
 *
 * The prose is HTML written by someone else, so it is rebuilt node by node
 * against an allowlist rather than assigned as markup.
 *
 * Exposes a single global: Book
 */
(function (root) {
  'use strict';

  /* --------------------------------------------------------------- reading */

  var SKIP_TYPES = /^(attachment|nav_menu_item|custom_css|wp_global_styles|wp_navigation|revision|metadata)$/i;
  var FRONT = 'front-matter';
  var BACK = 'back-matter';

  function childElements(parent) {
    var out = [];
    if (!parent) return out;
    for (var i = 0; i < parent.childNodes.length; i++) {
      if (parent.childNodes[i].nodeType === 1) out.push(parent.childNodes[i]);
    }
    return out;
  }

  /** Finds a direct child by qualified name ("content:encoded") or, when no
      prefix is given, by local name - which keeps namespace declarations from
      mattering. */
  function child(parent, name) {
    var wantsPrefix = name.indexOf(':') !== -1;
    var kids = childElements(parent);
    for (var i = 0; i < kids.length; i++) {
      var node = kids[i];
      if (wantsPrefix ? node.nodeName === name : (node.localName || node.nodeName) === name) {
        return node;
      }
    }
    return null;
  }

  function textOf(parent, name) {
    var node = name ? child(parent, name) : parent;
    return node ? (node.textContent || '').trim() : '';
  }

  function numberOf(parent, name, fallback) {
    var raw = textOf(parent, name);
    var value = parseInt(raw, 10);
    return isNaN(value) ? fallback : value;
  }

  /** Roughly how long a piece is, without paying to sanitise it first. */
  function wordCount(html) {
    var text = String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ');
    var words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return words;
  }

  function isBookish(doc) {
    if (!doc || !doc.documentElement) return false;
    var name = (doc.documentElement.localName || doc.documentElement.nodeName).toLowerCase();
    return name === 'rss' || name === 'feed' || name === 'channel';
  }

  function parse(doc) {
    if (!isBookish(doc)) return null;
    var name = (doc.documentElement.localName || doc.documentElement.nodeName).toLowerCase();
    var model = name === 'feed' ? parseAtom(doc) : parseRss(doc);
    if (!model || !model.reading.length) return null;
    return model;
  }

  function parseRss(doc) {
    var channel = child(doc.documentElement, 'channel') || doc.documentElement;
    var items = childElements(channel).filter(function (node) {
      return (node.localName || node.nodeName) === 'item';
    });

    var title = textOf(channel, 'title');
    var description = textOf(channel, 'description');
    var author = '';
    var entries = [];
    var parts = [];
    var isExport = false;

    items.forEach(function (item, index) {
      var type = textOf(item, 'wp:post_type') || textOf(item, 'post_type');
      var status = textOf(item, 'wp:status') || textOf(item, 'status');
      if (type) isExport = true;

      if (type && type.toLowerCase() === 'metadata') {
        author = author || textOf(item, 'dc:creator');
        return;
      }
      if (type && SKIP_TYPES.test(type)) return;
      if (status && /^(trash|auto-draft|inherit)$/i.test(status)) return;

      var entry = {
        id: textOf(item, 'wp:post_id') || ('item-' + index),
        title: textOf(item, 'title') || 'Untitled',
        type: (type || 'item').toLowerCase(),
        parent: textOf(item, 'wp:post_parent') || '0',
        order: numberOf(item, 'wp:menu_order', index + 1),
        date: textOf(item, 'pubDate') || textOf(item, 'wp:post_date'),
        author: textOf(item, 'dc:creator'),
        url: textOf(item, 'link'),
        html: textOf(item, 'content:encoded') || textOf(item, 'description'),
        documentOrder: index
      };
      entry.words = wordCount(entry.html);

      if (entry.type === 'part') parts.push(entry);
      else entries.push(entry);
    });

    return buildModel({
      title: title,
      description: description,
      author: author,
      entries: entries,
      parts: parts,
      structured: isExport
    });
  }

  function parseAtom(doc) {
    var entries = childElements(doc.documentElement)
      .filter(function (node) { return (node.localName || node.nodeName) === 'entry'; })
      .map(function (item, index) {
        var entry = {
          id: textOf(item, 'id') || ('entry-' + index),
          title: textOf(item, 'title') || 'Untitled',
          type: 'item',
          parent: '0',
          order: index + 1,
          date: textOf(item, 'updated') || textOf(item, 'published'),
          author: textOf(child(item, 'author'), 'name'),
          url: (child(item, 'link') && child(item, 'link').getAttribute('href')) || '',
          html: textOf(item, 'content') || textOf(item, 'summary'),
          documentOrder: index
        };
        entry.words = wordCount(entry.html);
        return entry;
      });

    return buildModel({
      title: textOf(doc.documentElement, 'title'),
      description: textOf(doc.documentElement, 'subtitle'),
      author: '',
      entries: entries,
      parts: [],
      structured: false
    });
  }

  function byOrder(a, b) {
    if (a.order !== b.order) return a.order - b.order;
    return a.documentOrder - b.documentOrder;
  }

  /** Turns the flat item list into the sections a reader expects: front matter,
      each part with its chapters, then back matter. */
  function buildModel(input) {
    var sections = [];
    var reading = [];

    function section(title, list) {
      if (!list.length) return;
      sections.push({ title: title, entries: list });
      list.forEach(function (entry) { reading.push(entry); });
    }

    if (input.structured) {
      var front = input.entries.filter(function (e) { return e.type === FRONT; }).sort(byOrder);
      var back = input.entries.filter(function (e) { return e.type === BACK; }).sort(byOrder);
      var chapters = input.entries.filter(function (e) {
        return e.type !== FRONT && e.type !== BACK;
      });

      section('Front matter', front);

      input.parts.sort(byOrder).forEach(function (part) {
        var own = chapters.filter(function (e) { return e.parent === part.id; }).sort(byOrder);
        // A part with prose of its own reads as its opening piece.
        var list = wordCount(part.html) ? [part].concat(own) : own;
        if (list.length) section(part.title, list);
      });

      var claimed = {};
      sections.forEach(function (s) {
        s.entries.forEach(function (e) { claimed[e.id] = true; });
      });
      var loose = chapters.filter(function (e) { return !claimed[e.id]; }).sort(byOrder);
      section(input.parts.length ? 'Other chapters' : 'Chapters', loose);

      section('Back matter', back);
    } else {
      section(input.title || 'Contents', input.entries.slice());
    }

    reading.forEach(function (entry, index) { entry.position = index; });

    return {
      title: input.title || 'Untitled',
      description: input.description || '',
      author: input.author || '',
      sections: sections,
      reading: reading
    };
  }

  /* ------------------------------------------------------------ sanitising */

  // Everything not listed is unwrapped (its children are kept); everything in
  // DROP loses its subtree as well.
  var ALLOWED = {
    A: ['href', 'title'], P: [], BR: [], HR: [],
    H1: ['id'], H2: ['id'], H3: ['id'], H4: ['id'], H5: ['id'], H6: ['id'],
    UL: [], OL: ['start'], LI: [], DL: [], DT: [], DD: [],
    BLOCKQUOTE: ['cite'], PRE: [], CODE: [], KBD: [], SAMP: [], VAR: [],
    EM: [], STRONG: [], I: [], B: [], U: [], S: [], DEL: [], INS: [],
    SUP: [], SUB: [], SMALL: [], MARK: [], ABBR: ['title'], CITE: [], Q: ['cite'],
    TIME: ['datetime'], SPAN: [], DIV: [], SECTION: [], ARTICLE: [], ASIDE: [],
    HEADER: [], FOOTER: [], MAIN: [], NAV: [], FIGURE: [], FIGCAPTION: [],
    IMG: ['src', 'alt', 'title', 'width', 'height'],
    TABLE: [], CAPTION: [], THEAD: [], TBODY: [], TFOOT: [],
    TR: [], TH: ['colspan', 'rowspan', 'scope'], TD: ['colspan', 'rowspan']
  };

  var DROP = /^(SCRIPT|STYLE|IFRAME|FRAME|FRAMESET|OBJECT|EMBED|APPLET|FORM|INPUT|BUTTON|SELECT|OPTION|TEXTAREA|LINK|META|BASE|NOSCRIPT|TEMPLATE|SVG|MATH|CANVAS|AUDIO|VIDEO|SOURCE|TRACK|DIALOG|SLOT)$/;

  function safeUrl(value, allowData) {
    var url = String(value || '').trim();
    if (!url) return '';
    if (allowData && /^data:image\/(png|jpe?g|gif|webp);/i.test(url)) return url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      return /^(https?|mailto|tel):/i.test(url) ? url : '';
    }
    return url; // relative, protocol-relative or fragment
  }

  /** Rebuilds foreign HTML as nodes we constructed ourselves. */
  function sanitize(html) {
    var fragment = document.createDocumentFragment();
    if (!html) return fragment;

    var parsed = new DOMParser().parseFromString(String(html), 'text/html');
    copyInto(parsed.body, fragment, 0);
    return fragment;
  }

  function copyInto(source, target, depth) {
    if (depth > 64) return;
    for (var i = 0; i < source.childNodes.length; i++) {
      var node = source.childNodes[i];

      if (node.nodeType === 3) {
        target.appendChild(document.createTextNode(node.nodeValue));
        continue;
      }
      if (node.nodeType !== 1) continue;

      var tag = node.tagName.toUpperCase();
      if (DROP.test(tag)) continue;

      if (!Object.prototype.hasOwnProperty.call(ALLOWED, tag)) {
        copyInto(node, target, depth + 1); // unwrap, keep the words
        continue;
      }

      var clean = document.createElement(tag.toLowerCase());
      ALLOWED[tag].forEach(function (name) {
        if (!node.hasAttribute(name)) return;
        var value = node.getAttribute(name);
        if (name === 'href' || name === 'src' || name === 'cite') {
          value = safeUrl(value, name === 'src');
          if (!value) return;
        }
        clean.setAttribute(name, value);
      });

      if (tag === 'A') {
        if (!clean.hasAttribute('href')) {
          // The URL was rejected; keep the words, lose the dead link.
          copyInto(node, target, depth + 1);
          continue;
        }
        clean.setAttribute('target', '_blank');
        clean.setAttribute('rel', 'noopener noreferrer');
      }
      if (tag === 'IMG') {
        clean.setAttribute('loading', 'lazy');
        if (!clean.hasAttribute('src')) continue;
      }

      copyInto(node, clean, depth + 1);
      target.appendChild(clean);
    }
  }

  /* ---------------------------------------------------------------- reader */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function describe(entry) {
    var bits = [];
    if (entry.type && entry.type !== 'item' && entry.type !== 'chapter') {
      bits.push(entry.type.replace(/-/g, ' '));
    }
    if (entry.words) bits.push(entry.words.toLocaleString() + ' words');
    if (entry.date) {
      var when = new Date(entry.date);
      if (!isNaN(when.getTime())) {
        bits.push(when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
      }
    }
    return bits.join(' · ');
  }

  /** Builds the whole reader: a table of contents, and a page view with
      previous/next. Returns the node plus a little control surface. */
  function create(model) {
    var wrap = el('div', 'bk');

    /* ------------------------------------------------------- contents */

    var contents = el('div', 'bk-contents');
    var head = el('header', 'bk-head');
    head.appendChild(el('h1', 'bk-title', model.title));
    var subtitle = [model.author, model.description].filter(Boolean).join(' · ');
    if (subtitle) head.appendChild(el('p', 'bk-byline', subtitle));
    head.appendChild(el('p', 'bk-count',
      model.reading.length + (model.reading.length === 1 ? ' section' : ' sections')));

    var filter = el('input', 'bk-filter');
    filter.type = 'search';
    filter.placeholder = 'Find a section';
    filter.setAttribute('aria-label', 'Filter the contents');
    head.appendChild(filter);
    contents.appendChild(head);

    var toc = el('nav', 'bk-toc');
    contents.appendChild(toc);

    var buttons = [];
    model.sections.forEach(function (section) {
      var group = el('div', 'bk-section');
      group.appendChild(el('h2', 'bk-section-title', section.title));
      section.entries.forEach(function (entry) {
        var item = el('button', 'bk-entry');
        item.type = 'button';
        item.appendChild(el('span', 'bk-entry-title', entry.title));
        var meta = describe(entry);
        if (meta) item.appendChild(el('small', 'bk-entry-meta', meta));
        item.addEventListener('click', function () { open(entry.position); });
        group.appendChild(item);
        buttons.push({ node: item, entry: entry, group: group });
      });
      toc.appendChild(group);
    });

    var noMatch = el('p', 'bk-empty', 'Nothing matches.');
    noMatch.hidden = true;
    toc.appendChild(noMatch);

    filter.addEventListener('input', function () {
      var needle = filter.value.trim().toLowerCase();
      var shown = 0;
      buttons.forEach(function (item) {
        var hit = !needle || item.entry.title.toLowerCase().indexOf(needle) !== -1;
        item.node.hidden = !hit;
        if (hit) shown += 1;
      });
      // Hide a section heading when everything under it is filtered out.
      model.sections.forEach(function (section, index) {
        var group = toc.children[index];
        if (!group || !group.classList.contains('bk-section')) return;
        var any = buttons.some(function (item) { return item.group === group && !item.node.hidden; });
        group.hidden = !any;
      });
      noMatch.hidden = shown > 0;
    });

    /* --------------------------------------------------------- reading */

    var page = el('article', 'bk-page');
    page.hidden = true;

    var topBar = el('div', 'bk-bar');
    var backButton = el('button', 'bk-back');
    backButton.type = 'button';
    backButton.textContent = 'Contents';
    backButton.addEventListener('click', showContents);
    var where = el('span', 'bk-where');
    topBar.appendChild(backButton);
    topBar.appendChild(where);
    page.appendChild(topBar);

    var pageTitle = el('h1', 'bk-page-title');
    var pageMeta = el('p', 'bk-page-meta');
    var body = el('div', 'bk-body md-body');
    page.appendChild(pageTitle);
    page.appendChild(pageMeta);
    page.appendChild(body);

    var bottomBar = el('div', 'bk-bar bk-bar-bottom');
    var prev = el('button', 'bk-prev');
    prev.type = 'button';
    prev.textContent = 'Previous';
    prev.addEventListener('click', function () { open(currentIndex - 1); });
    var next = el('button', 'bk-next');
    next.type = 'button';
    next.textContent = 'Next';
    next.addEventListener('click', function () { open(currentIndex + 1); });
    bottomBar.appendChild(prev);
    bottomBar.appendChild(next);
    page.appendChild(bottomBar);

    wrap.appendChild(contents);
    wrap.appendChild(page);

    var currentIndex = -1;

    function open(index) {
      if (index < 0 || index >= model.reading.length) return;
      var entry = model.reading[index];
      currentIndex = index;

      pageTitle.textContent = entry.title;
      var meta = describe(entry);
      pageMeta.textContent = meta;
      pageMeta.hidden = !meta;

      body.replaceChildren(sanitize(entry.html));
      if (!body.childNodes.length) {
        body.appendChild(el('p', 'bk-empty', 'This section has no text of its own.'));
      }

      where.textContent = (index + 1) + ' of ' + model.reading.length;
      prev.disabled = index === 0;
      next.disabled = index === model.reading.length - 1;

      contents.hidden = true;
      page.hidden = false;
      wrap.scrollTop = 0;
      if (wrap.parentElement) wrap.parentElement.scrollTop = 0;
    }

    function showContents() {
      page.hidden = true;
      contents.hidden = false;
    }

    return {
      node: wrap,
      open: open,
      showContents: showContents,
      isReading: function () { return !page.hidden; },
      model: model
    };
  }

  root.Book = {
    parse: parse,
    create: create,
    sanitize: sanitize,
    isBookish: isBookish
  };
})(typeof self !== 'undefined' ? self : this);
