import { PANELS as DOTS } from '../config.js';
import { esc, fmtAgo, fmtClipDay } from '../utils.js';
import { pushSupported, pushStatus, pushSubscribe, pushUnsubscribe } from '../push.js';

const ALL_ID = 'light.all_floodlights';
const LIGHTS = [
  { id: ALL_ID,                                       name: 'All',        all: true },
  { id: 'light.front_door_floodlight_cam_floodlight', name: 'Front door' },
  { id: 'light.deck_floodlight_cam_floodlight',       name: 'Deck' },
];
// Recording preferences — togglable settings that aren't lights but
// share the same toggle endpoint (server dispatches by entity domain).
const SKIP_DAYTIME_ID = 'input_boolean.skip_daytime_recordings';
const SETTINGS = [
  { id: SKIP_DAYTIME_ID, name: 'Skip daytime clips', hint: 'No recordings 7am–7pm' },
];
const CAMS = [
  { slug: 'front_door', name: 'Front door' },
  { slug: 'deck',       name: 'Deck' },
];
const HA_DASH_URL = 'https://ha.office-computer-online-worldwide.org/lovelace-floodlights/floodlights';

// Phones use a smaller MJPEG variant (960×288) for both tile + modal.
// Mobile Chrome's <img>+multipart/x-mixed-replace handler wedges under
// the full-rate 1920×576 stream — see go2rtc.yaml for the full why.
// `pointer: coarse` is the standard touch-device test; matches
// phones/tablets, not laptops with a touchscreen-and-mouse.
const IS_MOBILE = window.matchMedia('(pointer: coarse)').matches;

let root, listEl;
let state = null; // { configured: bool, lights?: [{entity_id,state}], error?: bool }
let clips = [];   // [{cam, filename, mtimeMs, sizeBytes}, ...]
let panelVisible = false;
// Entity IDs whose toggle is in flight. Reolink takes 1-3s to land a
// command, so we stay in "pending" until the next /api/floodlights
// refresh shows the new authoritative state. Avoids the old optimistic
// flip, which lied about the state for 1-3s after every tap.
const pending = new Set();
const CAM_LABEL = { front_door: 'Front door', deck: 'Deck' };

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

// Tile cam imgs run as live MJPEG streams while the panel is visible —
// startTileStreams() sets src to the stream URL, stopTileStreams()
// clears it so the browser aborts the connection and we don't keep an
// open stream for an off-screen panel.
function startTileStreams() {
  if (!root) return;
  const path = IS_MOBILE ? '/api/camera-preview-mobile/' : '/api/camera-preview/';
  root.querySelectorAll('img.fl-cam-snap').forEach(img => {
    const slug = img.dataset.slug;
    // Tile uses the SD sub stream — much lighter than the HD main
    // stream the modal pulls. The tile is small anyway, and this keeps
    // CPU/GPU near zero when the panel's just sitting visible. Phones
    // get the further-downscaled "-mobile" variant (see top of file).
    if (slug && !img.src.includes(path)) {
      img.src = `${path}${slug}`;
    }
  });
}
function stopTileStreams() {
  if (!root) return;
  root.querySelectorAll('img.fl-cam-snap').forEach(img => {
    img.src = '';
  });
}

async function loadClips() {
  try {
    const r = await fetch('/api/cam-recordings');
    clips = await r.json();
  } catch {
    clips = [];
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/floodlights');
    state = await res.json();
  } catch {
    state = { error: true };
  }
  // Any in-flight toggle is now resolved — HA's state is authoritative.
  pending.clear();
  await loadClips();
  render();
}

// Same /toggle endpoint as the lights, but no ALL_ID propagation
// since settings entities are independent of each other.
async function toggleSetting(entity_id) {
  if (!state || !state.lights) return;
  if (pending.has(entity_id)) return;
  pending.add(entity_id);
  render();
  try {
    const res = await fetch('/api/floodlights/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id }),
    });
    if (!res.ok) throw new Error();
    // input_boolean toggles in HA are instant — no Reolink delay to
    // wait out — so refresh quickly.
    setTimeout(refresh, 200);
  } catch {
    pending.clear();
    render();
  }
}

