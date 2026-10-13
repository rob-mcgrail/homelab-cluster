import { PANELS as DOTS, jellyfinItemUrl } from '../config.js';

import { esc } from '../utils.js';

// New panel: latest additions in each Jellyfin library. TV libraries come
// back grouped by series ("Jazz — 10 new eps") rather than one card per
// episode. Library chips filter to one library; "All" stacks them.

let root, listEl, chipsEl, filter = 'all';
let cached = null, lastText = '';

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function ago(iso) {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return `${Math.floor(d)}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function card(it) {
  // A grouped series' DateCreated is when the show was first added, not
  // when the new episodes landed — so only date movies and lone episodes.
  const when = it.grouped ? '' : ago(it.addedAt);
  return `
    <a class="new-card" href="${jellyfinItemUrl(it.id, it.serverId)}" target="_blank" rel="noopener noreferrer">
      <div class="new-poster">
        <img loading="lazy" src="/api/jellyfin/image/${esc(it.imageId)}?w=240" alt="" onerror="this.remove()">
        ${it.played ? '<span class="new-played">✓</span>' : ''}
      </div>
      <div class="new-title">${esc(it.title)}</div>
      <div class="new-sub">${esc([it.sub, when].filter(Boolean).join(' · '))}</div>
    </a>`;
}

function render() {
  if (!cached) return;
  chipsEl.innerHTML = ['all', ...cached.map((s) => s.library)].map((f) =>
    `<button class="filter-btn${f === filter ? ' active' : ''}" data-f="${esc(f)}">${esc(f === 'all' ? 'All' : f)}</button>`
  ).join('');
  const sections = cached.filter((s) => filter === 'all' || s.library === filter);
  if (!sections.length) {
    listEl.innerHTML = '<div class="new-empty">Nothing from Jellyfin.</div>';
    return;
  }
  listEl.innerHTML = sections.map((s) => `
    <div class="new-section">
      <div class="new-lib">${esc(s.library)}</div>
      ${s.items.length
        ? `<div class="new-grid">${(filter === 'all' ? s.items.slice(0, 6) : s.items).map(card).join('')}</div>`
        : '<div class="new-empty">Nothing yet.</div>'}
    </div>`).join('');
}

async function refresh() {
  if (!listEl) return;
  try {
    const text = await (await fetch('/api/jellyfin/new')).text();
    // The 15s auto-refresh would otherwise rebuild every poster <img>.
    if (cached && text === lastText) return;
    lastText = text;
    cached = JSON.parse(text);
    if (filter !== 'all' && !cached.some((s) => s.library === filter)) filter = 'all';
    render();
  } catch {
    if (!cached) listEl.innerHTML = '<div class="new-empty">Couldn’t reach Jellyfin.</div>';
  }
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-new scrollable';
  root.id = 'panelNew';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone new-zone">
        <div class="new-critter critter new-c0">🍿</div>
        <div class="new-critter critter new-c1">🎞️</div>
        <div class="new-critter critter new-c2">📺</div>
      </div>
      <div class="section-title-new">NEW IN JELLYFIN</div>
      <div class="new-filters"></div>
      <div class="new-list"></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  listEl = root.querySelector('.new-list');
  chipsEl = root.querySelector('.new-filters');
  chipsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    filter = btn.dataset.f;
    render();
  });
  return root;
}

export default { id: 'new', mount, refresh, onShow: refresh };
