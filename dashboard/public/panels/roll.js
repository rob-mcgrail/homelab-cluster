import { PANELS as DOTS, jellyfinItemUrl } from '../config.js';

import { esc } from '../utils.js';

// Roll panel: a random unwatched film from the Films library, optionally
// limited to a decade range. Rolls once on first show; after that only
// the ROLL button picks again — the 15s auto-refresh must never swap the
// film out from under you.

const RANGE_KEY = 'rollDecades';

let root, fromSel, toSel, rollBtn, cardEl, countEl;
let pick = null, rolling = false, decadesSeen = '';

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function loadRange() {
  try { return JSON.parse(localStorage.getItem(RANGE_KEY)) || {}; } catch { return {}; }
}
function saveRange() {
  try { localStorage.setItem(RANGE_KEY, JSON.stringify({ from: fromSel.value, to: toSel.value })); } catch {}
}

// Rebuild the decade dropdowns from what's actually unwatched, keeping
// the current selection where it still exists.
function fillDecades(decades) {
  const key = decades.map((d) => `${d.decade}:${d.count}`).join(',');
  if (key === decadesSeen) return;
  decadesSeen = key;
  const saved = { from: fromSel.value, to: toSel.value };
  const opts = (sel, anyLabel) => `<option value="">${anyLabel}</option>` + decades
    .sort((a, b) => a.decade - b.decade)
    .map((d) => `<option value="${d.decade}"${String(d.decade) === sel ? ' selected' : ''}>${d.decade}s (${d.count})</option>`)
    .join('');
  fromSel.innerHTML = opts(saved.from, 'Any');
  toSel.innerHTML = opts(saved.to, 'Any');
}

function render(data) {
  countEl.textContent = data.total
    ? `${data.matching} of ${data.total} unwatched films in range`
    : '';
  if (!pick) {
    cardEl.innerHTML = `<div class="roll-empty">${data.total ? 'No unwatched films in that range.' : 'Couldn’t reach Jellyfin.'}</div>`;
    return;
  }
  const p = pick;
  const meta = [
    p.year,
    p.runtimeMin ? `${Math.floor(p.runtimeMin / 60)}h ${String(p.runtimeMin % 60).padStart(2, '0')}m` : '',
    p.rating ? `★ ${p.rating.toFixed(1)}` : '',
  ].filter(Boolean).join(' · ');
  cardEl.innerHTML = `
    <div class="roll-card">
      ${p.hasImage ? `<img class="roll-poster" src="/api/jellyfin/image/${esc(p.id)}?w=400" alt="">` : ''}
      <div class="roll-title">${esc(p.title)}</div>
      <div class="roll-meta">${esc(meta)}</div>
      ${p.directors.length ? `<div class="roll-dir">dir. ${esc(p.directors.join(', '))}</div>` : ''}
      ${p.genres.length ? `<div class="roll-genres">${p.genres.slice(0, 4).map((g) => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
      ${p.overview ? `<div class="roll-overview">${esc(p.overview)}</div>` : ''}
      <a class="roll-open" href="${jellyfinItemUrl(p.id, p.serverId)}" target="_blank" rel="noopener noreferrer">OPEN IN JELLYFIN ↗</a>
    </div>`;
}

async function roll() {
  if (rolling) return;
  rolling = true;
  rollBtn.disabled = true;
  rollBtn.classList.add('spin');
  let from = fromSel.value, to = toSel.value;
  // Let a backwards range (from 1990s to 1960s) mean what it obviously does.
  if (from && to && +from > +to) [from, to] = [to, from];
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (pick) q.set('exclude', pick.id);
  try {
    const data = await (await fetch(`/api/jellyfin/roll?${q}`)).json();
    fillDecades(data.decades || []);
    pick = data.pick;
    render(data);
  } catch {
    cardEl.innerHTML = '<div class="roll-empty">Couldn’t reach Jellyfin.</div>';
  } finally {
    rolling = false;
    rollBtn.disabled = false;
    rollBtn.classList.remove('spin');
  }
}

async function refresh() {
  if (!cardEl || pick) return;
  await roll();
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-roll scrollable';
  root.id = 'panelRoll';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone roll-zone">
        <div class="roll-critter critter roll-c0">🎲</div>
        <div class="roll-critter critter roll-c1">🎬</div>
        <div class="roll-critter critter roll-c2">🎲</div>
      </div>
      <div class="section-title-roll">ROLL A FILM</div>
      <div class="roll-controls">
        <label>From <select class="roll-from"><option value="">Any</option></select></label>
        <label>To <select class="roll-to"><option value="">Any</option></select></label>
        <button class="roll-btn">ROLL</button>
      </div>
      <div class="roll-count"></div>
      <div class="roll-result"></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  fromSel = root.querySelector('.roll-from');
  toSel = root.querySelector('.roll-to');
  rollBtn = root.querySelector('.roll-btn');
  cardEl = root.querySelector('.roll-result');
  countEl = root.querySelector('.roll-count');

  // Seed the dropdowns with the remembered range so the very first roll
  // honours it; fillDecades() replaces these with the real list.
  const saved = loadRange();
  if (saved.from) fromSel.insertAdjacentHTML('beforeend', `<option value="${esc(saved.from)}" selected>${esc(saved.from)}s</option>`);
  if (saved.to) toSel.insertAdjacentHTML('beforeend', `<option value="${esc(saved.to)}" selected>${esc(saved.to)}s</option>`);

  rollBtn.addEventListener('click', roll);
  for (const sel of [fromSel, toSel]) {
    sel.addEventListener('change', () => { saveRange(); roll(); });
  }
  return root;
}

export default { id: 'roll', mount, refresh, onShow: refresh };
