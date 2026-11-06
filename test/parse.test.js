import { test } from 'node:test';
import assert from 'node:assert';
import { parseTask, formatWhen } from '../public/parse.js';

const NOW = Date.UTC(2026, 10, 6, 9, 0); // 6 Kasım 2026 Cuma, 12:00 (TR)
const p = (s) => { const r = parseTask(s, NOW, 180); return [r.title, r.priority, formatWhen(r.remindAt, NOW, 180)]; };

test('Türkçe ifadeler', () => {
  assert.deepEqual(p("yarın saat 10'da bankayı ara, önemli"), ['Bankayı ara', 2, 'Yarın 10:00']);
  assert.deepEqual(p('2 saat sonra annemi ara'), ['Annemi ara', 0, 'Bugün 14:00']);
  assert.deepEqual(p('haftaya salı 14:30 toplantı acil'), ['Toplantı', 3, 'Salı 14:30']);
  assert.deepEqual(p("saat 3'te raporu gönder"), ['Raporu gönder', 0, 'Bugün 15:00']);
  assert.deepEqual(p('15 kasım doktor randevusu'), ['Doktor randevusu', 0, '15 Kasım 09:00']);
  assert.deepEqual(p('süt al'), ['Süt al', 0, '']);
  assert.deepEqual(p('bugün akşam spor'), ['Spor', 0, 'Bugün 19:00']);
  assert.deepEqual(p('saat 9 kahvaltı'), ['Kahvaltı', 0, 'Yarın 09:00']);
  assert.deepEqual(p('cuma 10:00 sunum'), ['Sunum', 0, 'Cuma 10:00'.replace('Cuma', '13 Kasım')]);
});

test('Siri dikte biçimleri', () => {
  assert.deepEqual(p('yarın 10da bankayı ara önemli'), ['Bankayı ara', 2, 'Yarın 10:00']);
  assert.deepEqual(p('cuma akşam 7de faturayı öde acil'), ['Faturayı öde', 3, 'Bugün 19:00']);
  assert.deepEqual(p('Bana yarın saat 9’da ilaç almamı hatırlat'), ['İlaç al', 0, 'Yarın 09:00']);
  assert.deepEqual(p('pazartesi faturayı ödemeyi hatırlat'), ['Faturayı öde', 0, 'Pazartesi 09:00']);
});
