import historyPanel from './panels/history.js';
import mainPanel from './panels/main.js';
import torrentsPanel from './panels/torrents.js';
import statusPanel from './panels/status.js';
import piholePanel from './panels/pihole.js';
import linksPanel from './panels/links.js';

const panels = [historyPanel, mainPanel, torrentsPanel, statusPanel, piholePanel, linksPanel];
const PAGES = panels.length;

const viewport = document.getElementById('viewport');
const panelEls = panels.map(p => {
  const el = p.mount();
  viewport.appendChild(el);
  return el;
});

const allDots = () => viewport.querySelectorAll('.dot');
const W = () => window.innerWidth;
let page = 1;
let startX = 0, startY = 0, startTime = 0, gesture = null, pullPanel = null;

function setPos(px, animate) {
  if (animate) {
    viewport.classList.add('animating');
    viewport.addEventListener('transitionend', () => viewport.classList.remove('animating'), { once: true });
  } else {
    viewport.classList.remove('animating');
  }
  viewport.style.transform = `translateX(${px}px)`;
}

function updateDots() {
  allDots().forEach(d => d.classList.toggle('active', +d.dataset.p === page));
}

function snapTo(p) {
  p = Math.max(0, Math.min(PAGES - 1, p));
  page = p;
  setPos(-p * W(), true);
  updateDots();
  const panel = panels[p];
  if (panel && panel.onShow) panel.onShow();
}

// Initial position + dots
setPos(-page * W(), false);
updateDots();
if (panels[page] && panels[page].onShow) panels[page].onShow();

// Auto-refresh every 15s — only the currently visible panel
setInterval(() => {
  const panel = panels[page];
  if (panel && panel.refresh) panel.refresh();
}, 15000);

// ---- swipe + pull-to-refresh ----
document.addEventListener('touchstart', (e) => {
  startX = e.touches[0].clientX;
  startY = e.touches[0].clientY;
  startTime = Date.now();
  gesture = null;
  const panelEl = e.target.closest('.panel');
  if (panelEl) {
    const isScrolled = panelEl.classList.contains('scrollable') && panelEl.scrollTop > 0;
    pullPanel = isScrolled ? null : panelEl;
  } else {
    pullPanel = null;
  }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (gesture === 'scroll') return;
  const dx = e.touches[0].clientX - startX;
  const dy = e.touches[0].clientY - startY;

  if (!gesture && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
    if (Math.abs(dx) > Math.abs(dy)) gesture = 'swipe';
    else if (dy > 0 && pullPanel) gesture = 'pull';
    else { gesture = 'scroll'; return; }
  }

  if (gesture === 'swipe') {
    const base = -page * W();
    let raw = base + dx;
    const minX = -(PAGES - 1) * W();
    if (raw > 0) raw = raw * 0.2;
    if (raw < minX) raw = minX + (raw - minX) * 0.2;
    viewport.classList.remove('animating');
    viewport.style.transform = `translateX(${raw}px)`;
  }

  if (gesture === 'pull') {
    const pull = Math.min(Math.max(dy * 0.4, 0), 80);
    pullPanel.style.transition = 'none';
    pullPanel.style.transform = `translateY(${pull}px)`;
  }
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (gesture === 'swipe') {
    const dx = e.changedTouches[0].clientX - startX;
    const elapsed = Date.now() - startTime;
    const velocity = Math.abs(dx) / elapsed;
    if (velocity > 0.4 || Math.abs(dx) > W() * 0.3) {
      if (dx > 0 && page > 0) { snapTo(page - 1); gesture = null; return; }
      if (dx < 0 && page < PAGES - 1) { snapTo(page + 1); gesture = null; return; }
    }
    snapTo(page);
  }

  if (gesture === 'pull' && pullPanel) {
    const t = pullPanel.style.transform;
    const y = parseFloat(t.match(/[\d.]+/)?.[0]) || 0;
    pullPanel.style.transition = 'transform 0.25s ease';
    pullPanel.style.transform = '';
    if (y > 30) {
      const panel = panels[page];
      if (panel && panel.refresh) panel.refresh();
    }
  }

  gesture = null;
  pullPanel = null;
}, { passive: true });

window.addEventListener('resize', () => setPos(-page * W(), false));