async function toggle(entity_id) {
  if (!state || !state.lights) return;
  if (pending.has(entity_id)) return; // already in flight

  // Mark every entity whose state may visibly change. Tapping "All"
  // affects both members; tapping a member affects itself + the
  // derived "All" row. Either way, every affected row goes pending
  // until HA confirms the new state.
  if (entity_id === ALL_ID) {
    state.lights.forEach(l => pending.add(l.entity_id));
  } else {
    pending.add(entity_id);
    pending.add(ALL_ID);
  }
  render();

  try {
    const res = await fetch('/api/floodlights/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id }),
    });
    if (!res.ok) throw new Error();
    // Reolink takes 1-3s to actually land a command. Wait long enough
    // that the refresh sees the new state in HA, not the pre-flip one.
    setTimeout(refresh, 1800);
  } catch {
    pending.clear();
    render();
  }
}

function render() {
  if (!state) { listEl.innerHTML = ''; return; }
  if (state.error) {
    listEl.innerHTML = '<div class="fl-empty">Could not reach Home Assistant.</div>';
    return;
  }
  if (!state.configured) {
    listEl.innerHTML = `
      <div class="fl-empty">
        Home Assistant token not configured.
        <div class="fl-hint">Add <code>HASS_TOKEN=...</code> to <code>.api_keys</code> and restart the dashboard.</div>
      </div>`;
    return;
  }
  const byId = new Map(state.lights.map(l => [l.entity_id, l.state]));
  const lightRows = LIGHTS.map(l => {
    const isOn = byId.get(l.id) === 'on';
    const isPending = pending.has(l.id);
    const cls = ['fl-row', isOn ? 'on' : 'off', l.all ? 'fl-row-all' : '', isPending ? 'pending' : ''].filter(Boolean).join(' ');
    return `
      <div class="${cls}" data-id="${esc(l.id)}">
        <div class="fl-name">${esc(l.name)}</div>
        <button class="fl-toggle ${isOn ? 'on' : 'off'} ${isPending ? 'pending' : ''}" aria-pressed="${isOn}" ${isPending ? 'aria-busy="true"' : ''}>
          <span class="fl-indicator"></span>
          <span class="fl-state">${isPending ? '…' : (isOn ? 'ON' : 'OFF')}</span>
        </button>
      </div>
    `;
  }).join('');
  const cams = CAMS.map(c => `
    <div class="fl-cam" data-slug="${esc(c.slug)}" data-name="${esc(c.name)}" role="button" tabindex="0" aria-label="${esc(c.name)} camera (tap for full screen)">
      <img class="fl-cam-snap" data-slug="${esc(c.slug)}" alt="${esc(c.name)}">
      <div class="fl-cam-name">${esc(c.name)}</div>
    </div>
  `).join('');
  // Group clips into events (paired multi-cam captures of the same
  // incident) and render newest-first.
  const events = groupClipsIntoEvents(clips);
  const eventsHtml = events.length
    ? `<div class="fl-clips">
         <div class="fl-clips-title">RECENT CLIPS</div>
         ${events.slice(0, 12).map((ev, idx) => {
           const cams = ev.clips
             .slice()
             .sort((a, b) => a.cam.localeCompare(b.cam))
             .map(c => esc(CAM_LABEL[c.cam] || c.cam))
             .join(' · ');
           const ageS = Math.floor((Date.now() - ev.startMs) / 1000);
           return `
             <div class="fl-clip-row" data-idx="${idx}">
               <div class="fl-clip-cams">${cams}</div>
               <div class="fl-clip-time">
                 <div class="fl-clip-when">${esc(fmtClipDay(ev.startMs))}</div>
                 <div class="fl-clip-ago">${esc(fmtAgo(Math.floor(ev.startMs / 1000)))}</div>
               </div>
             </div>
           `;
         }).join('')}
       </div>`
    : '';

  listEl.innerHTML = lightRows
    + `<div class="fl-cams">${cams}</div>`
    + `<button class="fl-panic" data-state="armed" type="button" aria-label="Panic">
         <span class="fl-panic-label">PANIC</span>
         <span class="fl-panic-hint">tap twice to fire lights + sirens</span>
       </button>`
    + `<button class="fl-silence" data-state="armed" type="button" aria-label="Silence sirens">
         <span class="fl-silence-label">SILENCE SIRENS</span>
       </button>`
    + (SETTINGS.length ? `<div class="fl-settings">
         <div class="fl-settings-title">RECORDING</div>
         ${SETTINGS.map(s => {
           const isOn = byId.get(s.id) === 'on';
           const isPending = pending.has(s.id);
           return `
             <div class="fl-setting-row" data-id="${esc(s.id)}">
               <div class="fl-setting-text">
                 <div class="fl-setting-name">${esc(s.name)}</div>
                 <div class="fl-setting-hint">${esc(s.hint || '')}</div>
               </div>
               <button class="fl-toggle ${isOn ? 'on' : 'off'} ${isPending ? 'pending' : ''}" aria-pressed="${isOn}" ${isPending ? 'aria-busy="true"' : ''}>
                 <span class="fl-indicator"></span>
                 <span class="fl-state">${isPending ? '…' : (isOn ? 'ON' : 'OFF')}</span>
               </button>
             </div>
           `;
         }).join('')}
         ${renderPushRow()}
       </div>` : '')
    + eventsHtml;
  const panicBtn = listEl.querySelector('.fl-panic');
  if (panicBtn) panicBtn.addEventListener('click', panicClick);
  const silenceBtn = listEl.querySelector('.fl-silence');
  if (silenceBtn) silenceBtn.addEventListener('click', silenceClick);
  listEl.querySelectorAll('.fl-cam').forEach(tile => {
    tile.addEventListener('click', () => openCamModal(tile.dataset.slug, tile.dataset.name));
  });
  listEl.querySelectorAll('.fl-clip-row').forEach(row => {
    const idx = +row.dataset.idx;
    row.addEventListener('click', () => openClipModal(events[idx].clips));
  });
  // If the panel is currently visible, start the streams on the
  // newly-created <img> elements (re-render replaced them).
  if (panelVisible) startTileStreams();
  listEl.querySelectorAll('.fl-row').forEach(row => {
    const btn = row.querySelector('.fl-toggle');
    btn.addEventListener('click', () => toggle(row.dataset.id));
  });
  listEl.querySelectorAll('.fl-setting-row').forEach(row => {
    const btn = row.querySelector('.fl-toggle');
    btn.addEventListener('click', () => toggleSetting(row.dataset.id));
  });
  const pushBtn = listEl.querySelector('.fl-push-toggle');
  if (pushBtn) pushBtn.addEventListener('click', onPushClick);
}

