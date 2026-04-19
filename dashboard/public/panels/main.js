const DOTS = 6;

let root, crabZone, crabEl, textarea, btn, statusEl, bubbleInterval;

function dots() {
  return Array.from({ length: DOTS }, (_, i) => `<div class="dot" data-p="${i}"></div>`).join('');
}

function spawnBubble() {
  if (!document.body.contains(crabZone)) return;
  const rect = crabEl.getBoundingClientRect();
  const zone = crabZone.getBoundingClientRect();
  if (!rect.width) return;
  const b = document.createElement('div');
  b.className = 'bubble';
  const size = 4 + Math.random() * 8;
  b.style.width = size + 'px';
  b.style.height = size + 'px';
  b.style.left = (rect.left - zone.left + rect.width / 2 + (Math.random() - 0.5) * 20) + 'px';
  b.style.top = (rect.top - zone.top + rect.height - 5) + 'px';
  crabZone.appendChild(b);
  b.addEventListener('animationend', () => b.remove());
}

function crabExplosion() {
  for (let i = 0; i < 50; i++) {
    const c = document.createElement('div');
    c.textContent = '🦀';
    c.style.cssText = `
      position:fixed; font-size:${1.2 + Math.random() * 2.5}rem; z-index:9999;
      left:${Math.random() * 100}vw; top:${50 + (Math.random() - 0.5) * 30}vh;
      pointer-events:none; user-select:none; line-height:1;
      animation: crabBlast ${0.8 + Math.random() * 1.2}s cubic-bezier(.15,.9,.3,1) forwards;
      --tx:${(Math.random() - 0.5) * 400}px;
      --ty:${-200 - Math.random() * 500}px;
      --rot:${(Math.random() - 0.5) * 1080}deg;
    `;
    document.body.appendChild(c);
    c.addEventListener('animationend', () => c.remove());
  }
}

async function send() {
  const text = textarea.value.trim();
  if (!text) { crabExplosion(); return; }
  btn.disabled = true;
  statusEl.className = 'prompt-status';
  statusEl.textContent = 'Sending\u2026';
  try {
    const res = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text }),
    });
    if (!res.ok) throw new Error();
    textarea.value = '';
    statusEl.className = 'prompt-status ok';
    statusEl.textContent = 'Sent! Movie Bot will pick this up shortly.';
    crabExplosion();
  } catch {
    statusEl.className = 'prompt-status fail';
    statusEl.textContent = 'Failed to send. Try again.';
  } finally {
    btn.disabled = false;
    setTimeout(() => { statusEl.className = 'prompt-status'; statusEl.textContent = ''; }, 4000);
  }
}

function mount() {
  root = document.createElement('div');
  root.className = 'panel';
  root.id = 'panelMain';
  root.innerHTML = `
    <div class="panel-inner">
      <div class="crab-zone critter-zone"><div class="crab critter">🦀</div></div>
      <div class="header">
        <div class="title">MOVIE BOT</div>
        <div class="subtitle">Leave a message for Movie Bot</div>
      </div>
      <div class="form">
        <textarea placeholder="What would you like Movie Bot to do?"></textarea>
        <button class="send-btn">GET TO IT</button>
        <div class="prompt-status"></div>
      </div>
      <div class="dots">${dots()}</div>
    </div>
  `;
  crabZone = root.querySelector('.crab-zone');
  crabEl = root.querySelector('.crab');
  textarea = root.querySelector('textarea');
  btn = root.querySelector('.send-btn');
  statusEl = root.querySelector('.prompt-status');

  btn.addEventListener('click', send);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
  });

  crabEl.addEventListener('click', () => {
    crabEl.style.animation = 'none';
    crabEl.offsetHeight;
    crabEl.style.transition = 'transform 0.5s ease';
    crabEl.style.transform = 'rotate(360deg) scale(1.3)';
    setTimeout(() => {
      crabEl.style.transition = '';
      crabEl.style.transform = '';
      crabEl.style.animation = '';
    }, 600);
  });

  bubbleInterval = setInterval(spawnBubble, 350);
  return root;
}

export default { id: 'main', mount };
