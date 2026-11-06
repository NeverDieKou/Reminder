import { DurableObject } from 'cloudflare:workers';
import { parseTask, formatWhen, PRIORITY_NAMES } from '../public/parse.js';
import { generateVapid, sendPush, b64u } from './push.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.STORE.get(env.STORE.idFromName('main'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const err = (msg, status = 400) => json({ error: msg }, status);
const rid = (n = 16) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const REPEAT_OK = ['', 'daily', 'weekdays', 'weekly', 'monthly'];
const DAY = 24 * 3600000;

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
  return { salt: b64(salt), hash: b64(bits) };
}

function nextOccurrence(ms, repeat, tz, nowMs) {
  if (ms == null) return null;
  const MIN = 60000;
  let d = new Date(ms + tz * MIN);
  const step = () => {
    if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1);
    else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else if (repeat === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
    else if (repeat === 'weekdays') {
      do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    }
  };
  step();
  while (d.getTime() - tz * MIN <= nowMs) step();
  return d.getTime() - tz * MIN;
}

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 0, remind_at INTEGER, repeat TEXT NOT NULL DEFAULT '',
        notified INTEGER NOT NULL DEFAULT 0, done_at INTEGER, created_at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'app'
      );
      CREATE TABLE IF NOT EXISTS completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, title TEXT NOT NULL,
        priority INTEGER NOT NULL, remind_at INTEGER, created_at INTEGER NOT NULL, done_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    for (const ddl of ['ALTER TABLE tasks ADD COLUMN nag_count INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE tasks ADD COLUMN last_notified_at INTEGER']) {
      try { this.sql.exec(ddl); } catch { /* sütun zaten var */ }
    }
  }

  // ---------- yardımcılar ----------
  kvGet(k) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]; return r ? JSON.parse(r.v) : null; }
  kvSet(k, v) { this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }
  tz() { return this.kvGet('tz') ?? 180; }
  task(id) { return this.sql.exec('SELECT * FROM tasks WHERE id = ?', id).toArray()[0] || null; }
  newToken(kind) { const t = rid(24); this.sql.exec('INSERT INTO tokens VALUES (?, ?, ?)', t, kind, Date.now()); return t; }

  async vapid() {
    let v = this.kvGet('vapid');
    if (!v) { v = await generateVapid(); this.kvSet('vapid', v); }
    return v;
  }

  prefs() {
    return { nag: 30, nagMax: 3, summary: true, summaryTime: '08:30', ...(this.kvGet('prefs') || {}) };
  }

  // Yerel gün anahtarı ve "bugün HH:MM" zamanı (ms)
  localDayStart(ms) {
    const off = this.tz() * 60000;
    return Math.floor((ms + off) / DAY) * DAY - off;
  }
  summaryAt(dayStart) {
    const [h, m] = this.prefs().summaryTime.split(':').map(Number);
    return dayStart + (h * 60 + m) * 60000;
  }
  nextSummary(now) {
    if (!this.prefs().summary) return null;
    const today = this.localDayStart(now);
    const last = this.kvGet('lastSummary') || 0;
    const t = this.summaryAt(today);
    return last >= today || t + 3 * 3600000 < now ? this.summaryAt(today + DAY) : t;
  }
  badgeCount(now = Date.now()) {
    const end = this.localDayStart(now) + DAY;
    return this.sql.exec('SELECT COUNT(*) AS n FROM tasks WHERE done_at IS NULL AND remind_at IS NOT NULL AND remind_at < ?', end).toArray()[0].n;
  }

  async scheduleAlarm() {
    const now = Date.now();
    const p = this.prefs();
    const times = [];
    const a = this.sql.exec('SELECT MIN(remind_at) AS m FROM tasks WHERE done_at IS NULL AND notified = 0 AND remind_at IS NOT NULL').toArray()[0];
    if (a && a.m != null) times.push(a.m);
    if (p.nag > 0) {
      const b = this.sql.exec('SELECT MIN(last_notified_at) AS m FROM tasks WHERE done_at IS NULL AND notified = 1 AND last_notified_at IS NOT NULL AND nag_count < ?', p.nagMax).toArray()[0];
      if (b && b.m != null) times.push(b.m + p.nag * 60000);
    }
    const sm = this.nextSummary(now);
    if (sm != null) times.push(sm);
    if (times.length) await this.ctx.storage.setAlarm(Math.max(Math.min(...times), now + 500));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const now = Date.now();
    const p = this.prefs();
    const tz = this.tz();
    const bang = (t) => ['', '', '❗ ', '‼️ '][t.priority] || '';

    // 1) Zamanı gelen hatırlatmalar
    const due = this.sql.exec('SELECT * FROM tasks WHERE done_at IS NULL AND notified = 0 AND remind_at IS NOT NULL AND remind_at <= ? ORDER BY priority DESC, remind_at', now + 5000).toArray();
    for (const t of due) {
      this.sql.exec('UPDATE tasks SET notified = 1, nag_count = 0, last_notified_at = ? WHERE id = ?', now, t.id);
      await this.notifyAll({
        title: bang(t) + t.title,
        body: [t.priority ? `${PRIORITY_NAMES[t.priority]} öncelik` : '', t.notes].filter(Boolean).join(' · ') || 'Hatırlatma zamanı geldi. Dokun: tamamla ya da ertele.',
        tag: t.id, url: `/?task=${t.id}`, badge: this.badgeCount(now),
      });
    }

    // 2) Bitirilmeyen işler için tekrar hatırlatma
    if (p.nag > 0) {
      const nags = this.sql.exec('SELECT * FROM tasks WHERE done_at IS NULL AND notified = 1 AND last_notified_at IS NOT NULL AND nag_count < ? AND last_notified_at + ? <= ? ORDER BY priority DESC',
        p.nagMax, p.nag * 60000, now + 5000).toArray();
      for (const t of nags) {
        this.sql.exec('UPDATE tasks SET nag_count = nag_count + 1, last_notified_at = ? WHERE id = ?', now, t.id);
        await this.notifyAll({
          title: `🔁 ${bang(t)}${t.title}`,
          body: `Hâlâ bekliyor (${formatWhen(t.remind_at, now, tz)}). Dokun: tamamla ya da ertele.`,
          tag: t.id, url: `/?task=${t.id}`, badge: this.badgeCount(now),
        });
      }
    }

    // 3) Sabah özeti
    const today = this.localDayStart(now);
    if (p.summary && (this.kvGet('lastSummary') || 0) < today && now >= this.summaryAt(today) - 5000 && now < this.summaryAt(today) + 3 * 3600000) {
      this.kvSet('lastSummary', now);
      const end = today + DAY;
      const list = this.sql.exec('SELECT * FROM tasks WHERE done_at IS NULL AND remind_at IS NOT NULL AND remind_at < ? ORDER BY priority DESC, remind_at', end).toArray();
      const late = list.filter((t) => t.remind_at < today).length;
      if (list.length) {
        const top = list.slice(0, 3).map((t) => `• ${bang(t)}${t.title} (${formatWhen(t.remind_at, now, tz).replace(/^Bugün /, '')})`).join('\n');
        await this.notifyAll({
          title: `☀️ Bugün ${list.length} işin var${late ? `, ${late} tanesi gecikmiş` : ''}`,
          body: top + (list.length > 3 ? `\n+${list.length - 3} iş daha` : ''),
          tag: 'summary', url: '/', badge: list.length,
        });
      }
    }
    await this.scheduleAlarm();
  }

  async notifyAll(data) {
    const subs = this.sql.exec('SELECT * FROM subs').toArray();
    const vapid = await this.vapid();
    const subject = this.kvGet('origin') || 'mailto:hatirlatici@example.com';
    let sent = 0;
    for (const s of subs) {
      try {
        const status = await sendPush(s, data, vapid, subject);
        if (status === 404 || status === 410) this.sql.exec('DELETE FROM subs WHERE endpoint = ?', s.endpoint);
        else if (status < 300) sent++;
        else console.log('push failed', status, s.endpoint.slice(0, 60));
      } catch (e) { console.log('push error', e.message); }
    }
    return { sent, total: subs.length };
  }

  createTask(input, source = 'app') {
    const title = String(input.title || '').trim().slice(0, 500);
    if (!title) throw new Error('Başlık boş olamaz');
    const t = {
      id: rid(9), title, notes: String(input.notes || '').slice(0, 5000),
      priority: Math.max(0, Math.min(3, parseInt(input.priority, 10) || 0)),
      remind_at: Number.isFinite(input.remindAt) ? Math.round(input.remindAt) : null,
      repeat: REPEAT_OK.includes(input.repeat) ? input.repeat : '',
      notified: 0, done_at: null, created_at: Date.now(), source,
    };
    if (t.remind_at != null && t.remind_at <= Date.now() - 60000) t.notified = 1; // geçmiş zaman: bildirim gönderme
    this.sql.exec('INSERT INTO tasks (id, title, notes, priority, remind_at, repeat, notified, done_at, created_at, source) VALUES (?,?,?,?,?,?,?,?,?,?)',
      t.id, t.title, t.notes, t.priority, t.remind_at, t.repeat, t.notified, t.done_at, t.created_at, t.source);
    return t;
  }

  // ---------- HTTP ----------
  async fetch(request) {
    try { return await this.route(request); }
    catch (e) { console.log(e.stack); return err(e.message || 'Hata', 500); }
  }

  async route(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method;
    const body = method === 'GET' || method === 'DELETE' ? {} : await request.json().catch(() => ({}));
    if (!this.kvGet('origin') && url.protocol === 'https:') this.kvSet('origin', url.origin);

    // --- giriş ---
    if (path === '/status') return json({ setup: !!this.kvGet('password') });

    if (path === '/setup' && method === 'POST') {
      if (this.kvGet('password')) return err('Şifre zaten belirlenmiş', 409);
      if (!body.password || body.password.length < 4) return err('Şifre en az 4 karakter olmalı');
      this.kvSet('password', await hashPassword(body.password));
      return json({ token: this.newToken('web') });
    }

    if (path === '/login' && method === 'POST') {
      const pw = this.kvGet('password');
      if (!pw) return err('Önce şifre belirleyin', 409);
      const lock = this.kvGet('lock') || { fails: 0, until: 0 };
      if (lock.until > Date.now()) return err('Çok fazla hatalı deneme. Biraz sonra tekrar deneyin.', 429);
      const { hash } = await hashPassword(String(body.password || ''), pw.salt);
      if (hash !== pw.hash) {
        lock.fails++;
        if (lock.fails >= 5) { lock.until = Date.now() + 5 * 60000; lock.fails = 0; }
        this.kvSet('lock', lock);
        return err('Şifre yanlış', 401);
      }
      this.kvSet('lock', { fails: 0, until: 0 });
      return json({ token: this.newToken('web') });
    }

    // --- yetki ---
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : url.searchParams.get('key');
    const tok = token ? this.sql.exec('SELECT * FROM tokens WHERE token = ?', token).toArray()[0] : null;
    if (!tok) return err('Giriş gerekli', 401);

    // --- Siri / kestirme ---
    if (path === '/quick' && (method === 'POST' || method === 'GET')) {
      const text = String(body.text ?? url.searchParams.get('text') ?? '').trim();
      if (!text) return new Response('Bir şey duyamadım, tekrar dener misin?', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      const p = parseTask(text, Date.now(), this.tz());
      const t = this.createTask(p, 'siri');
      await this.scheduleAlarm();
      let msg = `Eklendi: ${t.title}`;
      if (t.remind_at) msg += `. ${formatWhen(t.remind_at, Date.now(), this.tz())} hatırlatacağım`;
      if (t.priority) msg += `. Öncelik ${PRIORITY_NAMES[t.priority].toLocaleLowerCase('tr')}`;
      return new Response(msg + '.', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    if (tok.kind !== 'web') return err('Bu anahtar sadece iş eklemek içindir', 403);

    if (path === '/logout' && method === 'POST') {
      this.sql.exec('DELETE FROM tokens WHERE token = ?', token);
      return json({ ok: true });
    }

    if (path === '/settings' && method === 'GET') return json({ ...this.prefs(), badge: this.badgeCount(), nextAlarm: await this.ctx.storage.getAlarm() });

    if (path === '/settings' && method === 'POST') {
      if (Number.isFinite(body.tz) && Math.abs(body.tz) <= 14 * 60) this.kvSet('tz', Math.round(body.tz));
      const p = this.prefs();
      let changed = false;
      if ([0, 10, 15, 30, 60, 120].includes(body.nag)) { p.nag = body.nag; changed = true; }
      if ([1, 3, 6, 99].includes(body.nagMax)) { p.nagMax = body.nagMax; changed = true; }
      if (typeof body.summary === 'boolean') { p.summary = body.summary; changed = true; }
      if (typeof body.summaryTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.summaryTime)) { p.summaryTime = body.summaryTime; changed = true; }
      if (changed) this.kvSet('prefs', p);
      await this.scheduleAlarm();
      return json({ ...p, badge: this.badgeCount() });
    }

    // --- görevler ---
    if (path === '/tasks' && method === 'GET') {
      const active = this.sql.exec('SELECT * FROM tasks WHERE done_at IS NULL ORDER BY priority DESC, remind_at IS NULL, remind_at, created_at').toArray();
      const archive = this.sql.exec('SELECT * FROM tasks WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT 300').toArray();
      return json({ active, archive });
    }

    if (path === '/tasks' && method === 'POST') {
      const input = body.text && !body.title ? parseTask(body.text, Date.now(), this.tz()) : body;
      const t = this.createTask(input, 'app');
      await this.scheduleAlarm();
      return json(t);
    }

    const m = path.match(/^\/tasks\/([\w-]+)$/);
    if (m) {
      const t = this.task(m[1]);
      if (!t) return err('Bulunamadı', 404);
      if (method === 'DELETE') {
        this.sql.exec('DELETE FROM tasks WHERE id = ?', t.id);
        await this.scheduleAlarm();
        return json({ ok: true });
      }
      if (method === 'PATCH') {
        const now = Date.now();
        if ('title' in body) { const v = String(body.title).trim().slice(0, 500); if (v) t.title = v; }
        if ('notes' in body) t.notes = String(body.notes || '').slice(0, 5000);
        if ('priority' in body) t.priority = Math.max(0, Math.min(3, parseInt(body.priority, 10) || 0));
        if ('repeat' in body) t.repeat = REPEAT_OK.includes(body.repeat) ? body.repeat : '';
        if ('remindAt' in body) {
          const v = Number.isFinite(body.remindAt) ? Math.round(body.remindAt) : null;
          if (v !== t.remind_at) { t.remind_at = v; t.notified = v != null && v > now - 60000 ? 0 : 1; t.nag_count = 0; t.last_notified_at = null; }
        }
        let log = false;
        if (body.done === true && t.done_at == null) {
          log = true;
          if (t.repeat && t.remind_at != null) {
            this.sql.exec('INSERT INTO completions (task_id, title, priority, remind_at, created_at, done_at) VALUES (?,?,?,?,?,?)', t.id, t.title, t.priority, t.remind_at, t.created_at, now);
            log = false;
            t.remind_at = nextOccurrence(t.remind_at, t.repeat, this.tz(), now);
            t.notified = 0; t.nag_count = 0; t.last_notified_at = null;
          } else t.done_at = now;
        } else if (body.done === false && t.done_at != null) {
          t.done_at = null;
          this.sql.exec('DELETE FROM completions WHERE id = (SELECT MAX(id) FROM completions WHERE task_id = ?)', t.id);
          if (t.remind_at != null && t.remind_at > now) t.notified = 0;
        }
        if (log) this.sql.exec('INSERT INTO completions (task_id, title, priority, remind_at, created_at, done_at) VALUES (?,?,?,?,?,?)', t.id, t.title, t.priority, t.remind_at, t.created_at, now);
        this.sql.exec('UPDATE tasks SET title=?, notes=?, priority=?, remind_at=?, repeat=?, notified=?, done_at=?, nag_count=?, last_notified_at=? WHERE id=?',
          t.title, t.notes, t.priority, t.remind_at, t.repeat, t.notified, t.done_at, t.nag_count, t.last_notified_at, t.id);
        await this.scheduleAlarm();
        return json(t);
      }
    }

    // --- analiz / dışa aktarma ---
    if (path === '/export' && method === 'GET') {
      return json({
        tasks: this.sql.exec('SELECT * FROM tasks ORDER BY created_at').toArray(),
        completions: this.sql.exec('SELECT * FROM completions ORDER BY done_at').toArray(),
        tz: this.tz(),
      });
    }

    // --- bildirimler ---
    if (path === '/vapid' && method === 'GET') return json({ publicKey: (await this.vapid()).publicKey });

    if (path === '/subscribe' && method === 'POST') {
      const s = body;
      if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return err('Geçersiz abonelik');
      if (!/^https:\/\//.test(s.endpoint)) return err('Geçersiz adres');
      this.sql.exec('INSERT INTO subs (endpoint, p256dh, auth, created_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth',
        s.endpoint, s.keys.p256dh, s.keys.auth, Date.now());
      return json({ ok: true, devices: this.sql.exec('SELECT COUNT(*) AS n FROM subs').toArray()[0].n });
    }

    if (path === '/unsubscribe' && method === 'POST') {
      this.sql.exec('DELETE FROM subs WHERE endpoint = ?', String(body.endpoint || ''));
      return json({ ok: true });
    }

    if (path === '/test-push' && method === 'POST') {
      const r = await this.notifyAll({ title: '🔔 Deneme bildirimi', body: 'Bildirimler çalışıyor. Hatırlatmalar böyle gelecek.', tag: 'test', url: '/' });
      return json(r);
    }

    if (path === '/siri-key' && (method === 'GET' || method === 'POST')) {
      let row = this.sql.exec("SELECT token FROM tokens WHERE kind = 'siri' LIMIT 1").toArray()[0];
      if (method === 'POST') { this.sql.exec("DELETE FROM tokens WHERE kind = 'siri'"); row = null; }
      return json({ key: row ? row.token : this.newToken('siri') });
    }

    return err('Bulunamadı', 404);
  }
}
