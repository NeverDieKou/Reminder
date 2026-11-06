// Türkçe doğal dil ayrıştırıcı: "yarın saat 10'da bankayı ara, önemli"
// → { title: "Bankayı ara", priority: 2, remindAt: <ms> }
// Hem tarayıcıda hem de sunucuda (Cloudflare Worker) kullanılır.

const MONTHS = ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'];
// getUTCDay() sırası: 0 = pazar
const DAYS = ['pazar', 'pazartesi', 'salı', 'çarşamba', 'perşembe', 'cuma', 'cumartesi'];
const DAYS_CAP = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const MONTHS_CAP = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

const END = '(?=[\\s,.!?;]|$)';
const START = '(?<=^|[\\s,.;])';
const SUFFIX = "(?:['’]?(?:da|de|ta|te|dan|den|tan|ten|ya|ye|a|e|ı|i|u|ü))?";
const WORD_NUM = { bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10, yarım: 0.5 };

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export function parseTask(input, nowMs = Date.now(), tzOffsetMin = 180) {
  let text = ` ${String(input || '').trim()} `;
  let low = text.toLocaleLowerCase('tr');
  // Uzunluk değişirse (nadir) eşleştirmeyi küçük harf metinle yap.
  if (low.length !== text.length) text = low;

  const take = (re) => {
    const m = re.exec(low);
    if (!m) return null;
    const blank = ' '.repeat(m[0].length);
    low = low.slice(0, m.index) + blank + low.slice(m.index + m[0].length);
    text = text.slice(0, m.index) + blank + text.slice(m.index + m[0].length);
    return m;
  };
  const R = (src) => new RegExp(START + src + END, 'u');

  // --- Öncelik ---
  let priority = 0;
  if (take(R('(?:çok önemli|çok acil|acil|yüksek öncelik(?:li)?)'))) priority = 3;
  else if (take(R('(?:önemli|orta öncelik(?:li)?)'))) priority = 2;
  else if (take(R('(?:düşük öncelik(?:li)?|önemsiz|acele yok)'))) priority = 1;

  // --- Göreli zaman: "2 saat sonra", "yarım saat sonra", "10 dk sonra" ---
  let relative = null;
  const rel = take(R(`(\\d+|${Object.keys(WORD_NUM).join('|')})\\s*(dakika|dk|saat|gün|hafta)\\s*sonra`));
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? parseInt(rel[1], 10) : WORD_NUM[rel[1]];
    const unit = { dakika: MIN, dk: MIN, saat: HOUR, gün: DAY, hafta: 7 * DAY }[rel[2]];
    relative = nowMs + n * unit;
  }

  // --- Gün ---
  let dayOffset = null, weekday = null, nextWeek = false, monthDate = null;
  if (take(R("(?:yarından sonra|öbür gün|ertesi gün)" + SUFFIX))) dayOffset = 2;
  else if (take(R("yarın(?:ki)?" + SUFFIX))) dayOffset = 1;
  else if (take(R("bugün(?:kü)?" + SUFFIX))) dayOffset = 0;

  const wd = take(R(`(?:(bu|gelecek|haftaya|önümüzdeki)\\s+)?(pazartesi|salı|çarşamba|perşembe|cumartesi|cuma|pazar)(?:\\s*günü)?${SUFFIX}`));
  if (wd) {
    weekday = DAYS.indexOf(wd[2]);
    nextWeek = !!wd[1] && wd[1] !== 'bu';
  } else if (dayOffset === null && take(R('(?:haftaya|gelecek hafta)'))) {
    dayOffset = 7;
  }

  const md = take(R(`(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?${SUFFIX}`));
  if (md) monthDate = { d: parseInt(md[1], 10), m: MONTHS.indexOf(md[2]), y: md[3] ? parseInt(md[3], 10) : null };

  // --- Saat ---
  let hour = null, minute = 0, part = null;
  const p = take(R("(sabah|öğleden sonra|öğlen|öğle|akşam|gece)" + "(?:ki|leyin|ın|in|ları|leri)?"));
  if (p) part = p[1];

  let t = take(R(`(?:saat\\s*)?(\\d{1,2})[:.](\\d{2})${SUFFIX}`));
  if (t) { hour = +t[1]; minute = +t[2]; }
  else if ((t = take(R(`saat\\s*(\\d{1,2})(?:\\s*buçuk)?${SUFFIX}`)))) { hour = +t[1]; if (/buçuk/.test(t[0])) minute = 30; }
  else if ((t = take(R(`(\\d{1,2})['’]?(?:da|de|ta|te)`)))) { hour = +t[1]; }

  if (hour !== null && hour > 23) { hour = null; minute = 0; }
  if (hour !== null) {
    if (part && /akşam|gece|öğleden sonra/.test(part) && hour < 12) hour += 12;
    else if (!part && hour >= 1 && hour <= 6) hour += 12; // "saat 3'te" → 15:00
    if (part === 'gece' && hour === 24) hour = 0;
  } else if (part) {
    hour = { sabah: 9, öğle: 12, öğlen: 12, 'öğleden sonra': 15, akşam: 19, gece: 22 }[part];
  }

  // --- Hesapla ---
  let remindAt = null;
  if (relative !== null) {
    remindAt = relative;
  } else if (dayOffset !== null || weekday !== null || monthDate || hour !== null) {
    const local = new Date(nowMs + tzOffsetMin * MIN); // UTC alanları = yerel saat
    let y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    const hasTime = hour !== null;
    const h = hasTime ? hour : 9, mi = hasTime ? minute : 0;
    const toMs = (yy, mm, dd) => Date.UTC(yy, mm, dd, h, mi) - tzOffsetMin * MIN;

    if (monthDate) {
      y = monthDate.y ?? y;
      m = monthDate.m; d = monthDate.d;
      if (!monthDate.y && toMs(y, m, d) < nowMs - DAY) y += 1;
    } else if (weekday !== null) {
      const mon = (x) => (x + 6) % 7; // pazartesi = 0
      let delta = (weekday - local.getUTCDay() + 7) % 7;
      if (nextWeek) {
        // "haftaya cuma": hedef gün bu haftada hâlâ öndeyse bir hafta ileri at
        if (delta === 0 || mon(weekday) > mon(local.getUTCDay())) delta += 7;
      } else if (delta === 0 && toMs(y, m, d) <= nowMs) delta = 7;
      d += delta;
    } else if (dayOffset !== null) {
      d += dayOffset;
    } else if (toMs(y, m, d) <= nowMs) {
      d += 1; // sadece saat verilmiş ve geçmiş → yarın
    }
    remindAt = toMs(y, m, d);
  }

  // --- Başlığı temizle ---
  const askedReminder = /hatırlat/.test(low);
  let title = text
    .replace(/\s(?:bana|beni|lütfen|saat)(?=\s)/giu, ' ')
    .replace(/\s(?:diye\s+)?hatırlat(?:ır\s*mısın|abilir\s*misin|ma|sana)?(?=[\s,.!?]|$)/giu, ' ')
    .replace(/\s(?:için|diye)\s*$/iu, ' ')
    .replace(/\s+([,.!?;])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.;:!?-]+|[\s,.;:-]+$/g, '')
    .trim();
  // "ilaç almamı hatırlat" → "İlaç al", "faturayı ödemeyi hatırlat" → "Faturayı öde"
  if (askedReminder) title = title.replace(/(\S{2,}?)(?:m[ae]m[ıi]|m[ae]y[ıi])$/u, '$1');
  if (!title) title = String(input || '').trim();
  title = title.charAt(0).toLocaleUpperCase('tr') + title.slice(1);

  return { title, priority, remindAt };
}

