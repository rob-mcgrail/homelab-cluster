import { PANELS as DOTS } from '../config.js';
import { esc, fmtBytes, barClass } from '../utils.js';

let root, listEl;

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function stateBadge(state) {
  if (state === 'running')    return '<span class="badge badge-running">running</span>';
  if (state === 'exited')     return '<span class="badge badge-exited">exited</span>';
  if (state === 'paused')     return '<span class="badge badge-paused">paused</span>';
  if (state === 'restarting') return '<span class="badge badge-restarting">restarting</span>';
  return `<span class="badge badge-paused">${esc(state)}</span>`;
}

function renderRow(c) {
  const running = c.state === 'running';
  const cpu = running && c.cpuPct != null ? `${c.cpuPct.toFixed(1)}%` : '—';
  const memLine = running && c.memTotal
    ? `${fmtBytes(c.memUsed)} / ${fmtBytes(c.memTotal)}`
    : '—';
  const cpuBar = running && c.cpuPct != null
    ? `<div class="docker-bar"><div class="docker-bar-fill ${barClass(Math.min(100, c.cpuPct))}" style="width:${Math.min(100, c.cpuPct)}%"></div></div>`
    : '';
  const memBar = running && c.memPct != null
    ? `<div class="docker-bar"><div class="docker-bar-fill ${barClass(c.memPct)}" style="width:${Math.min(100, c.memPct)}%"></div></div>`
    : '';
  return `
    <div class="docker-item ${running ? '' : 'docker-item-stopped'}">
      <div class="docker-head">
        <div class="docker-name">${esc(c.name)}</div>
        ${stateBadge(c.state)}
      </div>
      <div class="docker-metrics">
        <div class="docker-metric">
          <div class="docker-metric-label">CPU</div>
          <div class="docker-metric-value">${cpu}</div>
          ${cpuBar}
        </div>
        <div class="docker-metric">
          <div class="docker-metric-label">Memory${running && c.memPct != null ? ` · ${c.memPct.toFixed(0)}%` : ''}</div>
          <div class="docker-metric-value">${memLine}</div>
          ${memBar}
        </div>
      </div>
    </div>
  `;
}

async function refresh() {
  try {
    const res = await fetch('/api/docker-stats');
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.length) {
      listEl.innerHTML = '<div class="docker-empty">No containers.</div>';
      return;
    }
    listEl.innerHTML = data.map(renderRow).join('');
  } catch {
    listEl.innerHTML = '<div class="docker-empty">Could not load container stats.</div>';
  }
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-docker scrollable';
  root.id = 'panelDocker';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone"><div class="whale critter">🐳</div></div>
      <div class="section-title-cyan">CONTAINERS</div>
      <div class="docker-list"><div class="docker-empty">Loading…</div></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  listEl = root.querySelector('.docker-list');
  return root;
}

export default { id: 'docker', mount, refresh, onShow: refresh };
