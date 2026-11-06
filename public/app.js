import { parseTask, formatWhen, PRIORITY_NAMES } from './parse.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const tz = () => -new Date().getTimezoneOffset();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HOUR = 3600000, DAY = 24 * HOUR;

let token = null;
try { token = localStorage.getItem('token'); } catch {}
const state = { active: [], archive: [], tab: 'active', statsRange: 30, editing: null, priority: 0 };

// ---------------- API ----------------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { setToken(null); showAuth(); throw new Error('Giriş gerekli'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Bağlantı hatası');
  return data;
}
function setToken(t) {
  token = t;
  try { t ? localStorage.setItem('token', t) : localStorage.removeItem('token'); } catch {}
}

// ---------------- giriş ----------------
let setupMode = false;
async function showAuth() {
  $('#app').hidden = true;
  $('#auth').hidden = false;
  try {
    const s = await api('/status');
    setupMode = !s.setup;
  } catch { setupMode = false; }
  $('#auth-hint').textContent = setupMode ? 'Hoş geldin! Uygulamayı korumak için bir şifre belirle.' : 'Devam etmek için şifreni gir.';
  $('#auth-btn').textContent = setupMode ? 'Şifreyi belirle' : 'Giriş';
  $('#auth-pass').autocomplete = setupMode ? 'new-password' : 'current-password';
}
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-error').textContent = '';
  try {
    const r = await api(setupMode ? '/setup' : '/login', { method: 'POST', body: { password: $('#auth-pass').value } });
    setToken(r.token);
    $('#auth-pass').value = '';
    start();
  } catch (err) { $('#auth-error').textContent = err.message; }
});

// ---------------- başlat ----------------
async function start() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  api('/settings', { method: 'POST', body: { tz: tz() } }).catch(() => {});
  await load();
  updateBanner();
  syncPush();
  const focus = new URLSearchParams(location.search).get('task');
  if (focus) {
    history.replaceState(null, '', '/');
    const t = findTask(focus);
    if (t && t.done_at == null) openAct(t); else flashTask(focus);
  }
}

async function load() {
  try {
    const d = await api('/tasks');
    state.active = d.active;
    state.archive = d.archive;
    render();
    updateBadge();
  } catch (e) { if (token) toast(e.message); }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && token) load(); });
setInterval(() => { if (!document.hidden && token && state.tab === 'active') renderActive(); }, 60000);