const pad = (n) => String(n).padStart(2, '0');

// "Bugün 10:00", "Yarın 09:30", "Cuma 14:00", "12 Kasım 09:00"
export function formatWhen(ms, nowMs = Date.now(), tzOffsetMin = 180) {
  if (ms == null) return '';
  const L = new Date(ms + tzOffsetMin * MIN), N = new Date(nowMs + tzOffsetMin * MIN);
  const dayIdx = (x) => Math.floor(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) / DAY);
  const diff = dayIdx(L) - dayIdx(N);
  const time = `${pad(L.getUTCHours())}:${pad(L.getUTCMinutes())}`;
  let day;
  if (diff === 0) day = 'Bugün';
  else if (diff === 1) day = 'Yarın';
  else if (diff === -1) day = 'Dün';
  else if (diff > 1 && diff < 7) day = DAYS_CAP[L.getUTCDay()];
  else {
    day = `${L.getUTCDate()} ${MONTHS_CAP[L.getUTCMonth()]}`;
    if (L.getUTCFullYear() !== N.getUTCFullYear()) day += ` ${L.getUTCFullYear()}`;
  }
  return `${day} ${time}`;
}

export const PRIORITY_NAMES = ['Önceliksiz', 'Düşük', 'Orta', 'Yüksek'];
