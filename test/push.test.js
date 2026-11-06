// Şifreleme testi: gönderilen bildirimi alıcı tarafında (RFC 8291) çözüp karşılaştırır.
import { test } from 'node:test';
import assert from 'node:assert';
import { encryptPayload, b64u, unb64u, generateVapid } from '../src/push.js';

const enc = new TextEncoder();
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

test('aes128gcm payload decrypts on the receiver side', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const body = await encryptPayload({ p256dh: b64u(uaPub), auth: b64u(auth) }, '{"title":"Merhaba ğüşıöç"}');

  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer).getUint32(16);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);

  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPub, ...asPub]);
  const ikm = await hkdf(auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  assert.equal(pt[pt.length - 1], 2);
  assert.equal(new TextDecoder().decode(pt.slice(0, -1)), '{"title":"Merhaba ğüşıöç"}');
});

test('vapid keys are valid P-256', async () => {
  const v = await generateVapid();
  assert.equal(unb64u(v.publicKey).length, 65);
  assert.equal(v.jwk.crv, 'P-256');
});
