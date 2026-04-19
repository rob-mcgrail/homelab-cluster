import { esc, fmtBytes, fmtRate, fmtTime, fmtMbps, barClass } from '../utils.js';

const DOTS = 6;

let root, statusCardsEl, streamsEl, bugZoneEl;
let bugs = [];
let bugsRunning = false;
let bugLast = 0;

const BOUNDS = { xMin: 2, xMax: 92, yMin: 67, yMax: 95 };
const STARTLE_R = 5;
const REPEL_R = 8;

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function spawnBug() {
  if (!bugZoneEl) return;
  const emojis = ['🪲', '🦗', '🐜', '🪳', '🐛'];
  const el = document.createElement('div');
  el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
  el.className = 'bug critter';
  el.style.fontSize = (0.9 + Math.random() * 0.5) + 'rem';
  el.style.opacity = 0.3 + Math.random() * 0.35;
  el.style.transition = 'left 0.08s linear, top 0.08s linear';
  bugZoneEl.appendChild(el);

  const angle = Math.random() * Math.PI * 2;
  bugs.push({
    el,
    x: BOUNDS.xMin + Math.random() * (BOUNDS.xMax - BOUNDS.xMin),
    y: BOUNDS.yMin + Math.random() * (BOUNDS.yMax - BOUNDS.yMin),
    dir: angle,
    base: 0.8 + Math.random() * 1.5,
    state: 'scuttle',
    timer: 0.5 + Math.random() * 2,
    micro: 0,
    twitchX: 0,
    twitchY: 0,
  });
}

function tickBugs(now) {
  if (!bugsRunning) return;
  const dt = Math.min((now - bugLast) / 1000, 0.1);
  bugLast = now;

  for (let i = 0; i < bugs.length; i++) {
    const b = bugs[i];
    b.timer -= dt;
    b.micro -= dt;

    let repX = 0, repY = 0, nearest = Infinity;
    for (let j = 0; j < bugs.length; j++) {
      if (i === j) continue;
      const dx = b.x - bugs[j].x, dy = b.y - bugs[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < REPEL_R && d > 0.1) {
        const f = ((REPEL_R - d) / REPEL_R) * 2.5;
        repX += (dx / d) * f;
        repY += (dy / d) * f;
      }
      if (d < nearest) nearest = d;
    }

    if (nearest < STARTLE_R && b.state !== 'dash') {
      b.state = 'dash';
      b.timer = 0.15 + Math.random() * 0.25;
      b.dir = Math.atan2(repY, repX);
    }

    switch (b.state) {
      case 'scuttle':
        if (b.micro <= 0) {
          const wobble = (Math.random() - 0.5) * 1.2;
          const stepDir = b.dir + wobble;
          const stepSize = b.base * (0.3 + Math.random() * 0.5);
          b.x += Math.cos(stepDir) * stepSize + repX * 0.3;
          b.y += Math.sin(stepDir) * stepSize + repY * 0.3;
          if (Math.random() < 0.3) b.dir += (Math.random() - 0.5) * 1.5;
          b.micro = 0.06 + Math.random() * 0.18;
        }
        if (b.timer <= 0) {
          b.state = 'pause';
          b.timer = 0.4 + Math.random() * 2.5;
        }
        break;
      case 'pause':
        if (Math.random() < 0.02) {
          b.twitchX = (Math.random() - 0.5) * 0.3;
          b.twitchY = (Math.random() - 0.5) * 0.3;
        } else {
          b.twitchX *= 0.9; b.twitchY *= 0.9;
        }
        b.x += b.twitchX * dt * 5 + repX * dt * 0.4;
        b.y += b.twitchY * dt * 5 + repY * dt * 0.4;
        if (b.timer <= 0) {
          b.state = 'scuttle';
          b.timer = 0.5 + Math.random() * 2.5;
          b.dir += (Math.random() - 0.5) * 2.5;
          b.micro = 0;
        }
        break;
      case 'dash': {
        const dashSpd = b.base * (4 + Math.random() * 2);
        b.x += Math.cos(b.dir) * dashSpd * dt + repX * dt;
        b.y += Math.sin(b.dir) * dashSpd * dt + repY * dt;
        if (b.timer <= 0) {
          b.state = 'pause';
          b.timer = 0.3 + Math.random() * 1;
        }
        break;
      }
    }

    if (b.x < BOUNDS.xMin) { b.x = BOUNDS.xMin + 0.5; b.dir = Math.PI - b.dir; }
    if (b.x > BOUNDS.xMax) { b.x = BOUNDS.xMax - 0.5; b.dir = Math.PI - b.dir; }
    if (b.y < BOUNDS.yMin) { b.y = BOUNDS.yMin + 0.5; b.dir = -b.dir; }
    if (b.y > BOUNDS.yMax) { b.y = BOUNDS.yMax - 0.5; b.dir = -b.dir; }

    b.el.style.left = b.x + '%';
    b.el.style.top = b.y + '%';
  }

  requestAnimationFrame(tickBugs);
}

function startBugs() {
  if (bugsRunning) return;
  if (bugs.length === 0) { spawnBug(); spawnBug(); spawnBug(); }
  bugsRunning = true;
  bugLast = performance.now();
  requestAnimationFrame(tickBugs);
}