// ---------------- sekmeler ----------------
$$('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
function setTab(tab) {
  state.tab = tab;
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#view-active').hidden = tab !== 'active';
  $('#view-archive').hidden = tab !== 'archive';
  $('#view-stats').hidden = tab !== 'stats';
  $('#quick').hidden = tab !== 'active';
  $('#page-title').textContent = { active: 'İşlerim', archive: 'Arşiv', stats: 'Analiz' }[tab];
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  if (state.tab === 'active') renderActive();
  else if (state.tab === 'archive') renderArchive();
  else renderStats();
}

// ---------------- liste ----------------
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const REPEAT_NAMES = { daily: 'Her gün', weekdays: 'Hafta içi', weekly: 'Her hafta', monthly: 'Her ay' };

function whenHtml(t) {
  if (t.remind_at == null) return '';
  const now = Date.now();
  const cls = t.remind_at < now ? 'late' : t.remind_at - now < 2 * HOUR ? 'soon' : '';
  const label = formatWhen(t.remind_at, now, tz());
  return `<span class="${cls}">${t.remind_at < now ? 'Gecikti · ' : ''}${esc(label)}</span>`;
}

function itemHtml(t, archived = false) {
  const pc = `var(--p${t.priority})`;
  const meta = [];
  if (archived) {
    meta.push(`<span>Bitti: ${esc(formatWhen(t.done_at, Date.now(), tz()))}</span>`);
  } else {
    if (t.remind_at != null) meta.push(whenHtml(t));
    if (t.repeat) meta.push(`<span>↻ ${REPEAT_NAMES[t.repeat] || ''}</span>`);
    if (t.source === 'siri') meta.push('<span>Siri</span>');
  }
  return `<div class="item ${archived ? 'done' : ''}" data-id="${t.id}">
    <button class="check ${archived ? 'on' : ''}" style="--pc:${pc}" aria-label="${archived ? 'Geri al' : 'Tamamla'}" data-act="${archived ? 'restore' : 'done'}">${CHECK_SVG}</button>
    <div class="item-body" data-act="edit">
      <div class="item-title">${esc(t.title)}</div>
      ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
      ${t.notes && !archived ? `<div class="notes">${esc(t.notes)}</div>` : ''}
    </div>
    ${!archived && t.remind_at != null && t.remind_at < Date.now() ? `<button class="snooze-btn" data-act="act">Ertele</button>` : ''}
    ${archived ? `<div class="item-actions"><button class="icon-btn" data-act="delete" aria-label="Sil"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>` : ''}
  </div>`;
}

function renderActive() {
  const el = $('#view-active');
  if (!state.active.length) {
    el.innerHTML = `<div class="empty"><b>Yapılacak iş yok</b>Yukarıya yazarak ya da “Hey Siri, İşlerime ekle” diyerek yeni iş ekleyebilirsin.</div>`;
    return;
  }
  const sort = (a, b) => (a.remind_at ?? Infinity) - (b.remind_at ?? Infinity) || a.created_at - b.created_at;
  let html = '';
  for (const p of [3, 2, 1, 0]) {
    const items = state.active.filter((t) => t.priority === p).sort(sort);
    if (!items.length) continue;
    html += `<section class="group">
      <div class="group-head"><span class="dot" style="background:var(--p${p})"></span>${p ? PRIORITY_NAMES[p] + ' öncelik' : 'Önceliksiz'} <span class="count">${items.length}</span></div>
      <div class="list">${items.map((t) => itemHtml(t)).join('')}</div>
    </section>`;
  }
  el.innerHTML = html;
}

function renderArchive() {
  const el = $('#view-archive');
  if (!state.archive.length) {
    el.innerHTML = `<div class="empty"><b>Arşiv boş</b>Tamamladığın işler burada saklanır.</div>`;
    return;
  }
  // Güne göre grupla
  const groups = new Map();
  for (const t of state.archive) {
    const key = formatWhen(t.done_at, Date.now(), tz()).replace(/ \d\d:\d\d$/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  el.innerHTML = [...groups].map(([day, items]) => `<section class="group">
    <div class="group-head">${esc(day)} <span class="count">${items.length}</span></div>
    <div class="list">${items.map((t) => itemHtml(t, true)).join('')}</div>
  </section>`).join('');
}

function findTask(id) { return state.active.find((t) => t.id === id) || state.archive.find((t) => t.id === id); }

document.addEventListener('click', async (e) => {
  const actEl = e.target.closest('[data-act]');
  if (!actEl) return;
  const item = actEl.closest('.item');
  if (!item) return;
  const t = findTask(item.dataset.id);
  if (!t) return;
  const act = actEl.dataset.act;
  if (act === 'edit') openEdit(t);
  if (act === 'act') openAct(t);
  if (act === 'done') completeTask(t, actEl);
  if (act === 'restore') {
    await api(`/tasks/${t.id}`, { method: 'PATCH', body: { done: false } });
    toast('İş geri alındı');
    load();
  }
  if (act === 'delete') {
    if (!confirm(`“${t.title}” kalıcı olarak silinsin mi?`)) return;
    await api(`/tasks/${t.id}`, { method: 'DELETE' });
    load();
  }
});

async function completeTask(t, btn) {
  if (btn) btn.classList.add('on');
  try {
    const updated = await api(`/tasks/${t.id}`, { method: 'PATCH', body: { done: true } });
    if (updated.done_at) {
      toast('Tamamlandı, arşive taşındı', 'Geri al', async () => {
        await api(`/tasks/${t.id}`, { method: 'PATCH', body: { done: false } });
        load();
      });
    } else {
      toast(`Tamamlandı. Sonraki: ${formatWhen(updated.remind_at, Date.now(), tz())}`);
    }
    setTimeout(load, 250);
  } catch (e) { toast(e.message); if (btn) btn.classList.remove('on'); }
}

function flashTask(id) {
  const el = $(`.item[data-id="${CSS.escape(id)}"]`);
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
}

// ---------------- hızlı ekleme ----------------
const qi = $('#quick-input');
function updatePreview() {
  const v = qi.value.trim();
  const box = $('#preview');
  if (!v) { box.innerHTML = ''; return; }
  const p = parseTask(v, Date.now(), tz());
  const tags = [];
  if (p.remindAt) tags.push(`🕒 ${formatWhen(p.remindAt, Date.now(), tz())}`);
  if (p.priority) tags.push(`${['', '', '❗', '‼️'][p.priority]} ${PRIORITY_NAMES[p.priority]}`.trim());
  if (tags.length || p.title !== v) tags.unshift(`“${p.title}”`);
  box.innerHTML = tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
}
qi.addEventListener('input', updatePreview);
$('#quick').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = qi.value.trim();
  if (!v) return;
  const p = parseTask(v, Date.now(), tz());
  try {
    await api('/tasks', { method: 'POST', body: { title: p.title, priority: p.priority, remindAt: p.remindAt } });
    qi.value = '';
    updatePreview();
    await load();
    if (p.remindAt && Notification?.permission !== 'granted') updateBanner(true);
  } catch (err) { toast(err.message); }
});

// Ses tanıma (tarayıcı destekliyorsa). iPhone'da klavyedeki mikrofon da kullanılabilir.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const mic = $('#mic');
  mic.hidden = false;
  let rec = null;
  mic.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = 'tr-TR';
    rec.interimResults = true;
    mic.classList.add('rec');
    rec.onresult = (ev) => {
      qi.value = [...ev.results].map((r) => r[0].transcript).join(' ');
      updatePreview();
    };
    rec.onerror = () => toast('Ses tanıma kullanılamadı. Klavyedeki mikrofonu deneyebilirsin.');
    rec.onend = () => { mic.classList.remove('rec'); rec = null; qi.focus(); };
    rec.start();
  });
}

