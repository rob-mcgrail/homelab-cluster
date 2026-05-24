import { PANELS as DOTS } from '../config.js';
import { esc, renderTriageMd } from '../utils.js';

let root, listEl, commissionModal;
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

function renderPendingItem(r) {
  return `
    <article class="rv-item rv-pending">
      <div class="rv-head">
        <div class="rv-title-line">
          <span class="rv-title">${esc(r.title)}</span>
          ${r.year ? `<span class="rv-year">(${esc(r.year)})</span>` : ''}
          <span class="rv-pending-badge">in progress</span>
        </div>
        <div class="rv-meta">${fmtDate(r.createdAt)} · commissioned</div>
      </div>
      ${r.blurb ? `<div class="rv-preview">${esc(r.blurb)}</div>` : ''}
    </article>`;
}

function render() {
  if (!cached) { listEl.innerHTML = ''; return; }
  if (!cached.length) {
    listEl.innerHTML = `<div class="rv-empty">The critic hasn't filed yet.<br><span class="rv-empty-sub">First review arrives tomorrow at 04:00.</span></div>`;
    return;
  }
  listEl.innerHTML = cached.map(r => {
    if (r.pending) return renderPendingItem(r);
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
  listEl.querySelectorAll('.rv-item:not(.rv-pending)').forEach(card => {
    const head = card.querySelector('.rv-head');
    if (!head) return;
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

// ---- Commission modal ----

function buildModal() {
  const overlay = document.createElement('div');
  overlay.className = 'rv-modal-overlay';
  overlay.innerHTML = `
    <div class="rv-modal" role="dialog" aria-modal="true" aria-label="Commission a review">
      <div class="rv-modal-head">
        <div class="rv-modal-title">Commission a review</div>
        <button class="rv-modal-close" aria-label="Close">×</button>
      </div>
      <form class="rv-form">
        <label class="rv-field">
          <span class="rv-field-label">Title</span>
          <input class="rv-input" name="title" required maxlength="200" autocomplete="off" />
        </label>
        <label class="rv-field">
          <span class="rv-field-label">Year <span class="rv-field-hint">optional but useful</span></span>
          <input class="rv-input" name="year" pattern="\\d{4}" maxlength="4" autocomplete="off" inputmode="numeric" />
        </label>
        <label class="rv-field">
          <span class="rv-field-label">Your take</span>
          <textarea class="rv-input rv-textarea" name="take" required rows="6" maxlength="4000"
            placeholder="The angle you want the writer to start from. They take you seriously."></textarea>
        </label>
        <div class="rv-form-actions">
          <button type="button" class="rv-btn rv-btn-ghost" data-act="cancel">Cancel</button>
          <button type="submit" class="rv-btn rv-btn-primary">Commission</button>
        </div>
        <div class="rv-form-status"></div>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function openCommission() {
  if (!commissionModal) commissionModal = buildModal();
  commissionModal.classList.add('rv-modal-open');
  const form = commissionModal.querySelector('.rv-form');
  const status = commissionModal.querySelector('.rv-form-status');
  status.textContent = '';
  form.reset();

  const close = () => commissionModal.classList.remove('rv-modal-open');
  commissionModal.querySelector('.rv-modal-close').onclick = close;
  commissionModal.querySelector('[data-act="cancel"]').onclick = close;
  commissionModal.onclick = (e) => { if (e.target === commissionModal) close(); };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const payload = {
      title: data.get('title').toString().trim(),
      year: (data.get('year') || '').toString().trim(),
      take: data.get('take').toString().trim(),
    };
    if (!payload.title || !payload.take) {
      status.textContent = 'Title and take are required.';
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    try {
      const res = await fetch('/api/film-reviews/commission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || res.statusText);
      }
      status.textContent = `Commissioned. Should land in 6–10 minutes.`;
      submitBtn.textContent = 'Sent';
      // Bring back the review list quickly so the pending item shows.
      setTimeout(() => { close(); refresh(); }, 800);
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Commission';
    }
  };
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-film-reviews scrollable';
  root.id = 'panelFilmReviews';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone"><div class="lizard critter">🦎</div></div>
      <div class="rv-header-row">
        <div class="section-title-sepia">REVIEWS</div>
        <button class="rv-commission-btn" type="button">+ Commission</button>
      </div>
      <div class="rv-list"><div class="rv-empty">Loading…</div></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  listEl = root.querySelector('.rv-list');
  root.querySelector('.rv-commission-btn').addEventListener('click', openCommission);
  return root;
}

export default { id: 'film-reviews', mount, refresh, onShow: refresh };
