// 複数のMQTTブローカーを使った暗号化シグナリング（6.2, A-04）
import { decryptMessage, encryptMessage, randomId, type Room } from './crypto.ts';
import { MqttClient } from './mqtt.ts';

export interface SignalMessage {
  type: 'join' | 'offer' | 'answer' | 'ice';
  attempt: string;
  to?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export type ReceivedMessage = SignalMessage & { from: string; seq: number };

export interface BrokerState {
  ready: number;
  failed: number;
  total: number;
}

export interface SignalingOptions {
  brokers: readonly string[];
  room: Room;
  selfId: string;
  onMessage: (msg: ReceivedMessage) => void;
  onBrokerChange?: (s: BrokerState) => void;
}

export class Signaling {
  private clients: MqttClient[] = [];
  private ready = new Set<MqttClient>();
  private failed = 0;
  private sent: Uint8Array[] = []; // 後から接続できたブローカーにも再送するため保持
  private seen = new Set<string>();
  private seq = 0;
  private closed = false;
  private readonly opts: SignalingOptions;

  constructor(opts: SignalingOptions) {
    this.opts = opts;
  }

  start(): void {
    for (const url of this.opts.brokers) void this.connectBroker(url);
  }

  private async connectBroker(url: string): Promise<void> {
    const client: MqttClient = new MqttClient(url, {
      clientId: `ds-${randomId(6)}`,
      onMessage: (topic, payload) => void this.receive(topic, payload),
      onClose: () => {
        if (this.ready.delete(client)) this.failed++;
        this.notify();
      },
    });
    this.clients.push(client);
    try {
      await client.connect();
      await client.subscribe(this.opts.room.topic);
      if (this.closed) return client.close();
      this.ready.add(client);
      for (const payload of this.sent) client.publish(this.opts.room.topic, payload);
    } catch {
      if (this.closed) return;
      this.failed++;
      client.close();
    }
    this.notify();
  }

  private notify(): void {
    if (this.closed) return;
    this.opts.onBrokerChange?.({ ready: this.ready.size, failed: this.failed, total: this.opts.brokers.length });
  }

  async send(msg: SignalMessage): Promise<void> {
    const payload = await encryptMessage(this.opts.room, { ...msg, from: this.opts.selfId, seq: ++this.seq });
    if (this.closed) return;
    this.sent.push(payload);
    for (const client of this.ready) client.publish(this.opts.room.topic, payload);
  }

  private async receive(topic: string, payload: Uint8Array<ArrayBuffer>): Promise<void> {
    if (topic !== this.opts.room.topic || this.closed) return;
    const msg = await decryptMessage(this.opts.room, payload);
    if (!msg || this.closed || typeof msg.from !== 'string' || msg.from === this.opts.selfId) return;
    const id = `${msg.from}:${String(msg.seq)}`;
    if (this.seen.has(id)) return; // 複数ブローカーからの重複
    this.seen.add(id);
    this.opts.onMessage(msg as unknown as ReceivedMessage);
  }

  close(): void {
    this.closed = true;
    for (const client of this.clients) client.close();
  }
}