// ---------------- düzenleme ----------------
const dlg = $('#edit');
const form = $('#edit-form');
const toLocalInput = (ms) => {
  if (ms == null) return '';
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
function setPriority(p) {
  state.priority = p;
  $$('#seg-priority button').forEach((b) => b.classList.toggle('on', +b.dataset.p === p));
}
$$('#seg-priority button').forEach((b) => b.addEventListener('click', () => setPriority(+b.dataset.p)));

function openEdit(t) {
  state.editing = t;
  form.title.value = t.title;
  form.notes.value = t.notes || '';
  form.when.value = toLocalInput(t.remind_at);
  form.repeat.value = t.repeat || '';
  setPriority(t.priority);
  const archived = t.done_at != null;
  $('#edit-done').textContent = archived ? 'Geri al' : 'Tamamlandı';
  dlg.showModal();
}
$$('[data-when]').forEach((b) => b.addEventListener('click', () => {
  const now = new Date();
  let d = null;
  if (b.dataset.when === '1h') d = new Date(Date.now() + HOUR);
  if (b.dataset.when === 'eve') { d = new Date(now); d.setHours(19, 0, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); }
  if (b.dataset.when === 'tom') { d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  form.when.value = d ? toLocalInput(d.getTime()) : '';
}));
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = state.editing;
  if (!t) return;
  const remindAt = form.when.value ? new Date(form.when.value).getTime() : null;
  try {
    await api(`/tasks/${t.id}`, { method: 'PATCH', body: { title: form.title.value, notes: form.notes.value, priority: state.priority, remindAt, repeat: form.repeat.value } });
    dlg.close();
    load();
  } catch (err) { toast(err.message); }
});
$('#edit-done').addEventListener('click', async () => {
  const t = state.editing;
  dlg.close();
  if (t.done_at != null) { await api(`/tasks/${t.id}`, { method: 'PATCH', body: { done: false } }); load(); }
  else completeTask(t);
});
$('#edit-delete').addEventListener('click', async () => {
  const t = state.editing;
  if (!confirm(`“${t.title}” silinsin mi?`)) return;
  await api(`/tasks/${t.id}`, { method: 'DELETE' });
  dlg.close();
  load();
});

