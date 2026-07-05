import { PANELS as DOTS } from '../config.js';

// All egress is server-side: this panel only ever POSTs to /api/led on
// the dashboard, which relays to the LAN LED device. That's what lets it
// work when the dashboard is opened remotely over the CF tunnel — the
// browser never has to reach 192.168.x directly.

let root, textInput, ttlInput, btn, statusEl, colourEl, swatchWrap, backlightInput;
let colour = '00e676';

// Mirrors the semantic palette in server.ts (LED = {...}). Purely for the
// quick-pick swatches; any RRGGBB is valid via the colour picker.
const PRESETS = [
  { hex: '00e676', name: 'Green' },
  { hex: '40e0d0', name: 'Aquamarine' },
  { hex: 'ff9e00', name: 'Amber' },
  { hex: 'ff2d55', name: 'Red' },
  { hex: '2e9bff', name: 'Blue' },
  { hex: '00e5ff', name: 'Cyan' },
  { hex: 'ffffff', name: 'White' },
];

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function setColour(hex) {
  colour = hex.replace(/^#/, '').toLowerCase();
  colourEl.value = '#' + colour;
  swatchWrap.querySelectorAll('.led-swatch').forEach((s) => {
    s.classList.toggle('active', s.dataset.hex === colour);
  });
}

async function send() {
  const text = (textInput.value || '').trim();
  if (!text) return;
  let ttl = parseInt(ttlInput.value, 10);
  if (!Number.isFinite(ttl) || ttl < 1) ttl = 10;
  btn.disabled = true;
  statusEl.className = 'led-status';
  statusEl.textContent = 'Sending…';
  try {
    const res = await fetch('/api/led', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, colour, ttl }),
    });
    if (!res.ok) {
      const t = await res.json().catch(() => ({}));
      throw new Error(t.error || 'device unreachable');
    }
    statusEl.className = 'led-status ok';
    statusEl.textContent = `Shown for ${ttl}s`;
  } catch (e) {
    statusEl.className = 'led-status fail';
    statusEl.textContent = `Failed: ${e.message || 'try again'}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { statusEl.className = 'led-status'; statusEl.textContent = ''; }, 4000);
  }
}

// The device remembers its backlight mode across power cycles, so the
// switch loads the real state before enabling itself. On failure it just
// stays disabled — same "device unreachable" posture as send().
async function loadBacklight() {
  try {
    const res = await fetch('/api/led-backlight');
    if (!res.ok) throw new Error();
    const { mode } = await res.json();
    backlightInput.checked = mode === 'always';
    backlightInput.disabled = false;
  } catch { /* leave the switch disabled */ }
}

async function setBacklightMode() {
  const mode = backlightInput.checked ? 'always' : 'auto';
  backlightInput.disabled = true;
  try {
    const res = await fetch('/api/led-backlight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) throw new Error();
    statusEl.className = 'led-status ok';
    statusEl.textContent = `Backlight ${mode}`;
  } catch {
    backlightInput.checked = !backlightInput.checked; // revert
    statusEl.className = 'led-status fail';
    statusEl.textContent = 'Backlight change failed';
  } finally {
    backlightInput.disabled = false;
    setTimeout(() => { statusEl.className = 'led-status'; statusEl.textContent = ''; }, 4000);
  }
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel panel-led scrollable';
  root.id = 'panelLed';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="critter-zone"><div class="ledfish critter">🐠</div></div>
      <div class="section-title-led">LED DISPLAY</div>
      <div class="led-form">
        <input class="led-text-input" type="text" maxlength="64"
               placeholder="Message (keep it brief)" autocomplete="off" />
        <div class="led-swatches"></div>
        <div class="led-row">
          <label class="led-label">Colour
            <input class="led-colour" type="color" value="#00e676" />
          </label>
          <label class="led-label">Seconds
            <input class="led-ttl" type="number" min="1" max="300" value="10" />
          </label>
        </div>
        <button class="led-send-btn">SHOW</button>
        <div class="led-status"></div>
        <label class="led-backlight">
          <span>Backlight always on</span>
          <input class="led-backlight-input" type="checkbox" disabled />
          <span class="led-toggle"></span>
        </label>
      </div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  textInput = root.querySelector('.led-text-input');
  ttlInput = root.querySelector('.led-ttl');
  btn = root.querySelector('.led-send-btn');
  statusEl = root.querySelector('.led-status');
  colourEl = root.querySelector('.led-colour');
  swatchWrap = root.querySelector('.led-swatches');

  swatchWrap.innerHTML = PRESETS.map((p) =>
    `<button class="led-swatch" data-hex="${p.hex}" title="${p.name}" style="background:#${p.hex}"></button>`
  ).join('');
  swatchWrap.querySelectorAll('.led-swatch').forEach((s) => {
    s.addEventListener('click', () => setColour(s.dataset.hex));
  });
  colourEl.addEventListener('input', () => setColour(colourEl.value));
  textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  btn.addEventListener('click', send);

  backlightInput = root.querySelector('.led-backlight-input');
  backlightInput.addEventListener('change', setBacklightMode);
  loadBacklight();

  setColour('00e676');
  return root;
}

export default { id: 'led', mount };
