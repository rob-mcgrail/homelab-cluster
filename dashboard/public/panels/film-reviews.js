import { PANELS as DOTS } from '../config.js';
import { esc, renderTriageMd } from '../utils.js';

let root, listEl;
let cached = null;
const expanded = new Set();

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function firstSentence(body) {
  const trimmed = (body || '').trim().replace(/^---\s*\n[\s\S]*?\n---\s*\n+/, '');
  const m = trimmed.match(/^[\s\S]{40,260}?[.!?](?=\s|$)/);
  return m ? m[0] : trimmed.slice(0, 220);
}

// Use the bot-written blurb when present; fall back to first sentence
// for older reviews predating the blurb field.
function previewFor(r) {
  return (r.blurb && r.blurb.trim()) || firstSentence(r.body);
}

function scoreRow(r) {
  const cell = (label, n, emoji) => {
    if (n == null) return '';
    return `
      <div class="rv-score">
        <div class="rv-score-axis">${label}</div>
        <div class="rv-score-num">${n}<span class="rv-score-denom">/10</span> ${esc(emoji || '')}</div>
      </div>`;
  };
  return `
    <div class="rv-scores">
      ${cell('formal execution', r.scoreExecution, r.scoreExecutionEmoji)}
      ${cell('story', r.scoreStory, r.scoreStoryEmoji)}
      ${cell('future · past', r.scoreImpact, r.scoreImpactEmoji)}
    </div>`;
}

function render() {
  if (!cached) { listEl.innerHTML = ''; return; }
  if (!cached.length) {
    listEl.innerHTML = `<div class="rv-empty">The critic hasn't filed yet.<br><span class="rv-empty-sub">First review arrives tomorrow at 04:00.</span></div>`;
    return;
  }
  listEl.innerHTML = cached.map(r => {
    const open = expanded.has(r.id);
    const head = `
      <div class="rv-head" role="button" tabindex="0">
        <div class="rv-title-line">
          <span class="rv-title">${esc(r.title)}</span>
          ${r.year ? `<span class="rv-year">(${esc(r.year)})</span>` : ''}
        </div>
        <div class="rv-meta">${fmtDate(r.createdAt)}</div>
        ${scoreRow(r)}
      </div>`;
    const closed = `<div class="rv-preview">${esc(previewFor(r))}</div>`;
    const opened = `<div class="rv-body">${renderTriageMd(r.body)}</div>`;
    return `
      <article class="rv-item ${open ? 'rv-open' : ''}" data-id="${esc(r.id)}">
        ${head}
        ${open ? opened : closed}
      </article>`;
  }).join('');
  listEl.querySelectorAll('.rv-item').forEach(card => {
    const head = card.querySelector('.rv-head');
    const toggle = () => {
      const id = card.dataset.id;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      render();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

async function refresh() {
  try {
    const res = await fetch('/api/film-reviews');
    cached = await res.json();
    render();
  } catch {
    cached = [];
    listEl.innerHTML = '<div class="rv-empty">Could not load reviews.</div>';
  }
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-film-reviews scrollable';
  root.id = 'panelFilmReviews';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone"><div class="owl critter">🦉</div></div>
      <div class="section-title-sepia">REVIEWS</div>
      <div class="rv-list"><div class="rv-empty">Loading…</div></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  listEl = root.querySelector('.rv-list');
  return root;
}

export default { id: 'film-reviews', mount, refresh, onShow: refresh };
