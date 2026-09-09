/*
 * Content script: turns a Markdown, JSON or XML file open in a tab into a
 * readable document - rendered prose, or a collapsible tree - with a source
 * toggle and a jump into the editor.
 */
(function () {
  'use strict';

  var MD_EXT = /\.(md|markdown|mdown|mkd|mdx)$/i;

  function kindFromLocation() {
    var path = decodeURIComponent(location.pathname.split('?')[0]);
    if (MD_EXT.test(path)) return 'markdown';
    if (Structured.JSON_EXT.test(path)) return 'json';
    if (Structured.XML_EXT.test(path)) return 'xml';
    return null;
  }

  /* Chrome renders these files in one of two ways, and the source has to come
     back out of whichever one it used:
       - text (JSON, Markdown, and XML served as text/plain) becomes a lone <pre>
       - XML served as XML gets Chrome's own viewer, which keeps the parsed
         document in #webkit-xml-viewer-source-xml */
  function readSource() {
    var pre = document.body && document.body.querySelector('pre');
    if (pre && document.body.firstElementChild === pre) return pre.textContent || '';

    var xmlSource = document.getElementById('webkit-xml-viewer-source-xml');
    if (xmlSource && xmlSource.firstElementChild) {
      return new XMLSerializer().serializeToString(xmlSource.firstElementChild);
    }
    return null;
  }

  var kind = kindFromLocation();
  if (!kind) return;

  var source = readSource();
  if (source === null) return; // a real web page that merely ends in .json

  // Read back by the service worker for the "Edit this file" menu.
  window.__markdownWizardSource = source;

  var fileName = decodeURIComponent(location.pathname.split('/').pop() || 'document');
  var isData = kind !== 'markdown';

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.assign(node, props || {});
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function button(label, title, onClick) {
    var b = el('button', { className: 'mds-btn', type: 'button', textContent: label, title: title });
    b.addEventListener('click', onClick);
    return b;
  }

  /* ------------------------------------------------------------- document */

  var article = el('article', { className: isData ? 'mds-article' : 'md-body mds-article' });
  var rendered = null;
  var structured = null;

  if (isData) {
    structured = Structured.render(kind, source);
    article.appendChild(structured.node);
  } else {
    rendered = MD.render(source);
    article.innerHTML = rendered.html;
  }

  var pre = el('pre', { className: 'mds-source' }, [el('code', { textContent: source })]);
  pre.hidden = true;

  /* ---------------------------------------------------------------- aside */

  var side = el('aside', { className: 'mds-side' });

  if (isData) {
    side.appendChild(el('p', { className: 'mds-side-title', textContent: Structured.label(kind) }));
    side.appendChild(el('p', {
      className: structured.error ? 'mds-side-error' : 'mds-side-note',
      textContent: structured.error || structured.summary
    }));
    side.appendChild(el('div', { className: 'mds-side-actions' }, [
      button('Expand all', 'Open every node', function () { Structured.expandAll(article, true); }),
      button('Collapse all', 'Close every node', function () { Structured.expandAll(article, false); })
    ]));
  } else {
    side.appendChild(el('p', { className: 'mds-side-title', textContent: 'Outline' }));
    var outline = el('nav', { className: 'mds-outline' });
    rendered.headings.forEach(function (heading) {
      outline.appendChild(el('a', {
        href: '#' + heading.id,
        textContent: heading.text,
        className: 'mds-outline-link mds-level-' + heading.level
      }));
    });
    if (!rendered.headings.length) {
      outline.appendChild(el('p', { className: 'mds-outline-empty', textContent: 'No headings' }));
    }
    side.appendChild(outline);
  }

  /* -------------------------------------------------------------- toolbar */

  var showingSource = false;
  var toggleBtn = button('Source', 'Toggle rendered / raw (v)', function () {
    showingSource = !showingSource;
    article.hidden = showingSource;
    pre.hidden = !showingSource;
    toggleBtn.textContent = showingSource ? 'Rendered' : 'Source';
    toggleBtn.classList.toggle('is-active', showingSource);
  });

  var sideBtn = button(isData ? 'Panel' : 'Outline', 'Toggle the side panel (o)', function () {
    var hidden = shell.classList.toggle('mds-no-outline');
    sideBtn.classList.toggle('is-active', !hidden);
  });
  sideBtn.classList.add('is-active');

  var copyBtn = button('Copy', 'Copy the source', function () {
    navigator.clipboard.writeText(source).then(function () {
      copyBtn.textContent = 'Copied';
      setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1200);
    }).catch(function () {
      copyBtn.textContent = 'Failed';
      setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1200);
    });
  });

  var editBtn = button('Edit', 'Open this file in the editor (e)', function () {
    chrome.runtime.sendMessage({
      type: 'open-editor',
      payload: { name: fileName, text: source, sourceUrl: location.href }
    });
  });
  editBtn.classList.add('mds-btn-primary');

  var metaText;
  if (isData) {
    var lines = source.split('\n').length;
    metaText = lines.toLocaleString() + (lines === 1 ? ' line' : ' lines') + ' - ' + structured.summary;
  } else {
    var words = source.trim() ? source.trim().split(/\s+/).length : 0;
    metaText = words.toLocaleString() + ' words - ' + Math.max(1, Math.round(words / 220)) + ' min read';
  }

  var toolbar = el('header', { className: 'mds-toolbar' }, [
    el('span', { className: 'mds-name', textContent: fileName, title: location.href }),
    el('span', { className: 'mds-meta', textContent: metaText }),
    el('span', { className: 'mds-spacer' }),
    sideBtn, toggleBtn, copyBtn, editBtn
  ]);

  var main = el('div', { className: 'mds-main' }, [
    el('div', { className: 'mds-doc' }, [article, pre]),
    side
  ]);

  var shell = el('div', { className: 'mds-shell' }, [toolbar, main]);

  document.documentElement.classList.add('mds-active');
  document.body.textContent = '';
  document.body.appendChild(shell);
  document.title = fileName;

  // Highlight the section currently on screen (Markdown only).
  var links = Array.prototype.slice.call(side.querySelectorAll('.mds-outline-link'));
  if (links.length && 'IntersectionObserver' in window) {
    var byId = {};
    links.forEach(function (link) { byId[link.getAttribute('href').slice(1)] = link; });
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (link) { link.classList.remove('is-current'); });
        var current = byId[entry.target.id];
        if (current) current.classList.add('is-current');
      });
    }, { rootMargin: '0px 0px -75% 0px' });
    article.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')
      .forEach(function (heading) { observer.observe(heading); });
  }

  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    var tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.key === 'v') toggleBtn.click();
    else if (event.key === 'o') sideBtn.click();
    else if (event.key === 'e') editBtn.click();
  });
})();