// --- Push notifications row ----------------------------------------
// State is `pushUiState` — derived from the browser/SW each time the
// panel renders. Rendering reads it synchronously; refreshPushState
// updates it asynchronously and re-renders.
let pushUiState = 'unknown'; // 'unsupported' | 'denied' | 'unsubscribed' | 'subscribed' | 'pending' | 'unknown'
async function refreshPushState() {
  try { pushUiState = await pushStatus(); } catch { pushUiState = 'unsupported'; }
  // Don't trigger a full panel refresh; just patch the row in place
  // to avoid resetting other transient UI (modal open, etc.).
  if (root) {
    const btn = root.querySelector('.fl-push-toggle');
    const hint = root.querySelector('.fl-push-hint');
    if (btn) {
      btn.dataset.state = pushUiState;
      btn.querySelector('.fl-state').textContent = pushUiToBtnText(pushUiState);
      btn.classList.toggle('on', pushUiState === 'subscribed');
      btn.classList.toggle('off', pushUiState !== 'subscribed');
    }
    if (hint) hint.textContent = pushUiToHint(pushUiState);
  }
}
function pushUiToBtnText(s) {
  if (s === 'subscribed') return 'ON';
  if (s === 'pending')    return '…';
  return 'OFF';
}
function pushUiToHint(s) {
  if (s === 'unsupported') return 'Not supported in this browser';
  if (s === 'denied')      return 'Permission blocked — re-enable in browser settings';
  if (s === 'subscribed')  return 'This device will receive alerts';
  return 'Tap to enable on this device';
}
function renderPushRow() {
  return `
    <div class="fl-setting-row fl-push-row">
      <div class="fl-setting-text">
        <div class="fl-setting-name">Push notifications</div>
        <div class="fl-setting-hint fl-push-hint">${esc(pushUiToHint(pushUiState))}</div>
      </div>
      <button class="fl-toggle fl-push-toggle ${pushUiState === 'subscribed' ? 'on' : 'off'}" data-state="${pushUiState}">
        <span class="fl-indicator"></span>
        <span class="fl-state">${pushUiToBtnText(pushUiState)}</span>
      </button>
    </div>
  `;
}
async function onPushClick() {
  if (pushUiState === 'unsupported' || pushUiState === 'denied') return;
  const wasSubbed = pushUiState === 'subscribed';
  pushUiState = 'pending';
  await refreshPushState(); // patches the row to "pending" state visually
  pushUiState = 'pending';  // refreshPushState may have overridden — force again
  // Patch synchronously since refreshPushState pulls from browser API
  const btn = root && root.querySelector('.fl-push-toggle');
  if (btn) btn.querySelector('.fl-state').textContent = '…';
  try {
    if (wasSubbed) await pushUnsubscribe();
    else           await pushSubscribe();
  } catch (e) {
    console.warn('push toggle failed:', e);
  }
  await refreshPushState();
}

