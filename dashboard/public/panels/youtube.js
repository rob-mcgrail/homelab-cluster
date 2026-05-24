import { PANELS as DOTS } from '../config.js';

import { esc, fmtAgo } from '../utils.js';



let root, urlInput, btn, statusEl, listEl, refreshTimer = null;

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

function renderItem(item) {
  if (item.pending) {
    return `
      <div class="yt-item pending">
        <div class="yt-url">${esc(item.url)}</div>
        <div class="yt-status">Queued${item.requested_at ? ` · ${fmtAgo(item.requested_at)}` : ''}</div>
      </div>
    `;
  }
  if (item.ok) {
    const title = item.title || '(untitled)';
    const size = fmtSize(item.size);
    const tail = item.already_present ? ' · already on disk' : (size ? ` · ${size}` : '');
    return `
      <div class="yt-item done">
        <div class="yt-title">${esc(title)}</div>
        <div class="yt-status">Saved${tail}${item.completed_at ? ` · ${fmtAgo(item.completed_at)}` : ''}</div>
      </div>
    `;
  }
  return `
    <div class="yt-item failed">
      <div class="yt-url">${esc(item.url || '')}</div>
      <div class="yt-status">Failed${item.error ? ` — ${esc(item.error)}` : ''}${item.completed_at ? ` · ${fmtAgo(item.completed_at)}` : ''}</div>
    </div>
  `;
}

async function refresh() {
  if (!listEl) return;
  try {
    const res = await fetch('/api/youtube-grabs');
    const items = await res.json();
    if (!Array.isArray(items) || !items.length) {
      listEl.innerHTML = '<div class="yt-empty">Paste a YouTube URL above.</div>';
      return;
    }
    listEl.innerHTML = items.map(renderItem).join('');
  } catch {
    listEl.innerHTML = '<div class="yt-empty">Couldn’t load recent grabs.</div>';
  }
}

async function send() {
  const v = (urlInput.value || '').trim();
  if (!v) return;
  btn.disabled = true;
  statusEl.className = 'yt-prompt-status';
  statusEl.textContent = 'Queuing…';
  try {
    const res = await fetch('/api/youtube-grab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: v }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || 'rejected');
    }
    urlInput.value = '';
    statusEl.className = 'yt-prompt-status ok';
    statusEl.textContent = 'Queued. The host runner picks this up within a minute.';
    refresh();
  } catch (e) {
    statusEl.className = 'yt-prompt-status fail';
    statusEl.textContent = `Couldn’t queue: ${e.message || 'try again'}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { statusEl.className = 'yt-prompt-status'; statusEl.textContent = ''; }, 4000);
  }
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-youtube scrollable';
  root.id = 'panelYoutube';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone yt-cloud-zone">
        <div class="cloud critter cloud-0">☁️</div>
        <div class="cloud critter cloud-1">☁️</div>
        <div class="cloud critter cloud-2">☁️</div>
      </div>
      <div class="section-title-yt">YOUTUBE</div>
      <div class="yt-form">
        <input class="yt-url-input" type="url" placeholder="Paste YouTube URL" inputmode="url" autocomplete="off" />
        <button class="yt-send-btn">GRAB</button>
        <div class="yt-prompt-status"></div>
      </div>
      <div class="yt-list"></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  urlInput = root.querySelector('.yt-url-input');
  btn = root.querySelector('.yt-send-btn');
  statusEl = root.querySelector('.yt-prompt-status');
  listEl = root.querySelector('.yt-list');

  btn.addEventListener('click', send);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  return root;
}

function onShow() {
  refresh();
  // Poll while the panel is visible so pending items move to "Saved"
  // shortly after the host runner finishes.
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 5000);
}

function onHide() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

export default { id: 'youtube', mount, onShow, onHide, refresh };