// ---------------- bildirimler ----------------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function b64ToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/vapid');
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // Anahtar değiştiyse yeniden abone ol
    const cur = sub.options?.applicationServerKey;
    if (cur && btoa(String.fromCharCode(...new Uint8Array(cur))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api('/subscribe', { method: 'POST', body: sub.toJSON() });
}

async function syncPush() {
  if (pushSupported && Notification.permission === 'granted') {
    try { await subscribePush(); } catch (e) { console.warn(e); }
  }
  updatePushStatus();
}

async function enablePush() {
  if (!pushSupported) {
    toast(isIOS && !isStandalone ? 'Önce uygulamayı ana ekrana eklemelisin.' : 'Bu tarayıcı bildirimleri desteklemiyor.');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Bildirim izni verilmedi. Ayarlar > Bildirimler bölümünden açabilirsin.'); updatePushStatus(); return; }
  try {
    await subscribePush();
    toast('Bildirimler açıldı');
  } catch (e) { toast('Bildirim açılamadı: ' + e.message); }
  updateBanner();
  updatePushStatus();
}

function updatePushStatus() {
  const s = $('#push-status');
  if (!s) return;
  if (isIOS && !isStandalone) s.textContent = 'iPhone’da bildirim için uygulamayı ana ekrana ekleyip oradan açmalısın.';
  else if (!pushSupported) s.textContent = 'Bu tarayıcı bildirimleri desteklemiyor.';
  else if (Notification.permission === 'granted') s.textContent = 'Bildirimler açık. Bu cihaza hatırlatma gelecek.';
  else if (Notification.permission === 'denied') s.textContent = 'Bildirimler engellenmiş. Telefon Ayarları > Bildirimler > İşlerim bölümünden aç.';
  else s.textContent = 'Bildirimler kapalı. Hatırlatma almak için aç.';
  $('#push-enable').hidden = pushSupported && Notification.permission === 'granted';
}

function updateBanner(force) {
  const b = $('#banner');
  if (isIOS && !isStandalone) {
    b.innerHTML = `<b>Ana ekrana ekle</b>Hatırlatma bildirimleri için Safari’de alttaki <b style="display:inline">Paylaş</b> düğmesine dokun, sonra <b style="display:inline">Ana Ekrana Ekle</b>’yi seç ve uygulamayı ana ekrandan aç.`;
    b.hidden = false;
  } else if (pushSupported && Notification.permission === 'default') {
    b.innerHTML = `<b>Bildirimleri aç</b>Hatırlatmaların zamanında gelmesi için bildirim izni ver.<br><button class="btn primary small" id="banner-push">Bildirimleri aç</button>`;
    b.hidden = false;
    $('#banner-push').onclick = enablePush;
  } else {
    b.hidden = true;
  }
}

// ---------------- ayarlar ----------------
$('#open-settings').addEventListener('click', async () => {
  updatePushStatus();
  loadPrefs();
  $('#settings').showModal();
  try {
    const { key } = await api('/siri-key');
    $('#siri-url').textContent = `${location.origin}/api/quick?key=${key}`;
  } catch {}
});
$('#push-enable').addEventListener('click', enablePush);
$('#push-test').addEventListener('click', async () => {
  try {
    const r = await api('/test-push', { method: 'POST' });
    toast(r.total ? `Bildirim gönderildi (${r.sent}/${r.total} cihaz)` : 'Kayıtlı cihaz yok. Önce bildirimleri aç.');
  } catch (e) { toast(e.message); }
});
$('#copy-siri').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#siri-url').textContent); toast('Adres kopyalandı'); }
  catch { toast('Kopyalanamadı, adresi elle seç.'); }
});
$('#reset-siri').addEventListener('click', async () => {
  if (!confirm('Eski adres çalışmayı bırakacak. Kestirmedeki adresi de güncellemen gerekir. Devam edilsin mi?')) return;
  const { key } = await api('/siri-key', { method: 'POST' });
  $('#siri-url').textContent = `${location.origin}/api/quick?key=${key}`;
});
$('#logout').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch {}
  setToken(null);
  $('#settings').close();
  showAuth();
});

