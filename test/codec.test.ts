import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBase32, encodeBase32, formatCode, normalizeCode } from '../src/base32.ts';
import { buildUrl, parseHash, parseInput } from '../src/connInfo.ts';
import { decryptMessage, deriveRoom, encryptMessage, randomSecret } from '../src/crypto.ts';
import { encodeQr } from '../src/qr.ts';
import { validate } from '../src/settings.ts';

test('base32 は往復できて16文字になる', () => {
  for (let i = 0; i < 200; i++) {
    const secret = randomSecret();
    const code = encodeBase32(secret);
    assert.equal(code.length, 16);
    assert.deepEqual(decodeBase32(code), secret);
  }
});

test('手入力のゆれを吸収する', () => {
  assert.equal(normalizeCode(' 7k3q-m9xa 2pvd_8hrt '), '7K3QM9XA2PVD8HRT');
  assert.equal(normalizeCode('oOiIlL'), '001111');
  assert.equal(formatCode('7K3QM9XA2PVD8HRT'), '7K3Q-M9XA-2PVD-8HRT');
});

test('接続コード・URLを解釈する', () => {
  const secret = randomSecret();
  const brokers = ['wss://a.example/mqtt', 'wss://b.example:8081'];
  const url = buildUrl('https://u.github.io/direct-share/', secret, brokers);
  const fromUrl = parseInput(url);
  if (fromUrl.error !== undefined) assert.fail(fromUrl.error);
  assert.deepEqual(fromUrl.secret, secret);
  assert.deepEqual(fromUrl.brokers, brokers);

  const plain = buildUrl('https://u.github.io/direct-share/', secret, null);
  const code = plain.split('#')[1];
  const fromCode = parseInput(code.toLowerCase().replace(/-/g, ' '));
  if (fromCode.error !== undefined) assert.fail(fromCode.error);
  assert.deepEqual(fromCode.secret, secret);
  assert.equal(fromCode.brokers, null);

  assert.match(parseInput('7K3Q-M9XA').error ?? '', /16文字/);
  assert.match(parseInput('7K3Q-M9XA-2PVD-8HRU').error ?? '', /使えない文字/);
  assert.ok(parseHash('7K3QM9XA2PVD8HRT&b=http%3A%2F%2Fx').error);
  assert.ok(parseInput('https://u.github.io/direct-share/').error);
});

test('設定値の形式を検証する', () => {
  assert.deepEqual(validate('stun', ['stun:stun.l.google.com:19302']), []);
  assert.equal(validate('stun', ['turn:x']).length, 1);
  assert.equal(validate('mqtt', ['ws://x']).length, 1);
  assert.equal(validate('mqtt', []).length, 1);
  assert.equal(validate('mqtt', Array(6).fill('wss://x')).length, 1);
});

test('シグナリングの暗号は往復でき、改ざん・別の鍵を検知する', async () => {
  const room = await deriveRoom(randomSecret());
  const other = await deriveRoom(randomSecret());
  assert.match(room.topic, /^direct-share\/[0-9a-f]{32}$/);
  const ct = await encryptMessage(room, { type: 'join', n: 1 });
  assert.deepEqual(await decryptMessage(room, ct), { type: 'join', n: 1 });
  assert.equal(await decryptMessage(other, ct), null);
  ct[20] ^= 1;
  assert.equal(await decryptMessage(room, ct), null);
});

test('QRコードのサイズはバージョンに対応する', () => {
  assert.equal(encodeQr('a').length, 21);
  const m = encodeQr('https://example.github.io/direct-share/#7K3Q-M9XA-2PVD-8HRT');
  assert.equal((m.length - 17) % 4, 0);
  assert.throws(() => encodeQr('x'.repeat(3000)));
});
