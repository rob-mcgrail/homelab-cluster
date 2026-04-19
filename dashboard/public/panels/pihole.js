import { esc, fmtAgo, fmtLease } from '../utils.js';

const DOTS = 6;

let root, listEl;

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

async function refresh() {
  try {
    const res = await fetch('/api/pihole-clients');
    const items = await res.json();
    if (!items.length) {
      listEl.innerHTML = '<div class="client-empty">No client data yet.</div>';
      return;
    }
    const maxTotal = Math.max(1, ...items.map(x => x.total));
    listEl.innerHTML = items.map(c => {
      const totalPct = Math.round((c.total / maxTotal) * 100);
      const blockedFrac = c.total > 0 ? c.blocked / c.total : 0;
      const blockedWidth = totalPct * blockedFrac;
      const allowedWidth = totalPct - blockedWidth;
      const displayName = c.name && c.name !== c.ip ? c.name.replace(/\.lan$/i, '') : c.ip;
      const ipBadge = (c.name && c.name !== c.ip) ? `<span class="client-ip">${esc(c.ip)}</span>` : '';
      return `
        <div class="client-card">
          <div><span class="client-name">${esc(displayName)}</span>${ipBadge}</div>
          <div class="client-counts">
            <span><span class="allowed">${c.permitted.toLocaleString()}</span> allowed</span>
            <span><span class="blocked">${c.blocked.toLocaleString()}</span> blocked</span>
            <span>${c.blockedPct}% block rate</span>
            <span>last: ${fmtAgo(c.lastSeen)}</span>
            <span>${fmtLease(c.leaseExpiry)}</span>
          </div>
          <div class="client-bar">
            <div class="client-bar-allowed" style="width:${allowedWidth}%"></div>
            <div class="client-bar-blocked" style="width:${blockedWidth}%"></div>
          </div>
        </div>
      `;
    }).join('');
  } catch {
    listEl.innerHTML = '<div class="client-empty">Could not load clients.</div>';
  }
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-pihole scrollable';
  root.id = 'panelPihole';
  root.innerHTML = `
    <div class="spooky-zone">
      <div class="spooky critter spooky-tl">💀</div>
      <div class="spooky critter spooky-tr">🦇</div>
      <div class="spooky critter spooky-bl">🦇</div>
      <div class="spooky critter spooky-br">💀</div>
    </div>
    <div class="panel-inner">
      <div class="critter-zone"><div class="spider critter">🕷️</div></div>
      <div class="section-title-red">CLIENTS</div>
      <div class="client-list"></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  listEl = root.querySelector('.client-list');
  return root;
}

export default { id: 'pihole', mount, refresh, onShow: refresh };
