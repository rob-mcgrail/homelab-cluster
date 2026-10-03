import { PANELS as DOTS } from '../config.js';

import { esc, fmtAgo } from '../utils.js';

// Books panel: upload ebooks into the books OPDS server's folder so they
// can be pulled down on the Kindle (KOReader → OPDS catalog) with no cable.

const ACCEPT = '.epub,.pdf,.mobi,.azw3,.azw,.fb2,.djvu,.cbz,.cbr,.txt';

let root, fileInput, pickBtn, statusEl, progressEl, resultsEl, listEl, countEl;

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function fmtSize(bytes) {
  const mb = bytes / 1024 ** 2;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const bookTitle = (name) => name.replace(/^.*\//, '').replace(/\.[^.]+$/, '');

async function refresh() {
  if (!listEl) return;
  try {
    const { total, recent } = await (await fetch('/api/books')).json();
    countEl.textContent = `${total} book${total === 1 ? '' : 's'} on the server`;
    listEl.innerHTML = recent.length
      ? recent.map((b) => `
          <div class="books-item">
            <div class="books-title">${esc(bookTitle(b.name))}</div>
            <div class="books-meta">${esc(b.name.split('.').pop().toUpperCase())} · ${fmtSize(b.size)} · ${fmtAgo(Math.floor(b.mtime / 1000))}</div>
          </div>`).join('')
      : '<div class="books-empty">No books yet.</div>';
  } catch {
    listEl.innerHTML = '<div class="books-empty">Couldn’t load books.</div>';
  }
}

// XHR rather than fetch so we get upload progress for big PDFs.
function upload(files) {
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append('file', f);
  pickBtn.disabled = true;
  resultsEl.innerHTML = '';
  statusEl.className = 'books-status';
  statusEl.textContent = `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`;
  progressEl.hidden = false;
  progressEl.value = 0;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/books/upload');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) progressEl.value = e.loaded / e.total; };
  xhr.onload = () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch {}
    const results = body.results || [];
    const okCount = results.filter((r) => r.ok).length;
    if (xhr.status === 200 && results.length) {
      statusEl.className = `books-status ${okCount === results.length ? 'ok' : okCount ? '' : 'fail'}`;
      statusEl.textContent = okCount
        ? `Added ${okCount} — open KOReader’s OPDS catalog to download.`
        : 'Nothing added.';
      resultsEl.innerHTML = results.filter((r) => !r.ok)
        .map((r) => `<div class="books-result fail">${esc(r.name)} — ${esc(r.error || 'failed')}</div>`).join('');
    } else {
      statusEl.className = 'books-status fail';
      statusEl.textContent = `Upload failed${body.error ? `: ${body.error}` : xhr.status === 413 ? ': too large' : ''}`;
    }
    done();
  };
  xhr.onerror = () => {
    statusEl.className = 'books-status fail';
    statusEl.textContent = 'Upload failed — connection dropped.';
    done();
  };
  xhr.send(form);

  function done() {
    pickBtn.disabled = false;
    progressEl.hidden = true;
    fileInput.value = '';
    refresh();
  }
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-books scrollable';
  root.id = 'panelBooks';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone books-zone">
        <div class="books-critter critter books-c0">📖</div>
        <div class="books-critter critter books-c1">📚</div>
        <div class="books-critter critter books-c2">🔖</div>
      </div>
      <div class="section-title-books">BOOKS</div>
      <div class="books-drop">
        <input class="books-file" type="file" multiple accept="${ACCEPT}" hidden />
        <button class="books-pick-btn">UPLOAD BOOKS</button>
        <div class="books-hint">epub, pdf, mobi, azw3, cbz… — or drop files here</div>
        <progress class="books-progress" max="1" value="0" hidden></progress>
        <div class="books-status"></div>
        <div class="books-results"></div>
      </div>
      <div class="books-count"></div>
      <div class="books-list"></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  fileInput = root.querySelector('.books-file');
  pickBtn = root.querySelector('.books-pick-btn');
  statusEl = root.querySelector('.books-status');
  progressEl = root.querySelector('.books-progress');
  resultsEl = root.querySelector('.books-results');
  listEl = root.querySelector('.books-list');
  countEl = root.querySelector('.books-count');

  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => upload([...fileInput.files]));

  // Desktop drag-and-drop anywhere on the drop box.
  const drop = root.querySelector('.books-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (!pickBtn.disabled) upload([...e.dataTransfer.files]);
  });
  return root;
}

export default { id: 'books', mount, refresh, onShow: refresh };