// ---------------- hızlı işlem ----------------
let actTask = null;
function openAct(t) {
  actTask = t;
  $('#act-title').textContent = t.title;
  $('#act-when').textContent = t.remind_at != null ? `${t.remind_at < Date.now() ? 'Gecikti · ' : ''}${formatWhen(t.remind_at, Date.now(), tz())}` : '';
  $('#act').showModal();
}
$('#act-done').addEventListener('click', () => { $('#act').close(); completeTask(actTask); });
$('#act-edit').addEventListener('click', () => { $('#act').close(); openEdit(actTask); });
$$('[data-snooze]').forEach((b) => b.addEventListener('click', async () => {
  const v = b.dataset.snooze;
  const now = new Date();
  let at;
  if (v === 'eve') { at = new Date(now); at.setHours(19, 0, 0, 0); if (at <= now) at.setDate(at.getDate() + 1); }
  else if (v === 'tom') { at = new Date(now); at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0); }
  else at = new Date(Date.now() + Number(v) * 60000);
  $('#act').close();
  try {
    await api(`/tasks/${actTask.id}`, { method: 'PATCH', body: { remindAt: at.getTime() } });
    toast(`Ertelendi: ${formatWhen(at.getTime(), Date.now(), tz())}`);
    load();
  } catch (e) { toast(e.message); }
}));

