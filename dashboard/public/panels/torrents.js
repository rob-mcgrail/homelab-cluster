import { PANELS as DOTS } from '../config.js';

import { esc, fmtAgo } from '../utils.js';



let root, listEl, activeFilter = 'downloading', allTorrents = [];

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function badgeCls(cat) {
  if (cat === 'downloading') return 'badge-dl';
  if (cat === 'seeding')     return 'badge-seed';
  if (cat === 'triaged')     return 'badge-triage';
  return 'badge-pause';
}

function subStatus(t) {
  // Triage tag wins — status comes directly from the server's two-state
  // schema (paused / resumed). Backwards-compat for legacy tags is handled
  // server-side.
  if (t.triage && t.triage.status) {
    return { label: t.triage.status, since: t.triage.since };
  }
  // Untagged items in the triaged bucket — derive from raw qBit state.
  const s = t.state || '';
  if (s === 'queuedDL')                       return { label: 'queued' };
  if (s === 'stoppedDL' || s === 'pausedDL')  return { label: 'stopped' };
  if (s === 'stoppedUP' || s === 'pausedUP')  return { label: 'stopped' };
  if (s === 'error')                          return { label: 'error' };
  if (s === 'missingFiles')                   return { label: 'missing' };
  if (s === 'unknown')                        return { label: 'unknown' };
  return null;
}

function render() {
  const filtered = allTorrents.filter(t => t.category === activeFilter);
  if (!filtered.length) {
    listEl.innerHTML = `<div class="torrent-empty">${allTorrents.length ? 'None matching filter.' : 'No active torrents.'}</div>`;
    return;
  }
  listEl.innerHTML = filtered.map(t => {
    const sub = t.category === 'triaged' ? subStatus(t) : null;
    const subBadge = sub
      ? `<span class="badge badge-triage-sub">${sub.label}${sub.since ? ` · ${fmtAgo(sub.since)}` : ''}</span>`
      : '';
    return `
    <div class="torrent-item">
      <div class="torrent-name">${esc(t.name)}</div>
      ${t.sourceFile && t.sourceFile !== t.name ? `<div class="torrent-source">${esc(t.sourceFile)}</div>` : ''}
      <div class="torrent-meta">
        <span class="badge ${badgeCls(t.category)}">${t.category}</span>
        ${subBadge}
        <span>${t.downloaded} / ${t.size}</span>
        ${t.eta ? `<span>ETA ${t.eta}</span>` : ''}
        ${t.category === 'downloading' ? `<span>${t.dlspeed}</span>` : ''}
        ${t.category === 'seeding' ? `<span>↑ ${t.upspeed}</span>` : ''}
      </div>
      <div class="torrent-bar"><div class="torrent-bar-fill" style="width:${t.progress}%"></div></div>
    </div>
  `;
  }).join('');
}

async function refresh() {
  try {
    const res = await fetch('/api/torrents');
    allTorrents = await res.json();
    render();
  } catch {
    allTorrents = [];
    listEl.innerHTML = '<div class="torrent-empty">Could not load torrents.</div>';
  }
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-torrents scrollable';
  root.id = 'panelTorrents';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone"><div class="octopus critter">🐙</div></div>
      <div class="section-title-blue">DOWNLOADS</div>
      <div class="torrent-filters">
        <button class="filter-btn active" data-f="downloading">Downloading</button>
        <button class="filter-btn" data-f="seeding">Seeding</button>
        <button class="filter-btn" data-f="triaged">Triaged</button>
      </div>
      <div class="torrent-list"></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  listEl = root.querySelector('.torrent-list');
  root.querySelectorAll('.torrent-filters .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.torrent-filters .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.f;
      render();
    });
  });
  return root;
}

export default { id: 'torrents', mount, refresh, onShow: refresh };
