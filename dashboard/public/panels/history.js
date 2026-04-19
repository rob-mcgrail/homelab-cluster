import { esc, renderTriageMd } from '../utils.js';

const DOTS = 6;

let root, listEl, filter = 'requests';
let cachedRequests = null, cachedTriage = null;

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function render() {
  if (filter === 'triage') {
    const runs = cachedTriage;
    if (!runs) { listEl.innerHTML = ''; return; }
    if (!runs.length) {
      listEl.innerHTML = '<div class="history-empty">No triage runs yet.</div>';
      return;
    }
    listEl.innerHTML = runs.map(r => `
      <div class="history-item">
        <div class="history-prompt">${esc(r.id)}</div>
        <div class="history-result">${renderTriageMd(r.content)}</div>
      </div>
    `).join('');
  } else {
    const items = cachedRequests;
    if (!items) { listEl.innerHTML = ''; return; }
    if (!items.length) {
      listEl.innerHTML = '<div class="history-empty">No prompts yet.</div>';
      return;
    }
    listEl.innerHTML = items.map(item => `
      <div class="history-item${item.pending ? ' pending' : ''}">
        <div class="history-prompt">${esc(item.prompt)}</div>
        ${item.pending
          ? `<div class="history-waiting">Waiting for Movie Bot...</div>`
          : item.result
            ? `<div class="history-result">${marked.parse(item.result)}</div>`
            : `<div class="history-pending">No response recorded.</div>`}
      </div>
    `).join('');
  }
}

async function refresh() {
  try {
    const [h, t] = await Promise.all([fetch('/api/history'), fetch('/api/triage-runs')]);
    cachedRequests = await h.json();
    cachedTriage = await t.json();
    render();
  } catch {
    listEl.innerHTML = '<div class="history-empty">Could not load history.</div>';
  }
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-history scrollable';
  root.id = 'panelHistory';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone"><div class="fish critter">🐟</div></div>
      <div class="section-title-green">RECENT</div>
      <div class="history-filters">
        <button class="filter-btn active" data-f="requests">Requests</button>
        <button class="filter-btn" data-f="triage">Triage</button>
      </div>
      <div class="history-list"></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  listEl = root.querySelector('.history-list');
  root.querySelectorAll('.history-filters .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.history-filters .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filter = btn.dataset.f;
      render();
    });
  });
  return root;
}

export default { id: 'history', mount, refresh, onShow: refresh };