// ---------------- simge rozeti ----------------
function updateBadge() {
  if (!navigator.setAppBadge) return;
  const end = new Date(); end.setHours(24, 0, 0, 0);
  const n = state.active.filter((t) => t.remind_at != null && t.remind_at < end.getTime()).length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// ---------------- hatırlatma ayarları ----------------
async function loadPrefs() {
  try {
    const p = await api('/settings');
    $('#pref-nag').value = String(p.nag);
    $('#pref-nagmax').value = String(p.nagMax);
    $('#pref-summary').checked = !!p.summary;
    $('#pref-summary-time').value = p.summaryTime;
    $('#pref-nagmax').disabled = p.nag === 0;
  } catch {}
}
async function savePrefs() {
  const body = {
    nag: Number($('#pref-nag').value), nagMax: Number($('#pref-nagmax').value),
    summary: $('#pref-summary').checked, summaryTime: $('#pref-summary-time').value || '08:30',
  };
  $('#pref-nagmax').disabled = body.nag === 0;
  try { await api('/settings', { method: 'POST', body }); toast('Kaydedildi'); } catch (e) { toast(e.message); }
}
['#pref-nag', '#pref-nagmax', '#pref-summary', '#pref-summary-time'].forEach((s) => $(s).addEventListener('change', savePrefs));

// ---------------- analiz ----------------
let exportCache = null;
async function renderStats() {
  const el = $('#view-stats');
  if (!exportCache) el.innerHTML = '<div class="empty">Yükleniyor…</div>';
  try { exportCache = await api('/export'); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const { tasks, completions } = exportCache;
  const now = Date.now();
  const days = state.statsRange;
  const from = now - days * DAY;
  const off = tz() * 60000;
  const dayKey = (ms) => Math.floor((ms + off) / DAY);

  const added = tasks.filter((t) => t.created_at >= from);
  const done = completions.filter((c) => c.done_at >= from);
  const withTime = done.filter((c) => c.remind_at != null);
  const onTime = withTime.filter((c) => dayKey(c.done_at) <= dayKey(c.remind_at));
  const openLate = tasks.filter((t) => t.done_at == null && t.remind_at != null && t.remind_at < now);
  const durations = done.filter((c) => c.created_at && !tasks.find((t) => t.id === c.task_id && t.repeat)).map((c) => c.done_at - c.created_at);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const fmtDur = (ms) => ms == null ? '–' : ms < HOUR ? `${Math.max(1, Math.round(ms / 60000))} dk` : ms < DAY ? `${(ms / HOUR).toFixed(1).replace('.', ',')} sa` : `${(ms / DAY).toFixed(1).replace('.', ',')} gün`;

  // Haftalık (ya da 7 günlükte günlük) seriler
  const daily = days <= 7;
  const bucketCount = daily ? 7 : Math.ceil(days / 7);
  const bucketSize = daily ? DAY : 7 * DAY;
  const todayStart = (dayKey(now) + 1) * DAY - off; // yarın 00:00 (yerel)
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const end = todayStart - (bucketCount - 1 - i) * bucketSize;
    const start = end - bucketSize;
    const d = new Date(start + off);
    const label = daily ? ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'][d.getUTCDay()] : `${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
    return {
      label,
      added: tasks.filter((t) => t.created_at >= start && t.created_at < end).length,
      done: completions.filter((c) => c.done_at >= start && c.done_at < end).length,
    };
  });

  const byPri = [3, 2, 1, 0].map((p) => ({
    p, done: done.filter((c) => c.priority === p).length,
    open: tasks.filter((t) => t.done_at == null && t.priority === p).length,
  }));
  const maxPri = Math.max(1, ...byPri.map((x) => x.done + x.open));

  // En çok tekrar eden / en geç bitirilen işler
  const lateDone = withTime.filter((c) => dayKey(c.done_at) > dayKey(c.remind_at))
    .sort((a, b) => (b.done_at - b.remind_at) - (a.done_at - a.remind_at)).slice(0, 5);

  el.innerHTML = `
    <div class="range">${[7, 30, 90].map((d) => `<button data-range="${d}" class="${d === days ? 'on' : ''}">${d} gün</button>`).join('')}</div>
    <div class="kpis">
      <div class="kpi"><div class="v">${added.length}</div><div class="l">Eklenen iş</div></div>
      <div class="kpi"><div class="v">${done.length}</div><div class="l">Tamamlanan</div></div>
      <div class="kpi"><div class="v">${withTime.length ? Math.round((onTime.length / withTime.length) * 100) + '%' : '–'}</div><div class="l">Zamanında bitirilen</div></div>
      <div class="kpi"><div class="v" style="${openLate.length ? 'color:var(--late)' : ''}">${openLate.length}</div><div class="l">Şu an geciken</div></div>
    </div>
    <div class="panel">
      <h3>${daily ? 'Günlük' : 'Haftalık'} eklenen ve tamamlanan</h3>
      <p class="sub">Ortalama bitirme süresi: <b>${fmtDur(avg)}</b></p>
      <div class="chart">${barChart(buckets)}</div>
      <div class="legend"><span><i style="background:var(--p0)"></i>Eklenen</span><span><i style="background:var(--accent)"></i>Tamamlanan</span></div>
    </div>
    <div class="panel">
      <h3>Önem derecesine göre</h3>
      <p class="sub">Dolu kısım: son ${days} günde tamamlanan · Soluk kısım: hâlâ açık</p>
      <div class="bars">${byPri.map((x) => `
        <div class="bar-row"><span>${x.p ? PRIORITY_NAMES[x.p] : 'Önceliksiz'}</span>
          <div class="bar-track" style="display:flex">
            <div class="bar-fill" style="width:${(x.done / maxPri) * 100}%;background:var(--p${x.p});border-radius:0"></div>
            <div class="bar-fill" style="width:${(x.open / maxPri) * 100}%;background:var(--p${x.p});opacity:.3;border-radius:0"></div>
          </div>
          <span class="n">${x.done} / ${x.open}</span></div>`).join('')}
      </div>
    </div>
    ${lateDone.length ? `<div class="panel"><h3>En çok geciken işler</h3><p class="sub">Hatırlatma gününden sonra bitirilenler</p>
      <ol class="top-list">${lateDone.map((c) => `<li>${esc(c.title)} <span class="muted small">· ${fmtDur(c.done_at - c.remind_at)} geç</span></li>`).join('')}</ol></div>` : ''}
    <div class="panel">
      <h3>Excel’e aktar</h3>
      <p class="sub">Tüm işlerin (açık, tamamlanan ve tekrarlananlar) bir tablo dosyası olarak iner.</p>
      <button class="btn primary" id="export-csv">Excel dosyasını indir</button>
    </div>`;

  $$('[data-range]', el).forEach((b) => b.addEventListener('click', () => { state.statsRange = +b.dataset.range; renderStats(); }));
  $('#export-csv').addEventListener('click', exportCsv);
}

