// 接続後のデータ送受信（4.4, 4.5）
import { randomId } from './crypto.ts';

export const MAX_TEXT_LENGTH = 100_000; // F-36
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // F-50
export const MAX_HELD_BYTES = 100 * 1024 * 1024; // F-51

const TEXT_PART_LENGTH = 16_000; // UTF-8 でも1メッセージ64KB未満に収まる長さ
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;

export const NO_SPACE_MESSAGE = '受信側の空きが足りません。保存または破棄が必要です';

export type FileStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'receiving'
  | 'received'
  | 'released'
  | 'cancelled'
  | 'rejected'
  | 'failed';

export interface TextItem {
  kind: 'text';
  id: string;
  mine: boolean;
  ts: number;
  body: string;
}

export interface FileItem {
  kind: 'file';
  id: string;
  mine: boolean;
  ts: number;
  name: string;
  size: number;
  mime: string;
  status: FileStatus;
  transferred: number;
  blob: Blob | null;
  saved: boolean;
  file: File | null;
}

export type Item = TextItem | FileItem;

type RejectReason = 'nospace' | 'toolarge';

type Wire =
  | { t: 'text'; id: string; part: number; total: number; body: string }
  | { t: 'file'; id: string; name: string; size: number; mime: string }
  | { t: 'end'; id: string }
  | { t: 'cancel'; id: string }
  | { t: 'reject'; id: string; reason: RejectReason }
  | { t: 'bye' };

export type CloseReason = 'local' | 'peer';

export interface SessionEvents {
  /** 履歴の項目が追加・更新された */
  onItem: (item: Item) => void;
  /** トーストで知らせる内容 */
  onNotice: (message: string) => void;
  /** ファイル転送中かどうかが変わった */
  onBusyChange: (busy: boolean) => void;
  onClose: (reason: CloseReason) => void;
}

interface Incoming {
  item: FileItem;
  chunks: ArrayBuffer[];
}

export class Session {
  readonly items = new Map<string, Item>();
  private queue: FileItem[] = [];
  private sending: FileItem | null = null;
  private incoming: Incoming | null = null;
  private textParts = new Map<string, string[]>();
  private busy = false;
  private ended = false;
  private readonly chunkSize: number;
  private readonly pc: RTCPeerConnection;
  private readonly dc: RTCDataChannel;
  private readonly events: SessionEvents;

