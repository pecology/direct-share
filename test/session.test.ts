import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_HELD_BYTES, NO_SPACE_MESSAGE, Session, type FileItem, type Item } from '../src/session.ts';

/** 2つのセッションを直結する偽のデータチャネル */
class FakeChannel extends EventTarget {
  peer!: FakeChannel;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState = 'open';
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string | ArrayBuffer) {
    const copy = typeof data === 'string' ? data : data.slice(0);
    const size = typeof data === 'string' ? data.length : data.byteLength;
    this.bufferedAmount += size;
    setTimeout(() => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= size;
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.dispatchEvent(new Event('bufferedamountlow'));
      }
      this.peer.onmessage?.({ data: copy });
    });
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    setTimeout(() => {
      this.peer.close();
      this.peer.onclose?.();
    });
  }
}

const fakePc = () => ({ sctp: null, connectionState: 'connected', addEventListener() {}, close() {} });

function pair() {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  const notices = { a: [] as string[], b: [] as string[] };
  const closed = { a: '', b: '' };
  const make = (dc: FakeChannel, side: 'a' | 'b') =>
    new Session(fakePc() as unknown as RTCPeerConnection, dc as unknown as RTCDataChannel, {
      onItem: () => {},
      onNotice: (m) => notices[side].push(m),
      onBusyChange: () => {},
      onClose: (r) => (closed[side] = r),
    });
  return { sa: make(a, 'a'), sb: make(b, 'b'), notices, closed };
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'timeout');
}

const files = (s: Session) => [...s.items.values()].filter((i: Item): i is FileItem => i.kind === 'file');
const byName = (s: Session, name: string) => files(s).find((i) => i.name === name);

test('長いテキストも分割して届く', async () => {
  const { sa, sb } = pair();
  const body = 'あいう\n'.repeat(25_000); // 10万文字
  assert.equal(sa.sendText(body), null);
  await until(() => sb.items.size === 1);
  const got = [...sb.items.values()][0];
  assert.equal(got.kind === 'text' && got.body, body);
  assert.match(sa.sendText(body + 'x') ?? '', /100,000/);
});

test('ファイルが分割送信され、同じ内容で受信される', async () => {
  const { sa, sb } = pair();
  const data = new Uint8Array(300_000).map((_, i) => (i * 7) & 0xff);
  sa.sendFiles([new File([data], 'a.bin', { type: 'application/x-test' }), new File([], 'empty.txt')]);
  await until(() => files(sb).filter((i) => i.status === 'received').length === 2);
  const blob = byName(sb, 'a.bin')?.blob;
  assert.ok(blob);
  assert.equal(blob.type, 'application/x-test');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), data);
  await until(() => files(sa).every((i) => i.status === 'sent'));
});

test('送信中のファイルをキャンセルすると両側で止まる', async () => {
  const { sa, sb } = pair();
  sa.sendFiles([new File([new Uint8Array(50 * 1024 * 1024)], 'big.bin')]);
  await until(() => byName(sb, 'big.bin')?.status === 'receiving');
  sa.cancel(byName(sa, 'big.bin')!.id);
  await until(() => byName(sb, 'big.bin')?.status === 'cancelled');
  assert.equal(byName(sa, 'big.bin')?.status, 'cancelled');
  assert.equal(sb.heldBytes(), 0);
});

test('受信側の空きが足りなければ保存済みを解放し、それでも足りなければ拒否する', async () => {
  const { sa, sb, notices } = pair();
  const big = (name: string) => new File([new Uint8Array(MAX_HELD_BYTES * 0.6)], name);
  sa.sendFiles([big('1.bin')]);
  await until(() => byName(sb, '1.bin')?.status === 'received');

  // 未保存のままだと拒否される
  sa.sendFiles([big('2.bin')]);
  await until(() => byName(sa, '2.bin')?.status === 'rejected');
  assert.equal(byName(sb, '2.bin')?.status, 'rejected');
  assert.ok(notices.a.includes(NO_SPACE_MESSAGE));
  assert.ok(notices.b.includes(NO_SPACE_MESSAGE));

  // 保存済みにすると古い順に自動で解放されて受信できる
  sb.markSaved(byName(sb, '1.bin')!.id);
  sa.sendFiles([big('3.bin')]);
  await until(() => byName(sb, '3.bin')?.status === 'received');
  assert.equal(byName(sb, '1.bin')?.status, 'released');
});

test('100MBを超えるファイルは送信前に拒否する', () => {
  const { sa, notices } = pair();
  const huge = { name: 'huge.bin', size: 100 * 1024 * 1024 + 1, type: '' } as File;
  sa.sendFiles([huge]);
  assert.equal(sa.items.size, 0);
  assert.match(notices.a[0], /100MB/);
});

test('切断すると相手に通知され、履歴が破棄される', async () => {
  const { sa, sb, closed } = pair();
  sa.sendText('hi');
  await until(() => sb.items.size === 1);
  sa.close();
  await until(() => closed.b === 'peer');
  assert.equal(closed.a, 'local');
  assert.equal(sb.items.size, 0);
});