function barChart(buckets) {
  const W = 640, H = 200, pad = { l: 28, r: 8, t: 10, b: 24 };
  const max = Math.max(4, ...buckets.flatMap((b) => [b.added, b.done]));
  const nice = Math.ceil(max / 4) * 4;
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const bw = iw / buckets.length;
  const barW = Math.min(18, bw * 0.32);
  const y = (v) => pad.t + ih - (v / nice) * ih;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Eklenen ve tamamlanan iş grafiği">`;
  for (let i = 0; i <= 4; i++) {
    const v = (nice / 4) * i;
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`;
    svg += `<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  buckets.forEach((b, i) => {
    const cx = pad.l + bw * i + bw / 2;
    svg += `<rect x="${cx - barW - 1.5}" y="${y(b.added)}" width="${barW}" height="${ih + pad.t - y(b.added)}" rx="3" fill="var(--p0)"><title>${b.label}: ${b.added} eklenen</title></rect>`;
    svg += `<rect x="${cx + 1.5}" y="${y(b.done)}" width="${barW}" height="${ih + pad.t - y(b.done)}" rx="3" fill="var(--accent)"><title>${b.label}: ${b.done} tamamlanan</title></rect>`;
    if (buckets.length <= 14 || i % 2 === 0) svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  return svg + '</svg>';
}

function exportCsv() {
  const { tasks, completions } = exportCache;
  const fmt = (ms) => {
    if (ms == null) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Başlık', 'Not', 'Öncelik', 'Hatırlatma', 'Tekrar', 'Eklenme', 'Tamamlanma', 'Durum', 'Kaynak']];
  const repeatIds = new Set(tasks.filter((t) => t.repeat).map((t) => t.id));
  for (const t of tasks) {
    rows.push([t.title, t.notes, PRIORITY_NAMES[t.priority], fmt(t.remind_at), REPEAT_NAMES[t.repeat] || '', fmt(t.created_at), fmt(t.done_at),
      t.done_at ? 'Tamamlandı' : t.remind_at != null && t.remind_at < Date.now() ? 'Gecikmiş' : 'Açık', t.source === 'siri' ? 'Siri' : 'Uygulama']);
  }
  for (const c of completions.filter((c) => repeatIds.has(c.task_id))) {
    rows.push([c.title, '', PRIORITY_NAMES[c.priority], fmt(c.remind_at), 'Tekrarlanan', fmt(c.created_at), fmt(c.done_at), 'Tamamlandı (tekrar)', '']);
  }
  const csv = '\ufeff' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `islerim-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------- bildirim balonu ----------------
let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button>${esc(actionLabel)}</button>` : ''}`;
  t.hidden = false;
  if (actionLabel) $('button', t).onclick = () => { t.hidden = true; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 5000 : 3000);
}

// ---------------- açılış ----------------
if (token) start(); else showAuth();
