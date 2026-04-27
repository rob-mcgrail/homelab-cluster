// Web Push service worker. Lives at /sw.js so its scope is the
// whole dashboard origin. Two responsibilities: render the OS-level
// notification when a `push` arrives from the server, and handle the
// `notificationclick` so tapping it opens (or focuses) the dashboard.

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { payload = { title: event.data.text() }; }
  const { title, body, icon, tag, url } = payload;
  event.waitUntil(self.registration.showNotification(title, {
    body: body || '',
    icon: icon || '/favicon.ico',
    tag: tag || 'dashboard',
    badge: '/favicon.ico',
    data: { url: url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    // Focus an existing tab if the dashboard's already open; otherwise
    // open a fresh one. Same-origin only — `target` is a path on the
    // dashboard, not a full URL, so the browser resolves against the
    // current origin.
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.registration.scope)) {
        await c.focus();
        if ('navigate' in c) c.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