function streamBadge(s) {
  if (s.output) return '<span class="badge badge-transcode">TRANSCODE</span>';
  if (s.playMethod === 'DirectStream') return '<span class="badge badge-direct">DIRECT STREAM</span>';
  return '<span class="badge badge-direct">DIRECT PLAY</span>';
}

function renderStream(s) {
  const pct = s.durationMs > 0 ? Math.round((s.positionMs / s.durationMs) * 100) : 0;
  const src = s.source, out = s.output;
  const srcLine = [
    src.container && src.container.toUpperCase(),
    src.videoCodec && src.videoCodec.toUpperCase(),
    src.resolution,
    src.audioCodec && `${src.audioCodec.toUpperCase()}${src.audioChannels ? ' ' + src.audioChannels + 'ch' : ''}`,
  ].filter(Boolean).join(' · ');
  const outLine = out ? [
    out.isVideoDirect ? 'video: copy' : (out.videoCodec && `video: ${out.videoCodec.toUpperCase()}`),
    out.isAudioDirect ? 'audio: copy' : (out.audioCodec && `audio: ${out.audioCodec.toUpperCase()}`),
    fmtMbps(out.bitrate),
  ].filter(Boolean).join(' · ') : '';
  const reasons = out && out.reasons.length ? out.reasons.join(', ') : '';
  const sub = s.subtitle ? `${s.subtitle.language || '?'}${s.subtitle.isExternal ? ' (ext)' : ''}${s.subtitle.codec ? ' · ' + s.subtitle.codec : ''}` : 'off';
  return `
    <div class="stream-card">
      <div class="stream-title">${esc(s.title)}</div>
      <div class="stream-who">${esc(s.user)} · ${esc(s.device || s.client)}${s.isPaused ? ' · paused' : ''}</div>
      <div class="stream-meta">
        <div>${streamBadge(s)} ${out ? '<span style="color:#8b6adf">' + esc(reasons) + '</span>' : ''}</div>
        <div><span class="label">source</span>${esc(srcLine)}</div>
        ${src.file ? `<div><span class="label">file</span>${esc(src.file)}</div>` : ''}
        ${out ? `<div><span class="label">output</span>${esc(outLine)}</div>` : ''}
        <div><span class="label">subs</span>${esc(sub)}</div>
        <div><span class="label">position</span>${fmtTime(s.positionMs)} / ${fmtTime(s.durationMs)}</div>
      </div>
      <div class="stream-bar"><div class="stream-bar-fill" style="width:${pct}%"></div></div>
    </div>
  `;
}

async function loadStreams() {
  try {
    const res = await fetch('/api/jellyfin-sessions');
    const items = await res.json();
    streamsEl.innerHTML = items.length ? items.map(renderStream).join('') : '';
  } catch {
    streamsEl.innerHTML = '';
  }
}

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    if (s.error) throw new Error();
    statusCardsEl.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Load Average</div>
        <div class="stat-value">${s.load[0]}</div>
        <div class="load-chips">
          <div class="load-chip">${s.load[0]} <small>1m</small></div>
          <div class="load-chip">${s.load[1]} <small>5m</small></div>
          <div class="load-chip">${s.load[2]} <small>15m</small></div>
        </div>
        <div class="stat-detail">${s.cores} cores</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Memory</div>
        <div class="stat-value">${s.mem.pct}%</div>
        <div class="stat-detail">${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}</div>
        <div class="stat-bar"><div class="${barClass(s.mem.pct)}" style="width:${s.mem.pct}%"></div></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Swap</div>
        <div class="stat-value">${s.swap.pct}%</div>
        <div class="stat-detail">${fmtBytes(s.swap.used)} / ${fmtBytes(s.swap.total)}</div>
        <div class="stat-bar"><div class="${barClass(s.swap.pct)}" style="width:${s.swap.pct}%"></div></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Storage — /srv/data</div>
        <div class="stat-value">${s.disk.pct}%</div>
        <div class="stat-detail">${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}</div>
        <div class="stat-bar"><div class="${barClass(s.disk.pct)}" style="width:${s.disk.pct}%"></div></div>
      </div>
      ${s.qbit ? `
      <div class="stat-card">
        <div class="stat-label">Torrents — now</div>
        <div class="stat-value">${fmtRate(s.qbit.dlSpeed)}/s <small style="opacity:0.6">↓</small></div>
        <div class="stat-detail">↑ ${fmtRate(s.qbit.upSpeed)}/s</div>
        <div class="stat-detail" style="margin-top:0.4rem">session: ${fmtBytes(s.qbit.dlSession)} down · ${fmtBytes(s.qbit.upSession)} up</div>
      </div>` : ''}
    `;
  } catch {
    statusCardsEl.innerHTML = '<div class="torrent-empty">Could not load status.</div>';
  }
}

async function refresh() {
  await Promise.all([loadStatus(), loadStreams()]);
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-status scrollable';
  root.id = 'panelStatus';
  root.innerHTML = `
    <div class="bug-zone"></div>
    <div class="panel-inner">
      <div class="critter-zone"><div class="snail critter">🐌</div></div>
      <div class="section-title-purple">SERVER</div>
      <div class="streams-inline"></div>
      <div class="status-cards"></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  statusCardsEl = root.querySelector('.status-cards');
  streamsEl = root.querySelector('.streams-inline');
  bugZoneEl = root.querySelector('.bug-zone');
  return root;
}

export default { id: 'status', mount, refresh, onShow: () => { refresh(); startBugs(); } };
