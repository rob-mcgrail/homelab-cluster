import { PANELS as DOTS } from '../config.js';
import { esc, renderTriageMd } from '../utils.js';

const BIRDS = ['🕊️', '🦅', '🦆', '🦉', '🦢', '🐦', '🦜', '🐦‍⬛', '🪿', '🦩'];

function birdExplosion() {
  for (let i = 0; i < 40; i++) {
    const b = document.createElement('div');
    b.textContent = BIRDS[Math.floor(Math.random() * BIRDS.length)];
    b.style.cssText = `
      position:fixed; font-size:${1 + Math.random() * 2.2}rem; z-index:9999;
      left:${Math.random() * 100}vw; top:${50 + (Math.random() - 0.5) * 30}vh;
      pointer-events:none; user-select:none; line-height:1;
      animation: birdFlight ${1 + Math.random() * 1.4}s cubic-bezier(.2,.85,.3,1) forwards;
      --tx:${(Math.random() - 0.5) * 500}px;
      --ty:${-280 - Math.random() * 540}px;
      --rot:${(Math.random() - 0.5) * 720}deg;
    `;
    document.body.appendChild(b);
    b.addEventListener('animationend', () => b.remove());
  }
}

let root, listEl, filter = 'recs';
let cachedRecs = null;
let cachedWatched = null;
let cachedThoughts = null;

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function fmtAge(epoch) {
  if (!epoch) return '';
  const d = Math.max(0, Date.now() / 1000 - epoch);
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

async function setRecStatus(recId, status) {
  try {
    await fetch(`/api/recs/${encodeURIComponent(recId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (status !== 'pending') birdExplosion();
    await loadRecs();
  } catch {}
}

async function sendToMoviebot(rec, btn) {
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch(`/api/recs/${encodeURIComponent(rec.id)}/send-to-moviebot`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error();
    birdExplosion();
    await loadRecs();
  } catch {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Send to Movie Bot'; btn.disabled = false; }, 2500);
  }
}

async function saveThoughts(movieId, title, year, textarea, btn) {
  const thoughts = textarea.value.trim();
  if (!thoughts) return;
  btn.disabled = true;
  try {
    const res = await fetch('/api/movie-thoughts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movieId, title, year, thoughts }),
    });
    if (!res.ok) throw new Error();
    birdExplosion();
    btn.classList.add('saved');
    btn.textContent = 'Saved';
    setTimeout(() => { btn.classList.remove('saved'); btn.textContent = 'Save'; btn.disabled = false; }, 2000);
  } catch {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 2000);
  }
}

function reflectionBox() {
  return `
    <div class="reflection-box">
      <div class="recs-meta">What do you think about movies</div>
      <textarea class="reflection-text"></textarea>
      <button class="reflection-save">Add to AI enhanced recommendation matrix</button>
    </div>
  `;
}

function wireReflection(container) {
  const ta = container.querySelector('.reflection-text');
  const btn = container.querySelector('.reflection-save');
  if (!ta || !btn) return;
  btn.addEventListener('click', async () => {
    const thoughts = ta.value.trim();
    if (!thoughts) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/movie-thoughts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thoughts }),
      });
      if (!res.ok) throw new Error();
      birdExplosion();
      ta.value = '';
      btn.classList.add('saved');
      btn.textContent = 'Saved';
      setTimeout(() => { btn.classList.remove('saved'); btn.textContent = 'Add to AI enhanced recommendation matrix'; btn.disabled = false; }, 1800);
    } catch {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Add to AI enhanced recommendation matrix'; btn.disabled = false; }, 2000);
    }
  });
}

function renderRecs() {
  const recs = cachedRecs;
  if (!recs) { listEl.innerHTML = ''; return; }
  if (!recs.length) {
    listEl.innerHTML = reflectionBox() + '<div class="recs-empty">No recommendations yet. The next run generates them.</div>';
    wireReflection(listEl);
    return;
  }
  const pending  = recs.filter(r => r.status === 'pending');
  const reviewed = recs.filter(r => r.status === 'seen-good' || r.status === 'seen-bad');

  const renderOne = (r) => `
    <div class="rec-item ${r.status}" data-id="${esc(r.id)}" data-source="${esc(r.source || 'new')}">
      ${r.status !== 'pending' ? `<div class="rec-status ${r.status}">${r.status === 'seen-good' ? 'Seen · good' : 'Seen · bad'}</div>` : ''}
      <div class="rec-title">${esc(r.title)}<span class="rec-year">${r.year ? `(${r.year})` : ''}</span></div>
      <div class="rec-pitch">${esc(r.pitch || '')}</div>
      <div class="rec-meta">${esc(r.runId || '')} · ${fmtAge(r.createdAt)}</div>
      <div class="rec-actions">
        ${r.status === 'pending' && (r.source || 'new') === 'new'
          ? (r.sent
              ? `<button class="rec-btn send sent" disabled>✓ Sent to Movie Bot</button>`
              : `<button class="rec-btn send">Send to Movie Bot</button>`)
          : ''}
        ${r.status === 'pending' && !r.sent
          ? `<button class="rec-btn good" data-action="seen-good">seen + good</button>
             <button class="rec-btn bad"  data-action="seen-bad">seen + bad</button>`
          : ''}
        ${r.status !== 'pending'
          ? `<button class="rec-btn reset" data-action="pending">undo</button>`
          : ''}
      </div>
    </div>
  `;

  const sections = [reflectionBox()];
  if (pending.length) {
    const pendingNew = pending.filter(r => (r.source || 'new') === 'new');
    const pendingLib = pending.filter(r => r.source === 'library');
    if (pendingLib.length) {
      sections.push(`<div class="recs-meta" style="margin-top:1rem">Watch from your library · ${pendingLib.length}</div>${pendingLib.map(renderOne).join('')}`);
    }
    if (pendingNew.length) {
      sections.push(`<div class="recs-meta" style="margin-top:1.25rem">To download · ${pendingNew.length}</div>${pendingNew.map(renderOne).join('')}`);
    }
  } else {
    sections.push(`<div class="recs-empty">No pending recs right now.</div>`);
  }
  if (reviewed.length) {
    sections.push(`<div class="recs-meta" style="margin-top:1.25rem">Reviewed · ${reviewed.length}</div>${reviewed.slice(0, 10).map(renderOne).join('')}`);
  }
  listEl.innerHTML = sections.join('');
  wireReflection(listEl);

  const recsById = new Map(recs.map(r => [r.id, r]));
  listEl.querySelectorAll('.rec-item').forEach(card => {
    const rec = recsById.get(card.dataset.id);
    card.querySelectorAll('.rec-btn').forEach(btn => {
      if (btn.classList.contains('send')) {
        btn.addEventListener('click', () => rec && sendToMoviebot(rec, btn));
      } else if (btn.dataset.action) {
        btn.addEventListener('click', () => setRecStatus(card.dataset.id, btn.dataset.action));
      }
    });
  });
}

function renderWatched() {
  const items = cachedWatched;
  if (!items) { listEl.innerHTML = ''; return; }
  if (!items.length) {
    listEl.innerHTML = '<div class="recs-empty">Nothing recently finished yet.</div>';
    return;
  }
  listEl.innerHTML = items.map((m, idx) => `
    <div class="watched-item" data-idx="${idx}">
      <div class="watched-title">${esc(m.title)}<span class="watched-year">${m.year ? `(${m.year})` : ''}</span></div>
      <div class="watched-meta">watched ${m.watchedAt ? m.watchedAt.slice(0, 10) : '—'}</div>
      <textarea class="watched-thoughts" placeholder="Thoughts on this one…"></textarea>
      <button class="watched-save">Save</button>
    </div>
  `).join('');

  listEl.querySelectorAll('.watched-item').forEach(card => {
    const idx = +card.dataset.idx;
    const m = items[idx];
    const ta = card.querySelector('.watched-thoughts');
    const btn = card.querySelector('.watched-save');
    btn.addEventListener('click', () => saveThoughts(m.movieId, m.title, m.year, ta, btn));
  });
}

function renderThoughts() {
  const runs = cachedThoughts;
  if (!runs) { listEl.innerHTML = ''; return; }
  if (!runs.length) {
    listEl.innerHTML = '<div class="recs-empty">No runs yet — recs bot hasn\'t written anything.</div>';
    return;
  }
  listEl.innerHTML = runs.map(r => `
    <div class="rec-item">
      <div class="rec-meta">${esc(r.id)}</div>
      <div class="rec-thoughts-body">${renderTriageMd(r.content)}</div>
    </div>
  `).join('');
}

function render() {
  // Don't blow away the panel if the user is mid-type in any textarea
  // inside it — the auto-poll would otherwise wipe free-form input.
  const a = document.activeElement;
  if (a && root && root.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return;
  if (filter === 'history') renderWatched();
  else if (filter === 'thoughts') renderThoughts();
  else renderRecs();
}

async function loadRecs() {
  try {
    const res = await fetch('/api/recs');
    cachedRecs = await res.json();
    if (filter === 'recs') render();
  } catch {
    cachedRecs = [];
  }
}

async function loadWatched() {
  try {
    const res = await fetch('/api/recently-watched');
    cachedWatched = await res.json();
    if (filter === 'history') render();
  } catch {
    cachedWatched = [];
  }
}

async function loadThoughts() {
  try {
    const res = await fetch('/api/recs-runs');
    cachedThoughts = await res.json();
    if (filter === 'thoughts') render();
  } catch {
    cachedThoughts = [];
  }
}

async function refresh() {
  await Promise.all([loadRecs(), loadWatched(), loadThoughts()]);
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-recs scrollable';
  root.id = 'panelRecs';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone"><div class="seagull critter">🕊️</div></div>
      <div class="section-title-teal">RECS BOT</div>
      <div class="recs-filters">
        <button class="filter-btn active" data-f="recs">Recs</button>
        <button class="filter-btn" data-f="history">History</button>
        <button class="filter-btn" data-f="thoughts">Recs thoughts</button>
      </div>
      <div class="recs-list"></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  listEl = root.querySelector('.recs-list');
  root.querySelectorAll('.recs-filters .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.recs-filters .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filter = btn.dataset.f;
      render();
    });
  });
  return root;
}

export default { id: 'recs', mount, refresh, onShow: refresh };
