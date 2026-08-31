/*
 * Content script: turns a plain .md file open in a tab into a rendered document
 * with a source toggle, an outline, and a jump into the editor.
 */
(function () {
  'use strict';

  var MD_EXT = /\.(md|markdown|mdown|mkd|mdx)$/i;

  function isMarkdownDocument() {
    var path = location.pathname.split('?')[0];
    if (!MD_EXT.test(decodeURIComponent(path))) return false;
    // Chrome renders text files as a lone <pre>; anything else is a real web
    // page that happens to end in .md and must be left alone.
    var pres = document.body ? document.body.querySelectorAll('pre') : [];
    return pres.length === 1 && document.body.children.length === 1;
  }

  if (!isMarkdownDocument()) return;

  var source = document.body.querySelector('pre').textContent || '';
  // Read back by the service worker for the "Edit this Markdown file" menu.
  window.__markdownStudioSource = source;

  var fileName = decodeURIComponent(location.pathname.split('/').pop() || 'document.md');
  var rendered = MD.render(source);

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

  var article = el('article', { className: 'md-body mds-article' });
  article.innerHTML = rendered.html;

  var pre = el('pre', { className: 'mds-source' }, [el('code', { textContent: source })]);
  pre.hidden = true;

  var outline = el('nav', { className: 'mds-outline' });
  rendered.headings.forEach(function (heading) {
    var link = el('a', {
      href: '#' + heading.id,
      textContent: heading.text,
      className: 'mds-outline-link mds-level-' + heading.level
    });
    outline.appendChild(link);
  });
  if (!rendered.headings.length) {
    outline.appendChild(el('p', { className: 'mds-outline-empty', textContent: 'No headings' }));
  }

  var showingSource = false;
  var toggleBtn = button('Source', 'Toggle rendered / raw Markdown (v)', function () {
    showingSource = !showingSource;
    article.hidden = showingSource;
    pre.hidden = !showingSource;
    toggleBtn.textContent = showingSource ? 'Rendered' : 'Source';
    toggleBtn.classList.toggle('is-active', showingSource);
  });

  var outlineBtn = button('Outline', 'Toggle the outline (o)', function () {
    var hidden = shell.classList.toggle('mds-no-outline');
    outlineBtn.classList.toggle('is-active', !hidden);
  });
  outlineBtn.classList.add('is-active');

  var copyBtn = button('Copy', 'Copy the Markdown source', function () {
    navigator.clipboard.writeText(source).then(function () {
      copyBtn.textContent = 'Copied';
      setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1200);
    }).catch(function () {
      copyBtn.textContent = 'Failed';
      setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1200);
    });
  });

  var editBtn = button('Edit', 'Open this file in the Markdown Studio editor (e)', function () {
    chrome.runtime.sendMessage({
      type: 'open-editor',
      payload: { name: fileName, text: source, sourceUrl: location.href }
    });
  });
  editBtn.classList.add('mds-btn-primary');

  var words = source.trim() ? source.trim().split(/\s+/).length : 0;
  var meta = el('span', {
    className: 'mds-meta',
    textContent: words.toLocaleString() + ' words · ' + Math.max(1, Math.round(words / 220)) + ' min read'
  });

  var toolbar = el('header', { className: 'mds-toolbar' }, [
    el('span', { className: 'mds-name', textContent: fileName, title: location.href }),
    meta,
    el('span', { className: 'mds-spacer' }),
    outlineBtn, toggleBtn, copyBtn, editBtn
  ]);

  var main = el('div', { className: 'mds-main' }, [
    el('div', { className: 'mds-doc' }, [article, pre]),
    el('aside', { className: 'mds-side' }, [
      el('p', { className: 'mds-side-title', textContent: 'Outline' }),
      outline
    ])
  ]);

  var shell = el('div', { className: 'mds-shell' }, [toolbar, main]);

  document.documentElement.classList.add('mds-active');
  document.body.textContent = '';
  document.body.appendChild(shell);
  document.title = fileName;

  // Highlight the section currently on screen.
  var links = Array.prototype.slice.call(outline.querySelectorAll('.mds-outline-link'));
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
    else if (event.key === 'o') outlineBtn.click();
    else if (event.key === 'e') editBtn.click();
  });
})();
