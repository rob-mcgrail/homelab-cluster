export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

export function fmtBytes(b) {
  if (b < 1073741824) return (b / 1048576).toFixed(0) + ' MB';
  if (b < 1099511627776) return (b / 1073741824).toFixed(1) + ' GB';
  return (b / 1099511627776).toFixed(2) + ' TB';
}

export function fmtRate(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtMbps(bitrate) {
  if (!bitrate) return '';
  return (bitrate / 1_000_000).toFixed(1) + ' Mbps';
}

export function fmtAgo(epochSec) {
  if (!epochSec) return 'idle';
  const now = Date.now() / 1000;
  const d = Math.max(0, now - epochSec);
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// Absolute time label that adapts to recency: "Today 14:23",
// "Yesterday 14:23", "Mon 14:23" (within last week), or "23 Apr 14:23".
export function fmtClipDay(epochMs) {
  if (!epochMs) return '';
  const d = new Date(epochMs);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayMs = 86400000;
  if (epochMs >= startOfToday) return `Today ${t}`;
  if (epochMs >= startOfToday - dayMs) return `Yesterday ${t}`;
  if (epochMs >= startOfToday - 6 * dayMs) {
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  }
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}

export function fmtLease(expiryEpoch) {
  if (!expiryEpoch) return 'no lease';
  const now = Date.now() / 1000;
  const d = expiryEpoch - now;
  if (d < 0) return `expired ${fmtAgo(expiryEpoch)}`;
  if (d < 60) return `expires ${Math.floor(d)}s`;
  if (d < 3600) return `expires ${Math.floor(d / 60)}m`;
  if (d < 86400) return `expires ${Math.floor(d / 3600)}h`;
  return `expires ${Math.floor(d / 86400)}d`;
}

// Strip any accidental outer code fence Claude may emit, then parse markdown
// and wrap <table>s in scroll containers for mobile.
export function renderTriageMd(md) {
  let clean = md.trim();
  const fence = clean.match(/^(?:[^\n]*\n+)?```[a-z]*\n([\s\S]*?)\n```\s*$/i);
  if (fence) clean = fence[1];
  const html = marked.parse(clean);
  return html
    .replace(/<table>/g, '<div class="tbl-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
}

export function barClass(pct) {
  if (pct >= 90) return 'stat-bar-fill crit';
  if (pct >= 75) return 'stat-bar-fill warn';
  return 'stat-bar-fill';
}