  constructor(pc: RTCPeerConnection, dc: RTCDataChannel, events: SessionEvents) {
    this.pc = pc;
    this.dc = dc;
    this.events = events;
    const max = pc.sctp?.maxMessageSize || 65536;
    this.chunkSize = Math.min(64 * 1024, max);

    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (typeof e.data === 'string') this.handleJson(e.data);
      else this.handleChunk(e.data);
    };
    dc.onclose = () => this.end('peer');
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.end('peer');
    });
  }

  // ---- 送信 ----

  /** エラーがあればメッセージを返す */
  sendText(body: string): string | null {
    if (body.length > MAX_TEXT_LENGTH) {
      return `テキストは${MAX_TEXT_LENGTH.toLocaleString()}文字までです（現在：${body.length.toLocaleString()}文字）`;
    }
    const id = randomId();
    const total = Math.max(1, Math.ceil(body.length / TEXT_PART_LENGTH));
    for (let part = 0; part < total; part++) {
      const piece = body.slice(part * TEXT_PART_LENGTH, (part + 1) * TEXT_PART_LENGTH);
      this.send({ t: 'text', id, part, total, body: piece });
    }
    this.add({ kind: 'text', id, mine: true, ts: Date.now(), body });
    return null;
  }

  sendFiles(files: Iterable<File>): void {
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        this.events.onNotice(`「${file.name}」は100MBを超えるため送信できません`);
        continue;
      }
      const item: FileItem = {
        kind: 'file',
        id: randomId(),
        mine: true,
        ts: Date.now(),
        name: file.name,
        size: file.size,
        mime: file.type,
        status: 'queued',
        transferred: 0,
        blob: null,
        saved: false,
        file,
      };
      this.queue.push(item);
      this.add(item);
    }
    this.updateBusy();
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    for (let item = this.queue.shift(); item && !this.ended; item = this.queue.shift()) {
      if (item.status !== 'queued' || !item.file) continue;
      this.sending = item;
      item.status = 'sending';
      this.emit(item);
      try {
        await this.sendFile(item, item.file);
      } catch {
        if (!this.ended) this.setStatus(item, 'failed');
      }
      this.sending = null;
    }
    this.updateBusy();
  }

  private async sendFile(item: FileItem, file: File): Promise<void> {
    this.send({ t: 'file', id: item.id, name: item.name, size: item.size, mime: item.mime });
    let offset = 0;
    let lastEmit = 0;
    while (offset < item.size) {
      if (this.ended || item.status !== 'sending') return;
      if (this.dc.bufferedAmount > HIGH_WATER) {
        await this.waitBufferLow();
        continue;
      }
      const buf = await file.slice(offset, offset + this.chunkSize).arrayBuffer();
      if (this.ended || item.status !== 'sending') return;
      this.dc.send(buf);
      offset += buf.byteLength;
      if (Date.now() - lastEmit > PROGRESS_INTERVAL_MS) {
        lastEmit = Date.now();
        item.transferred = Math.max(0, offset - this.dc.bufferedAmount);
        this.emit(item);
      }
    }
    this.send({ t: 'end', id: item.id });
    // 相手に届くまで（送信バッファが空になるまで）進捗を更新する
    while (this.dc.bufferedAmount > 0 && !this.ended && item.status === 'sending') {
      await new Promise((r) => setTimeout(r, PROGRESS_INTERVAL_MS));
      item.transferred = Math.max(0, item.size - this.dc.bufferedAmount);
      this.emit(item);
    }
    if (item.status !== 'sending') return;
    item.transferred = item.size;
    item.file = null;
    this.setStatus(item, 'sent');
  }

  private waitBufferLow(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.dc.removeEventListener('bufferedamountlow', done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      this.dc.addEventListener('bufferedamountlow', done);
    });
  }

  /** 送信中・送信待ち・受信中のファイルをキャンセルする（F-46） */
  cancel(id: string): void {
    const item = this.items.get(id);
    if (item?.kind !== 'file') return;
    if (item.mine && (item.status === 'queued' || item.status === 'sending')) {
      if (item.status === 'sending') this.send({ t: 'cancel', id });
      item.file = null;
      this.setStatus(item, 'cancelled');
    } else if (!item.mine && item.status === 'receiving' && this.incoming?.item === item) {
      this.send({ t: 'cancel', id });
      this.incoming = null;
      this.setStatus(item, 'cancelled');
    }
    this.updateBusy();
  }

  // ---- 受信 ----

  private handleJson(data: string): void {
    let msg: Wire;
    try {
      msg = JSON.parse(data) as Wire;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'text': {
        const parts = this.textParts.get(msg.id) ?? [];
        parts[msg.part] = msg.body;
        if (parts.filter((p) => p !== undefined).length < msg.total) {
          this.textParts.set(msg.id, parts);
          return;
        }
        this.textParts.delete(msg.id);
        this.add({ kind: 'text', id: msg.id, mine: false, ts: Date.now(), body: parts.join('') });
        return;
      }
      case 'file':
        this.receiveFile(msg);
        return;
      case 'end': {
        const inc = this.incoming;
        if (!inc || inc.item.id !== msg.id) return;
        this.incoming = null;
        const received = inc.chunks.reduce((n, c) => n + c.byteLength, 0);
        if (received !== inc.item.size) {
          this.setStatus(inc.item, 'failed');
        } else {
          inc.item.blob = new Blob(inc.chunks, { type: inc.item.mime || 'application/octet-stream' });
          inc.item.transferred = inc.item.size;
          this.setStatus(inc.item, 'received');
        }
        this.updateBusy();
        return;
      }
      case 'cancel': {
        const item = this.items.get(msg.id);
        if (item?.kind !== 'file') return;
        if (item.mine && (item.status === 'sending' || item.status === 'queued')) {
          item.file = null;
          this.setStatus(item, 'cancelled');
          this.events.onNotice(`相手が「${item.name}」の受信をキャンセルしました`);
        } else if (!item.mine && this.incoming?.item === item) {
          this.incoming = null;
          this.setStatus(item, 'cancelled');
          this.events.onNotice(`相手が「${item.name}」の送信をキャンセルしました`);
        }
        this.updateBusy();
        return;
      }
      case 'reject': {
        const item = this.items.get(msg.id);
        if (item?.kind !== 'file' || !item.mine) return;
        item.file = null;
        this.setStatus(item, 'rejected');
        this.events.onNotice(
          msg.reason === 'nospace' ? NO_SPACE_MESSAGE : `「${item.name}」は相手側で受信できませんでした`,
        );
        this.updateBusy();
        return;
      }
      case 'bye':
        this.end('peer');
        return;
    }
  }

  private receiveFile(msg: Extract<Wire, { t: 'file' }>): void {
    if (this.incoming) {
      this.setStatus(this.incoming.item, 'failed');
      this.incoming = null;
    }
    const item: FileItem = {
      kind: 'file',
      id: msg.id,
      mine: false,
      ts: Date.now(),
      name: String(msg.name),
      size: Number(msg.size),
      mime: String(msg.mime ?? ''),
      status: 'receiving',
      transferred: 0,
      blob: null,
      saved: false,
      file: null,
    };
    let reject: RejectReason | null = null;
    if (!(item.size >= 0) || item.size > MAX_FILE_SIZE) reject = 'toolarge';
    else if (!this.ensureSpace(item.size)) reject = 'nospace';

    if (reject) {
      item.status = 'rejected';
      this.add(item);
      this.send({ t: 'reject', id: item.id, reason: reject });
      this.events.onNotice(reject === 'nospace' ? NO_SPACE_MESSAGE : `「${item.name}」は100MBを超えるため受信できません`);
      return;
    }
    this.incoming = { item, chunks: [] };
    this.add(item);
    this.updateBusy();
  }

  private lastProgress = 0;

  private handleChunk(buf: ArrayBuffer): void {
    const inc = this.incoming;
    if (!inc) return; // キャンセル・拒否したファイルの残り
    inc.chunks.push(buf);
    inc.item.transferred += buf.byteLength;
    if (inc.item.transferred > inc.item.size) {
      this.incoming = null;
      this.setStatus(inc.item, 'failed');
      this.updateBusy();
      return;
    }
    if (Date.now() - this.lastProgress > PROGRESS_INTERVAL_MS) {
      this.lastProgress = Date.now();
      this.emit(inc.item);
    }
  }

  /** 受信ファイルの保持量が上限を超えないよう、保存済みのものを古い順に解放する（F-51） */
  private ensureSpace(size: number): boolean {
    let held = this.heldBytes();
    for (const item of this.items.values()) {
      if (held + size <= MAX_HELD_BYTES) break;
      if (item.kind === 'file' && item.status === 'received' && item.saved) {
        held -= item.size;
        this.release(item.id);
      }
    }
    return held + size <= MAX_HELD_BYTES;
  }

  heldBytes(): number {
    let held = this.incoming?.item.size ?? 0;
    for (const item of this.items.values()) {
      if (item.kind === 'file' && item.blob) held += item.size;
    }
    return held;
  }

  markSaved(id: string): void {
    const item = this.items.get(id);
    if (item?.kind !== 'file' || item.saved) return;
    item.saved = true;
    this.emit(item);
  }

  /** 受信ファイルをメモリから解放する */
  release(id: string): void {
    const item = this.items.get(id);
    if (item?.kind !== 'file' || item.status !== 'received') return;
    item.blob = null;
    this.setStatus(item, 'released');
  }

  // ---- 共通 ----

  close(): void {
    if (this.ended) return;
    this.send({ t: 'bye' });
    this.end('local');
  }

  private end(reason: CloseReason): void {
    if (this.ended) return;
    this.ended = true;
    // F-64：履歴は破棄する
    this.queue = [];
    this.incoming = null;
    for (const item of this.items.values()) {
      if (item.kind === 'file') {
        item.blob = null;
        item.file = null;
      }
    }
    this.items.clear();
    try {
      this.dc.close();
    } catch {
      // 既に閉じている
    }
    this.pc.close();
    this.updateBusy();
    this.events.onClose(reason);
  }

  private send(msg: Wire): void {
    if (this.ended || this.dc.readyState !== 'open') return;
    try {
      this.dc.send(JSON.stringify(msg));
    } catch {
      this.end('peer');
    }
  }

  private add(item: Item): void {
    this.items.set(item.id, item);
    this.emit(item);
  }

  private setStatus(item: FileItem, status: FileStatus): void {
    item.status = status;
    this.emit(item);
  }

  private emit(item: Item): void {
    if (!this.ended) this.events.onItem(item);
  }

  private updateBusy(): void {
    const busy = !this.ended && (this.sending !== null || this.incoming !== null || this.queue.length > 0);
    if (busy === this.busy) return;
    this.busy = busy;
    this.events.onBusyChange(busy);
  }
}
