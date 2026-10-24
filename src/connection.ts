// シグナリングからWebRTCのデータチャネル確立まで（ホスト・ゲスト）
import { deriveRoom, randomId } from './crypto.ts';
import { Signaling, type BrokerState } from './signaling.ts';

export const CONNECT_TIMEOUT_MS = 30_000; // F-23
const JOIN_RESEND_MS = 3000;

export type GuestFailReason = 'broker' | 'nohost' | 'p2p';

export interface Controller {
  close(): void;
}

interface CommonOptions {
  secret: Uint8Array<ArrayBuffer>;
  brokers: readonly string[];
  stun: readonly string[];
  selfId: string;
  onConnected: (pc: RTCPeerConnection, dc: RTCDataChannel) => void;
}

function iceConfig(stun: readonly string[]): RTCConfiguration {
  return { iceServers: stun.length ? [{ urls: [...stun] }] : [] };
}

/** リモートSDPの設定前に届いたICE候補を貯めておく */
function candidateQueue(pc: RTCPeerConnection) {
  const pending: RTCIceCandidateInit[] = [];
  return {
    add(c: RTCIceCandidateInit) {
      if (pc.remoteDescription) pc.addIceCandidate(c).catch(() => {});
      else pending.push(c);
    },
    flush() {
      for (const c of pending.splice(0)) pc.addIceCandidate(c).catch(() => {});
    },
  };
}

/** ホストとして待機する。最初の参加要求のみ受け付ける（S-05） */
export async function startHost(
  opts: CommonOptions & { onJoin: () => void; onFail: () => void; onBrokerChange?: (s: BrokerState) => void },
): Promise<Controller> {
  const room = await deriveRoom(opts.secret);
  let guest: string | null = null;
  let attempt: string | null = null;
  let pc: RTCPeerConnection | null = null;
  let queue: ReturnType<typeof candidateQueue> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const sig = new Signaling({
    brokers: opts.brokers,
    room,
    selfId: opts.selfId,
    onBrokerChange: opts.onBrokerChange,
    onMessage: (msg) => {
      if (done) return;
      if (msg.type === 'join') {
        if (guest && msg.from !== guest) return; // 2人目以降は無視
        if (msg.attempt === attempt) return; // 同じ試行の再送
        guest = msg.from;
        attempt = msg.attempt;
        void startPeer(guest, attempt);
        return;
      }
      if (msg.from !== guest || msg.attempt !== attempt || !pc || !queue) return;
      if (msg.type === 'answer' && msg.sdp) {
        const q = queue;
        pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
          .then(() => q.flush())
          .catch(() => {});
      } else if (msg.type === 'ice' && msg.candidate) {
        queue.add(msg.candidate);
      }
    },
  });

  async function startPeer(to: string, myAttempt: string) {
    pc?.close();
    clearTimeout(timer);
    opts.onJoin();
    timer = setTimeout(fail, CONNECT_TIMEOUT_MS);

    const peer = new RTCPeerConnection(iceConfig(opts.stun));
    pc = peer;
    queue = candidateQueue(peer);
    const dc = peer.createDataChannel('direct-share', { ordered: true });
    peer.onicecandidate = (e) => {
      if (e.candidate) void sig.send({ type: 'ice', to, attempt: myAttempt, candidate: e.candidate.toJSON() });
    };
    peer.onconnectionstatechange = () => {
      if (peer === pc && peer.connectionState === 'failed') fail();
    };
    dc.onopen = () => {
      if (done || peer !== pc) return;
      done = true;
      clearTimeout(timer);
      sig.close();
      opts.onConnected(peer, dc);
    };
    try {
      await peer.setLocalDescription(await peer.createOffer());
      void sig.send({ type: 'offer', to, attempt: myAttempt, sdp: peer.localDescription?.sdp });
    } catch {
      fail();
    }
  }

  function fail() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    sig.close();
    pc?.close();
    opts.onFail();
  }

  sig.start();
  return {
    close() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sig.close();
      pc?.close();
    },
  };
}

/** ゲストとして接続する */
export async function startGuest(opts: CommonOptions & { onFail: (reason: GuestFailReason) => void }): Promise<Controller> {
  const room = await deriveRoom(opts.secret);
  const attempt = randomId(4);
  let pc: RTCPeerConnection | null = null;
  let queue: ReturnType<typeof candidateQueue> | null = null;
  const earlyCandidates: RTCIceCandidateInit[] = []; // オファーより先に届いたICE候補
  let done = false;
  let brokerState: BrokerState = { ready: 0, failed: 0, total: opts.brokers.length };

  const sig = new Signaling({
    brokers: opts.brokers,
    room,
    selfId: opts.selfId,
    onBrokerChange: (s) => {
      brokerState = s;
      if (s.ready === 0 && s.failed === s.total) fail('broker');
    },
    onMessage: (msg) => {
      if (done || msg.to !== opts.selfId || msg.attempt !== attempt) return;
      if (msg.type === 'offer' && msg.sdp && !pc) {
        void accept(msg.sdp);
      } else if (msg.type === 'ice' && msg.candidate) {
        if (queue) queue.add(msg.candidate);
        else earlyCandidates.push(msg.candidate);
      }
    },
  });

  async function accept(sdp: string) {
    clearInterval(joinTimer);
    const peer = new RTCPeerConnection(iceConfig(opts.stun));
    pc = peer;
    queue = candidateQueue(peer);
    peer.onicecandidate = (e) => {
      if (e.candidate) void sig.send({ type: 'ice', attempt, candidate: e.candidate.toJSON() });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') fail('p2p');
    };
    peer.ondatachannel = (e) => {
      const dc = e.channel;
      dc.onopen = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sig.close();
        opts.onConnected(peer, dc);
      };
    };
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp });
      for (const c of earlyCandidates) queue.add(c);
      await peer.setLocalDescription(await peer.createAnswer());
      void sig.send({ type: 'answer', attempt, sdp: peer.localDescription?.sdp });
    } catch {
      fail('p2p');
    }
  }

  function fail(reason: GuestFailReason) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(joinTimer);
    sig.close();
    pc?.close();
    opts.onFail(reason);
  }

  const timer = setTimeout(() => {
    if (brokerState.ready === 0) fail('broker');
    else fail(pc ? 'p2p' : 'nohost');
  }, CONNECT_TIMEOUT_MS);

  // 参加要求はオファーが届くまで定期的に再送する
  const sendJoin = () => void sig.send({ type: 'join', attempt });
  const joinTimer = setInterval(sendJoin, JOIN_RESEND_MS);
  sig.start();
  sendJoin();

  return {
    close() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(joinTimer);
      sig.close();
      pc?.close();
    },
  };
}
