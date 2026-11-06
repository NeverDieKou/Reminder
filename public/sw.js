// Servis çalışanı: sunucudan gelen hatırlatmaları bildirim olarak gösterir.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data ? event.data.text() : 'Hatırlatma' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Hatırlatma', {
    body: data.body || '',
    tag: data.tag,
    renotify: true,
    requireInteraction: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { await c.focus(); if ('navigate' in c) await c.navigate(url).catch(() => {}); return; }
    }
    await self.clients.openWindow(url);
  })());
});
