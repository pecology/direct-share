// MQTT 3.1.1 over WebSocket の最小限のクライアント（接続・購読・送信・切断・死活確認、QoS 0のみ）
const enc = new TextEncoder();
const dec = new TextDecoder();

function str(s: string): number[] {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 0xff, ...b];
}

function packet(header: number, body: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const len: number[] = [];
  let n = body.length;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    len.push(byte);
  } while (n > 0);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = header;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

export interface MqttOptions {
  clientId: string;
  keepAlive?: number;
  onMessage?: (topic: string, payload: Uint8Array<ArrayBuffer>) => void;
  /** 接続確立後に切れた場合のみ呼ばれる */
  onClose?: () => void;
}

export class MqttClient {
  private ws: WebSocket | null = null;
  private buffer = new Uint8Array(0);
  private nextPacketId = 1;
  private pendingSubs = new Map<number, (ok: boolean) => void>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private onConnack: ((rc: number) => void) | null = null;
  private closed = false;
  private readonly url: string;
  private readonly opts: MqttOptions & { keepAlive: number };

  constructor(url: string, opts: MqttOptions) {
    this.url = url;
    this.opts = { keepAlive: 30, ...opts };
  }

  connect(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.close();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('timeout')), timeoutMs);
      this.onConnack = (rc) => {
        clearTimeout(timer);
        if (rc !== 0) return fail(new Error(`CONNACK ${rc}`));
        settled = true;
        this.pingTimer = setInterval(() => this.send(new Uint8Array([0xc0, 0])), (this.opts.keepAlive * 1000) / 2);
        resolve();
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url, 'mqtt');
      } catch (e) {
        clearTimeout(timer);
        fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const ka = this.opts.keepAlive;
        this.send(packet(0x10, [...str('MQTT'), 4, 0x02, ka >> 8, ka & 0xff, ...str(this.opts.clientId)]));
      };
      ws.onmessage = (e: MessageEvent<ArrayBuffer>) => this.receive(new Uint8Array(e.data));
      ws.onerror = () => fail(new Error('websocket error'));
      ws.onclose = () => {
        clearTimeout(timer);
        fail(new Error('closed'));
        this.handleClose();
      };
    });
  }

  subscribe(topic: string, timeoutMs = 8000): Promise<void> {
    const id = this.nextPacketId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSubs.delete(id);
        reject(new Error('subscribe timeout'));
      }, timeoutMs);
      this.pendingSubs.set(id, (ok) => {
        clearTimeout(timer);
        if (ok) resolve();
        else reject(new Error('subscribe refused'));
      });
      this.send(packet(0x82, [id >> 8, id & 0xff, ...str(topic), 0]));
    });
  }

  publish(topic: string, payload: Uint8Array): void {
    const t = str(topic);
    const body = new Uint8Array(t.length + payload.length);
    body.set(t);
    body.set(payload, t.length);
    this.send(packet(0x30, body));
  }

  private send(bytes: Uint8Array<ArrayBuffer>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    if (this.ws) {
      this.send(new Uint8Array([0xe0, 0]));
      try {
        this.ws.close();
      } catch {
        // 既に閉じている
      }
    }
  }

  private handleClose(): void {
    clearInterval(this.pingTimer);
    const wasOpen = !this.closed;
    this.closed = true;
    if (wasOpen) this.opts.onClose?.();
  }

  private receive(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    for (;;) {
      if (this.buffer.length < 2) return;
      let len = 0;
      let mul = 1;
      let i = 1;
      for (;;) {
        if (i >= this.buffer.length) return; // 長さが途中まで
        const b = this.buffer[i++];
        len += (b & 0x7f) * mul;
        mul *= 128;
        if ((b & 0x80) === 0) break;
        if (i > 4) {
          this.close();
          return;
        }
      }
      if (this.buffer.length < i + len) return;
      const header = this.buffer[0];
      const body = this.buffer.slice(i, i + len);
      this.buffer = this.buffer.slice(i + len);
      this.handlePacket(header, body);
    }
  }

  private handlePacket(header: number, body: Uint8Array<ArrayBuffer>): void {
    switch (header >> 4) {
      case 2: // CONNACK
        this.onConnack?.(body[1]);
        break;
      case 3: {
        // PUBLISH
        const qos = (header >> 1) & 3;
        const topicLen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.slice(2, 2 + topicLen));
        let offset = 2 + topicLen;
        if (qos > 0) {
          const id = [body[offset], body[offset + 1]];
          offset += 2;
          if (qos === 1) this.send(new Uint8Array([0x40, 2, ...id])); // PUBACK
        }
        this.opts.onMessage?.(topic, body.slice(offset));
        break;
      }
      case 9: {
        // SUBACK
        const id = (body[0] << 8) | body[1];
        const cb = this.pendingSubs.get(id);
        this.pendingSubs.delete(id);
        cb?.(body[2] !== 0x80);
        break;
      }
      default:
        // PINGRESP など
        break;
    }
  }
}