function groupClipsIntoEvents(clips, windowMs = 60000) {
  // Greedy pair: walk clips newest-first, fold each one into the most
  // recent event that's within the window AND doesn't already have a
  // clip from the same cam (one-clip-per-cam-per-event).
  const sorted = [...clips].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const events = [];
  for (const clip of sorted) {
    const ev = events.find(e =>
      Math.abs(e.startMs - clip.mtimeMs) < windowMs &&
      !e.clips.some(c => c.cam === clip.cam)
    );
    if (ev) {
      ev.clips.push(clip);
      ev.startMs = Math.max(ev.startMs, clip.mtimeMs);
    } else {
      events.push({ startMs: clip.mtimeMs, clips: [clip] });
    }
  }
  return events;
}

function openClipModal(eventClips) {
  const overlay = document.createElement('div');
  overlay.className = 'fl-clip-modal';
  const videos = eventClips.map(c => `
    <div class="fl-clip-video-wrap">
      <div class="fl-clip-video-label">${esc(CAM_LABEL[c.cam] || c.cam)}</div>
      <video class="fl-clip-video" controls autoplay muted playsinline preload="metadata"
             src="/api/cam-recording/${esc(c.cam)}/${esc(c.filename)}"></video>
    </div>
  `).join('');
  overlay.innerHTML = `
    <button class="fl-cam-modal-close" aria-label="Close">×</button>
    <div class="fl-clip-grid">${videos}</div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  // Close only if user taps the backdrop or the × — not when interacting
  // with the videos themselves.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('fl-cam-modal-close')) close();
  });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
}

function openCamModal(slug, name) {
  const overlay = document.createElement('div');
  overlay.className = 'fl-cam-modal';
  // Modal source: phones get the downsampled mobile variant (960×288)
  // because Chrome-on-Android's MJPEG handler wedges on the full-rate
  // HD stream. Desktops get the HD main stream MJPEG. Tried fmp4 in
  // the past — played one frame and stalled.
  const src = IS_MOBILE ? `/api/camera-stream-mobile/${slug}` : `/api/camera-stream/${slug}`;
  overlay.innerHTML = `
    <button class="fl-cam-modal-close" aria-label="Close">×</button>
    <div class="fl-cam-modal-name">${name}</div>
    <img class="fl-cam-modal-img" src="${src}" alt="${name}">
  `;
  document.body.appendChild(overlay);

  const close = () => {
    // Clearing the src closes the TCP connection to go2rtc.
    const img = overlay.querySelector('img');
    if (img) img.src = '';
    overlay.remove();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch {}
    }
    document.removeEventListener('keydown', onKey);
  };
  overlay.addEventListener('click', close);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  // Mobile only: request OS-level fullscreen + lock landscape. On
  // desktop the modal already fills the viewport with the panoramic
  // frame in its native landscape orientation, so the fullscreen API
  // call adds nothing but a permission-style fullscreen-banner
  // (Esc-to-exit) that the user has to dismiss.
  if (IS_MOBILE && overlay.requestFullscreen) {
    overlay.requestFullscreen()
      .then(() => {
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(() => {});
        }
      })
      .catch(() => {});
  }
}

let panicState = 'armed';   // 'armed' → 'confirm' → 'firing'
let panicTimer = null;
function setPanicState(s) {
  panicState = s;
  if (!root) return;
  const btn = root.querySelector('.fl-panic');
  if (!btn) return;
  btn.dataset.state = s;
  const label = btn.querySelector('.fl-panic-label');
  const hint  = btn.querySelector('.fl-panic-hint');
  if (s === 'armed')   { label.textContent = 'PANIC';            hint.textContent = 'tap twice to fire lights + sirens'; }
  if (s === 'confirm') { label.textContent = 'TAP TO CONFIRM';   hint.textContent = 'cancels in 3s'; }
  if (s === 'firing')  { label.textContent = 'FIRING…';          hint.textContent = ''; }
  if (s === 'fired')   { label.textContent = '✓ FIRED';          hint.textContent = ''; }
  if (s === 'failed')  { label.textContent = 'FAILED';           hint.textContent = 'tap to retry'; }
}
async function panicClick() {
  if (panicState === 'armed') {
    setPanicState('confirm');
    panicTimer = setTimeout(() => setPanicState('armed'), 3000);
    return;
  }
  if (panicState === 'confirm') {
    if (panicTimer) { clearTimeout(panicTimer); panicTimer = null; }
    setPanicState('firing');
    try {
      const r = await fetch('/api/floodlights/panic', { method: 'POST' });
      if (!r.ok) throw new Error();
      setPanicState('fired');
    } catch {
      setPanicState('failed');
    }
    setTimeout(() => setPanicState('armed'), 2500);
    return;
  }
  if (panicState === 'failed') {
    setPanicState('armed');
  }
}

async function silenceClick() {
  const btn = root && root.querySelector('.fl-silence');
  if (!btn || btn.dataset.state === 'firing') return;
  const label = btn.querySelector('.fl-silence-label');
  const prevText = label.textContent;
  btn.dataset.state = 'firing';
  label.textContent = 'SILENCING…';
  try {
    const r = await fetch('/api/floodlights/sirens-off', { method: 'POST' });
    if (!r.ok) throw new Error();
    btn.dataset.state = 'fired';
    label.textContent = '✓ SILENCED';
  } catch {
    btn.dataset.state = 'failed';
    label.textContent = 'FAILED';
  }
  setTimeout(() => {
    if (!root) return;
    const b = root.querySelector('.fl-silence');
    if (!b) return;
    b.dataset.state = 'armed';
    const l = b.querySelector('.fl-silence-label');
    if (l) l.textContent = prevText;
  }, 2000);
}


function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-floodlights scrollable';
  root.id = 'panelFloodlights';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone"><div class="fox critter">🦊</div></div>
      <div class="section-title-coral">FLOODLIGHTS</div>
      <div class="fl-list"></div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  listEl = root.querySelector('.fl-list');

  // Only stream while the panel is actually on-screen — closes the
  // MJPEG connection when the user is on another panel.
  const io = new IntersectionObserver(([entry]) => {
    panelVisible = entry.isIntersecting && entry.intersectionRatio > 0.3;
    if (panelVisible) startTileStreams();
    else stopTileStreams();
  }, { threshold: [0, 0.3, 0.7] });
  io.observe(root);

  return root;
}

// Hook the push state-fetch into the panel lifecycle: pull current
// state from the browser/SW after each refresh so the UI shows
// accurate "ON"/"OFF" on first paint and after re-subscribe.
const _origOnShow = refresh;
async function onShowWithPush() {
  await _origOnShow();
  refreshPushState();
}

export default { id: 'floodlights', mount, refresh, onShow: onShowWithPush };
