// Web Push client glue: register the service worker, ask permission
// when the user explicitly opts in, and round-trip the subscription
// to the server. Exports a small async API the panels can wire to a
// button.

let _swReg = null;

// Convert the server's URL-safe base64 VAPID public key into the
// Uint8Array the Push API expects. (The Push API doesn't speak the
// URL-safe variant directly.)
function urlBase64ToUint8Array(s) {
  const padding = '='.repeat((4 - s.length % 4) % 4);
  const base64 = (s + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// True if the browser supports Push at all. Some older Safari builds
// and "lite" browsers will fail any of these checks.
export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registerSW() {
  if (_swReg) return _swReg;
  _swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return _swReg;
}

// Returns the current subscription state without prompting anything.
// One of: 'unsupported', 'denied', 'unsubscribed', 'subscribed'.
export async function pushStatus() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await registerSW();
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'unsubscribed';
  } catch {
    return 'unsupported';
  }
}

// Prompts for permission (in response to a user gesture only — call
// from a click handler) and registers the subscription with the
// server. Throws on user denial or any error.
export async function pushSubscribe() {
  if (!pushSupported()) throw new Error('push not supported');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('permission denied');
  const reg = await registerSW();
  // Reuse an existing subscription if present — re-subscribing would
  // give us an identical endpoint anyway, but skipping the round-trip
  // is faster.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const r = await fetch('/api/push/vapid-public');
    if (!r.ok) throw new Error('vapid fetch failed');
    const { key } = await r.json();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  // Send to server. The serialized form is what web-push expects.
  const json = sub.toJSON();
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  });
  if (!res.ok) throw new Error('subscribe persist failed');
}

export async function pushUnsubscribe() {
  const reg = await registerSW();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe();
}
