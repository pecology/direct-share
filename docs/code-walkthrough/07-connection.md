# 第7回 `src/connection.ts`：WebRTC の接続確立

このファイルは、第6回のシグナリングを使って、**ホストとゲストの端末を WebRTC で直接つなぐ**部品です。接続できたら、データをやり取りするための「データチャネル」を画面側（`main.ts`）に渡します。

- `startHost()`：ホストとして待ち、最初に来たゲストとだけ接続する
- `startGuest()`：ゲストとしてホストに接続する。30秒でつながらなければ、原因の候補を添えて失敗を知らせる

---

## 1. 前提知識

### 1-1. WebRTC とは

WebRTC は、**ブラウザ同士が直接データをやり取りする**ための仕組みです。ブラウザの標準機能で、ビデオ通話などに広く使われています。direct-share では、映像や音声は使わず、テキストやファイルを送る「データチャネル」だけを使います。

ただし、いきなり相手につなぐことはできません。次の3つの問題を解決する必要があるからです。

| 問題 | 解決する仕組み |
|---|---|
| 相手がどんな条件で通信できるか分からない | **SDP**（通信条件の説明書）を交換する |
| 相手のアドレスが分からない。家庭のルーターの内側にいると、外から直接届かない | **ICE**（通れる経路を探す）と **STUN**（外から見た自分のアドレスを調べる） |
| 通信の相手が本物か、盗聴されていないか | **DTLS**（暗号化と相手の確認） |

SDP と ICE 候補の交換を、シグナリング（第6回）で行います。

### 1-2. 接続までの流れ（オファーとアンサー）

```
ホスト（オファーする側）                              ゲスト（アンサーする側）
 │                                                     │
 │  ←────────────── join（参加したい）──────────────── │
 │                                                     │
 │ RTCPeerConnection を作る                             │
 │ データチャネルを作る                                  │
 │ createOffer：自分の条件を SDP にする                   │
 │ setLocalDescription：それを自分の条件として確定         │
 │  ─────────────── offer（SDP）──────────────────────→ │
 │                                                     │ RTCPeerConnection を作る
 │                                                     │ setRemoteDescription：相手の条件として設定
 │                                                     │ createAnswer：自分の条件を SDP にする
 │                                                     │ setLocalDescription：確定
 │  ←────────────── answer（SDP）──────────────────── │
 │ setRemoteDescription：相手の条件として設定             │
 │                                                     │
 │  ←────────── ice（アドレスの候補）を見つけ次第 ──────→ │  （両方向、何回も）
 │                                                     │
 │  ◀═══ 候補の組み合わせを試し、通れる経路を見つける ════▶ │
 │  ◀═══ DTLS で暗号化と相手の確認 ════════════════════▶ │
 │  ◀═══ データチャネルが開く（onopen）════════════════▶ │
```

- **オファー**：「こういう条件で通信しませんか」という提案。接続を始める側（ホスト）が作る
- **アンサー**：「その条件でいきましょう。こちらの条件はこうです」という返事
- **ローカル**（local）は自分、**リモート**（remote）は相手のこと

### 1-3. SDP

SDP（Session Description Protocol）は、通信の条件を書いたテキストです。実際にこのアプリと同じ設定で作ったオファーの SDP（715文字）を示します（IP アドレスなどは例示用に置き換えています）。

```
v=0
o=- 7180636086140838263 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
m=application 55100 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 203.0.113.45
a=candidate:1833421630 1 udp 2113937151 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.local 55100 typ host …
a=candidate:384853813 1 udp 1677729535 203.0.113.45 55100 typ srflx raddr 0.0.0.0 rport 0 …
a=ice-ufrag:g8hK
a=ice-pwd:dC+I6ufcfa2efx3TZmZWNit4
a=ice-options:trickle
a=fingerprint:sha-256 76:18:9B:94:…:8D:2C
a=setup:actpass
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
```

主な行の意味：

| 行 | 意味 |
|---|---|
| `m=application … webrtc-datachannel` | データチャネルを使う。`UDP/DTLS/SCTP` は、UDP の上で DTLS（暗号化）、その上で SCTP（データの運搬）を使うという意味 |
| `a=candidate:…` | アドレスの候補（ICE 候補）。後述 |
| `a=ice-ufrag`、`a=ice-pwd` | この接続専用の合言葉。経路を確かめるときに、相手が本物か確認するのに使う |
| `a=ice-options:trickle` | ICE 候補を、見つけ次第少しずつ送る方式（トリクル ICE）に対応している |
| `a=fingerprint:sha-256 …` | この端末の証明書のハッシュ値（指紋）。DTLS で相手を確認するのに使う |
| `a=max-message-size:262144` | データチャネルで1回に送れる最大のバイト数（256KB）。第8回で使う |

### 1-4. ICE 候補と NAT、STUN

家庭やスマホの回線では、端末は**ルーターの内側**にいて、外のインターネットからは直接見えません。ルーターが、内側の端末のアドレスと外向けのアドレスを変換しています（NAT）。

```
  端末（192.168.1.5）──── ルーター ──── インターネット
                     （外向きのアドレス 203.0.113.45）
```

そこで、通信できそうなアドレスの候補をいくつか集めて相手に伝え、実際に通るものを探します（ICE）。

| 候補の種類（`typ`） | 意味 | 例 |
|---|---|---|
| `host` | 端末自身のアドレス。同じ Wi-Fi 内なら、これで直接つながる | `xxxxxxxx-….local`（後述） |
| `srflx` | STUN サーバーに問い合わせて分かった、外から見た自分のアドレス。異なるネットワーク間では、これを使う | `203.0.113.45` |
| `relay` | TURN サーバー（中継サーバー）のアドレス。direct-share は TURN を使わないので、この候補はない | |

**STUN サーバー**の役割は、「あなたは外から見るとこのアドレスに見えますよ」と教えることだけです。データを中継はしません。

**`.local` の候補**：ブラウザは、端末のローカルIPアドレス（`192.168.1.5` など）をそのまま相手に渡すと、ネットワークの内部構成が漏れてしまうので、`xxxxxxxx-….local` という一時的な名前に置き換えます（mDNS）。同じ Wi-Fi 内の相手は、この名前を実際のアドレスに変換できます。

**つながらない場合**：両方の端末が「シンメトリック NAT」という種類のルーターの内側にいると、STUN で調べた外向きのアドレスが、相手との通信では使われません。この場合は TURN（中継）なしではつながりません（要件 R-01）。モバイル回線や社内ネットワークに多い方式です。

### 1-5. DTLS と相手の確認

経路が見つかると、DTLS で暗号化の準備をします。お互いの証明書を見せ合い、**SDP に書かれていた指紋と一致するか**を確かめます。SDP はシグナリングで暗号化して運んだので、途中で書き換えられていません。そのため、指紋が一致すれば、つながった相手は本物です。

### 1-6. 主な API

| API | 意味 |
|---|---|
| `new RTCPeerConnection(設定)` | 接続を1つ作る。設定に STUN サーバーを指定する |
| `pc.createDataChannel(名前, オプション)` | データチャネルを作る（オファーする側） |
| `pc.ondatachannel` | 相手が作ったデータチャネルを受け取る（アンサーする側） |
| `pc.createOffer()` / `pc.createAnswer()` | SDP を作る |
| `pc.setLocalDescription(SDP)` | 自分の SDP を確定する。ここから ICE 候補の収集が始まる |
| `pc.setRemoteDescription(SDP)` | 相手の SDP を設定する |
| `pc.onicecandidate` | ICE 候補が見つかるたびに呼ばれる。収集が終わると、候補として `null` が届く |
| `pc.addIceCandidate(候補)` | 相手から届いた ICE 候補を追加する。**相手の SDP を設定した後でないと失敗する** |
| `pc.connectionState` | 接続の状態：`new` → `connecting` → `connected`。失敗すると `failed` |
| `pc.close()` | 接続を閉じる |
| `dc.onopen` | データチャネルが使えるようになったときに呼ばれる |

### 1-7. クロージャ

このファイルの `startHost()` と `startGuest()` は、関数の中で変数を作り、その変数を使う関数（`startPeer`、`fail` など）を中で定義しています。

```ts
function counter() {
  let count = 0;              // counter() の中の変数
  return () => ++count;       // この関数は count を覚えている
}
const next = counter();
next();  // 1
next();  // 2
```

中で定義した関数は、**外側の関数が終わった後も、外側の変数を使い続けられます**。これをクロージャと呼びます。`startHost()` は Promise を返してすぐ終わりますが、その後に届いたメッセージを処理する関数は、`guest` や `pc` などの変数を覚えていて、使い続けます。

クラス（第5〜6回）を使っても同じことができます。このファイルでは、外に見せるのは `close()` だけなので、関数とクロージャで小さくまとめています。

---

## 2. ファイルの全体像

| 名前 | 役割 |
|---|---|
| `CONNECT_TIMEOUT_MS`、`JOIN_RESEND_MS` | 接続のタイムアウト（30秒）、参加要求の再送間隔（3秒） |
| `GuestFailReason` | ゲストが失敗した理由の種類 |
| `Controller` | 呼び出し側に返すもの。接続の試みをやめる `close()` だけを持つ |
| `CommonOptions` | ホストとゲストに共通の設定 |
| `iceConfig()` | STUN サーバーの一覧を、`RTCPeerConnection` の設定にする |
| `candidateQueue()` | 早く届きすぎた ICE 候補をためておく入れ物 |
| `startHost()` | ホストとして待つ |
| `startGuest()` | ゲストとして接続する |

`startHost()` と `startGuest()` を呼んでいるのは `main.ts`（第10回）です。

---

## 3. 1行ずつの解説

### 1〜20行目：定数と型

```ts
// シグナリングからWebRTCのデータチャネル確立まで（ホスト・ゲスト）
import { deriveRoom, randomId } from './crypto.ts';
import { Signaling, type BrokerState } from './signaling.ts';

export const CONNECT_TIMEOUT_MS = 30_000; // F-23
const JOIN_RESEND_MS = 3000;
```

| 行 | 説明 |
|---|---|
| 5 | 接続のタイムアウト。`30_000` の `_` は読みやすくするための区切りで、`30000` と同じ（要件 F-23） |
| 6 | ゲストが参加要求を送り直す間隔（3秒） |

```ts
export type GuestFailReason = 'broker' | 'nohost' | 'p2p';
```

ゲストが失敗した理由の3つの候補です。エラー画面で、理由ごとに違う対処法を表示します（第10回）。

| 値 | 意味 |
|---|---|
| `'broker'` | MQTT ブローカーに1つも接続できなかった |
| `'nohost'` | ブローカーにはつながったが、ホストからオファーが来なかった |
| `'p2p'` | オファーは来たが、端末同士の直接通信が確立できなかった |

```ts
export interface Controller {
  close(): void;
}
```

`startHost()` と `startGuest()` が返すものです。「接続の試みをやめる」ことだけができます。待機画面から参加画面に移るときや、「やめる」ボタンを押したときに使います。

```ts
interface CommonOptions {
  secret: Uint8Array<ArrayBuffer>;
  brokers: readonly string[];
  stun: readonly string[];
  selfId: string;
  onConnected: (pc: RTCPeerConnection, dc: RTCDataChannel) => void;
}
```

| プロパティ | 意味 |
|---|---|
| `secret` | 秘密値。ここからトピック名と鍵を作る |
| `brokers` | MQTT ブローカーの一覧 |
| `stun` | STUN サーバーの一覧 |
| `selfId` | 自分の端末ID |
| `onConnected` | 接続できたときに呼ぶ関数。接続とデータチャネルを渡す |

### 22〜24行目：`iceConfig()`

```ts
function iceConfig(stun: readonly string[]): RTCConfiguration {
  return { iceServers: stun.length ? [{ urls: [...stun] }] : [] };
}
```

STUN サーバーの一覧を、`RTCPeerConnection` に渡す設定の形にします。

| STUN の設定 | 結果 |
|---|---|
| 2件 | `{ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] }` |
| 0件 | `{ iceServers: [] }`。`srflx` 候補が集まらないので、同じ Wi-Fi 内でしかつながらない |

`[...stun]` でコピーしているのは、型を合わせるためです。`stun` は読み取り専用の配列（`readonly string[]`）ですが、`urls` は普通の配列（`string[]`）を求めています。読み取り専用の配列は、変更できる配列として渡せないので、コピーして普通の配列にしています。

### 26〜38行目：`candidateQueue()`（早すぎる ICE 候補をためる）

```ts
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
```

**解決したい問題**：`addIceCandidate()` は、相手の SDP を設定（`setRemoteDescription`）した後でないと失敗します。ところが、シグナリングは複数のブローカーを経由するので、**SDP より先に ICE 候補が届くことがあります**（第6回）。そこで、早すぎた候補はいったんためておき、SDP を設定した後でまとめて追加します。

| 部分 | 説明 |
|---|---|
| 28 | ためておく候補の配列 |
| 29 | `add` と `flush` という2つのメソッドを持つオブジェクトを返す。どちらも `pending` と `pc` をクロージャで覚えている |
| 30〜33 | `add`：相手の SDP がすでに設定されていればすぐ追加し、まだなら `pending` にためる |
| 34〜36 | `flush`：ためていた候補を全部追加する。`pending.splice(0)` は、配列の要素をすべて取り出して返し、配列を空にする |
| `.catch(() => {})` | 追加に失敗しても無視する。たとえば `.local` の名前が解決できない候補は追加に失敗するが、他の候補でつながればよいため |

戻り値の型は書いていませんが、TypeScript が `{ add(c): void; flush(): void }` と推測します。この型は、後で `ReturnType<typeof candidateQueue>`（「`candidateQueue` が返すものの型」）として使います。

### 40〜129行目：`startHost()`（ホストとして待つ）

#### 41〜50行目：準備

```ts
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
```

ホストには、共通の設定に加えて、次の3つを渡します。

| プロパティ | 呼ばれるとき |
|---|---|
| `onJoin` | ゲストから参加要求が届いた（画面に「相手と接続中…」を出す） |
| `onFail` | ゲストが来た後、30秒以内に接続できなかった |
| `onBrokerChange` | ブローカーの接続状況が変わった |

| 変数 | 意味 |
|---|---|
| `room` | 秘密値から作ったトピック名と鍵 |
| `guest` | 接続相手として受け入れたゲストの端末ID。最初は `null` |
| `attempt` | そのゲストの試行ID |
| `pc` | 今の `RTCPeerConnection` |
| `queue` | 早すぎた ICE 候補の入れ物 |
| `timer` | 30秒のタイムアウト |
| `done` | 終わったか（成功・失敗・中止のどれか） |

#### 52〜77行目：届いたメッセージの処理

```ts
  const sig = new Signaling({
    brokers: opts.brokers,
    room,
    selfId: opts.selfId,
    onBrokerChange: opts.onBrokerChange,
    onMessage: (msg) => {
      if (done) return;
```

シグナリングを作ります。届いたメッセージは `onMessage` で処理します。終わった後に届いたものは無視します。

```ts
      if (msg.type === 'join') {
        if (guest && msg.from !== guest) return; // 2人目以降は無視
        if (msg.attempt === attempt) return; // 同じ試行の再送
        guest = msg.from;
        attempt = msg.attempt;
        void startPeer(guest, attempt);
        return;
      }
```

参加要求（`join`）の処理です。

| 行 | 説明 |
|---|---|
| 60 | すでに別のゲストを受け入れていれば無視する。1つの部屋に入れるのは2台まで（要件 F-24、S-05） |
| 61 | 同じゲストの、同じ試行の参加要求なら無視する。ゲストは3秒ごとに参加要求を送り直すため、2回目以降はここで止まる |
| 62〜63 | ゲストと試行IDを記録する |
| 64 | WebRTC の接続を始める |

同じゲストから**違う試行ID**の参加要求が来た場合（ゲストがエラー画面で「再試行」を押した場合）は、61行目を通り抜け、接続を最初からやり直します。

```ts
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
```

| 行 | 説明 |
|---|---|
| 67 | 受け入れたゲストの、今の試行のメッセージ以外は無視する。`pc` と `queue` がまだなければ無視する（この行の後では、TypeScript は両方が `null` でないとみなす） |
| 68〜72 | アンサーが届いたら、相手の SDP として設定し、終わったらためていた ICE 候補を追加する |
| 73〜75 | ICE 候補が届いたら、入れ物に入れる（SDP 設定済みならすぐ追加される） |

69行目で `queue` を `q` にコピーしている理由：71行目の関数は、SDP の設定が終わった**後で**呼ばれます。その間に `queue` 変数が別のもの（再試行で作り直したもの）に変わるかもしれません。`q` にしておけば、このアンサーに対応する入れ物を確実に使えます。TypeScript も、`queue` のままだと「後で呼ばれる関数の中では `null` かもしれない」と判断してエラーにします。

`.then(関数)` は、Promise の結果が出たら関数を呼ぶ書き方です（`await` と同じことを、`async` 関数の外で書く方法）。

#### 79〜108行目：`startPeer()`（WebRTC の接続を始める）

```ts
  async function startPeer(to: string, myAttempt: string) {
    pc?.close();
    clearTimeout(timer);
    opts.onJoin();
    timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
```

| 行 | 説明 |
|---|---|
| 80 | 前の試行の接続が残っていれば閉じる（再試行の場合） |
| 81 | 前のタイムアウトを取り消す |
| 82 | 画面に「接続中」を出してもらう |
| 83 | 30秒以内に接続できなければ、失敗にする |

```ts
    const peer = new RTCPeerConnection(iceConfig(opts.stun));
    pc = peer;
    queue = candidateQueue(peer);
    const dc = peer.createDataChannel('direct-share', { ordered: true });
```

| 行 | 説明 |
|---|---|
| 85 | 接続を作る |
| 86 | 「今の接続」として記録する |
| 87 | ICE 候補の入れ物を作る |
| 88 | データチャネルを作る。`'direct-share'` は名前（相手にも伝わる）、`ordered: true` は送った順番どおりに届けるという指定 |

**オファーより前にデータチャネルを作る必要があります。** データチャネルを作っておかないと、オファーの SDP に `m=application` の行が入らず、データチャネルを使う接続になりません。

```ts
    peer.onicecandidate = (e) => {
      if (e.candidate) void sig.send({ type: 'ice', to, attempt: myAttempt, candidate: e.candidate.toJSON() });
    };
```

ICE 候補が見つかるたびに、シグナリングでゲストに送ります（トリクル ICE）。収集が終わったときは `e.candidate` が `null` なので、何もしません。`toJSON()` で、候補をシグナリングで送れる普通のオブジェクトに変換しています。

```ts
    peer.onconnectionstatechange = () => {
      if (peer === pc && peer.connectionState === 'failed') fail();
    };
```

接続の状態が `failed` になったら、30秒を待たずに失敗にします。`peer === pc` は、「この接続が今の接続であること」の確認です。再試行で作り直した後に、古い接続が `failed` になっても無視します。

```ts
    dc.onopen = () => {
      if (done || peer !== pc) return;
      done = true;
      clearTimeout(timer);
      sig.close();
      opts.onConnected(peer, dc);
    };
```

**データチャネルが開いたら、接続成功です。**

| 行 | 説明 |
|---|---|
| 96 | すでに終わっているか、古い接続なら無視する |
| 97〜98 | 終わった印を付け、タイムアウトを取り消す |
| 99 | シグナリングを閉じる。ブローカーから切断し、以後の参加要求は届かなくなる（要件 6.2 の手順6、S-05） |
| 100 | 接続とデータチャネルを `main.ts` に渡す |

```ts
    try {
      await peer.setLocalDescription(await peer.createOffer());
      void sig.send({ type: 'offer', to, attempt: myAttempt, sdp: peer.localDescription?.sdp });
    } catch {
      fail();
    }
  }
```

| 行 | 説明 |
|---|---|
| 103 | オファーを作り、自分の SDP として確定する。ここから ICE 候補の収集が始まり、89行目の関数が呼ばれ始める |
| 104 | オファーの SDP をゲストに送る。宛先（`to`）と試行IDを付ける |
| 105〜107 | 途中で失敗したら、接続全体を失敗にする |

**`startPeer()` の中で、`pc` などに代入するのは最初の `await` より前です。** `async` 関数は、最初の `await` までは普通の関数と同じように、すぐに実行されます。そのため、64行目で `startPeer()` を呼んだ直後には、もう `pc` と `queue` が新しいものに変わっています。

#### 110〜129行目：失敗と中止

```ts
  function fail() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    sig.close();
    pc?.close();
    opts.onFail();
  }
```

失敗の後始末をして、`onFail` で知らせます。`main.ts` は、新しい接続情報で待機画面を作り直します。

```ts
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
```

| 行 | 説明 |
|---|---|
| 119 | ブローカーへの接続を始める。ここから、ゲストの参加要求を受け付けられる |
| 120〜128 | `Controller` を返す。`close()` は `fail()` とほぼ同じ後始末をするが、`onFail` は呼ばない（呼び出し側が自分でやめたので、失敗を知らせる必要がない） |

### 131〜222行目：`startGuest()`（ゲストとして接続する）

#### 132〜139行目：準備

```ts
export async function startGuest(opts: CommonOptions & { onFail: (reason: GuestFailReason) => void }): Promise<Controller> {
  const room = await deriveRoom(opts.secret);
  const attempt = randomId(4);
  let pc: RTCPeerConnection | null = null;
  let queue: ReturnType<typeof candidateQueue> | null = null;
  const earlyCandidates: RTCIceCandidateInit[] = []; // オファーより先に届いたICE候補
  let done = false;
  let brokerState: BrokerState = { ready: 0, failed: 0, total: opts.brokers.length };
```

| 変数 | 意味 |
|---|---|
| `attempt` | この試行のID（4バイトの乱数）。`startGuest()` を呼ぶたび（＝再試行のたび）に変わる |
| `earlyCandidates` | オファーより先に届いた ICE 候補。オファーが来るまでは `RTCPeerConnection` 自体がないので、`candidateQueue` ではなく普通の配列にためる |
| `brokerState` | 最新のブローカーの接続状況。タイムアウトしたときに、失敗の理由を決めるのに使う |

#### 141〜158行目：届いたメッセージの処理

```ts
  const sig = new Signaling({
    brokers: opts.brokers,
    room,
    selfId: opts.selfId,
    onBrokerChange: (s) => {
      brokerState = s;
      if (s.ready === 0 && s.failed === s.total) fail('broker');
    },
```

ブローカーの接続状況を記録します。全部のブローカーに失敗したら、30秒を待たずにすぐ失敗にします。

```ts
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
```

| 行 | 説明 |
|---|---|
| 150 | 自分宛て（`to`）で、今の試行のメッセージ以外は無視する。前の試行への返事や、同じ部屋に別のゲストがいた場合のメッセージを除く |
| 151〜152 | オファーが届き、まだ接続を作っていなければ、受け入れる |
| 153〜156 | ICE 候補は、接続を作った後なら入れ物に、まだなら `earlyCandidates` にためる |

#### 160〜189行目：`accept()`（オファーを受け入れる）

```ts
  async function accept(sdp: string) {
    clearInterval(joinTimer);
    const peer = new RTCPeerConnection(iceConfig(opts.stun));
    pc = peer;
    queue = candidateQueue(peer);
```

| 行 | 説明 |
|---|---|
| 161 | オファーが届いたので、参加要求の再送をやめる |
| 162〜164 | 接続と ICE 候補の入れ物を作る |

```ts
    peer.onicecandidate = (e) => {
      if (e.candidate) void sig.send({ type: 'ice', attempt, candidate: e.candidate.toJSON() });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') fail('p2p');
    };
```

ホストと同じです。ゲストからの送信には `to` を付けていません。ホストは送信者ID（`from`）で、受け入れたゲストかどうかを確かめるためです。

```ts
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
```

ゲストはデータチャネルを自分で作らず、**ホストが作ったものを受け取ります**。受け取ったデータチャネルが開いたら成功です。

```ts
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp });
      for (const c of earlyCandidates) queue.add(c);
      await peer.setLocalDescription(await peer.createAnswer());
      void sig.send({ type: 'answer', attempt, sdp: peer.localDescription?.sdp });
    } catch {
      fail('p2p');
    }
  }
```

| 行 | 説明 |
|---|---|
| 182 | ホストのオファーを、相手の SDP として設定する |
| 183 | 早く届いていた ICE 候補を追加する（SDP 設定済みなので、すぐに追加される） |
| 184 | アンサーを作り、自分の SDP として確定する。ここから ICE 候補の収集が始まる |
| 185 | アンサーをホストに送る |

183行目の `queue.add(c)` で、`queue` が `null` かもしれないという型エラーにならないのはなぜでしょうか。164行目で `queue` に値を入れた後、TypeScript はこの関数の中では `queue` が `null` でないと覚えているからです。

#### 191〜222行目：失敗、タイムアウト、開始

```ts
  function fail(reason: GuestFailReason) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(joinTimer);
    sig.close();
    pc?.close();
    opts.onFail(reason);
  }
```

後始末をして、失敗の理由を知らせます。

```ts
  const timer = setTimeout(() => {
    if (brokerState.ready === 0) fail('broker');
    else fail(pc ? 'p2p' : 'nohost');
  }, CONNECT_TIMEOUT_MS);
```

30秒たっても接続できなければ、状況から理由を推測して失敗にします。

| 30秒後の状況 | 理由 |
|---|---|
| 使えるブローカーが0 | `'broker'` |
| ブローカーは使えるが、オファーが来ていない（`pc` がない） | `'nohost'`（ホストがいない、接続コードが期限切れ・使用済み、ブローカーの設定が違う） |
| オファーは来たが、つながらない | `'p2p'`（NAT を越えられない） |

```ts
  // 参加要求はオファーが届くまで定期的に再送する
  const sendJoin = () => void sig.send({ type: 'join', attempt });
  const joinTimer = setInterval(sendJoin, JOIN_RESEND_MS);
  sig.start();
  sendJoin();
```

| 行 | 説明 |
|---|---|
| 207 | 参加要求を送る関数 |
| 208 | 3秒ごとに送り直す |
| 209 | ブローカーへの接続を始める |
| 210 | 最初の参加要求を、すぐに送る。まだブローカーにつながっていなくても、`Signaling` の `sent` に記録され、つながった時点で送られる（第6回） |

**送り直す理由**（第6回 4-2）：QoS 0 のメッセージは、相手がまだ購読していないブローカーでは失われます。ホストが購読を終える前に届いた参加要求は消えてしまうので、オファーが来るまで送り続けます。ホストは、同じ試行の2回目以降の参加要求を無視するので（61行目）、何度送っても問題ありません。

**変数の宣言の順番について**：`fail()`（191行目）の中で `timer` と `joinTimer` を使っていますが、これらが宣言されるのは、その後の201行目と208行目です。`const` の変数は、宣言の行を実行する前に使うとエラーになります。それでも問題が起きないのは、`fail()` が実際に呼ばれるのが `sig.start()`（209行目）より後だからです。ブローカーの接続状況の変化やメッセージは、`sig.start()` してから届きます。

```ts
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
```

ホストと同じく、中止のための `close()` だけを持つ `Controller` を返します。

---

## 4. 動かして確認

### 4-1. SDP と ICE 候補を見る

開発サーバーでページを開き、Console で次を実行します。このファイルの `startPeer()` と同じ手順で、オファーを作ります。

```js
const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
pc.createDataChannel('direct-share', { ordered: true });
const cands = [];
pc.onicecandidate = (e) => cands.push(e.candidate ? e.candidate.candidate : '(収集完了 null)');
await pc.setLocalDescription(await pc.createOffer());
await new Promise((r) => setTimeout(r, 3000));
console.log(pc.localDescription.sdp);
console.log(cands);
pc.close();
```

- SDP の中に、`m=application … webrtc-datachannel`、`a=fingerprint`、`a=ice-ufrag` などの行があることを確かめてください。
- ICE 候補として、`typ host`（`.local` の名前）と `typ srflx`（外から見たアドレス）が見つかるはずです。最後に `null` が届きます。
- 1行目の `createDataChannel` を消して実行すると、SDP に `m=application` の行がなくなることも確かめてください。

### 4-2. 実際の接続を観察する

Chrome なら `chrome://webrtc-internals`、Edge なら `edge://webrtc-internals` を別のタブで開いておきます。その状態で、2つのタブで direct-share を接続してみてください。

- 接続の一覧に、`RTCPeerConnection` が現れます。
- 「ICE candidate grid」などで、集めた候補と、実際に選ばれた経路（どの候補の組み合わせでつながったか）が見られます。同じ PC のタブ同士なら、`host` 候補どうしでつながっているはずです。
- `connectionState` が `new` → `connecting` → `connected` と変わる様子が見られます。

### 4-3. 失敗の理由を確かめる

- **`'nohost'`**：適当な接続コード（`0000-0000-0000-0000` など）を参加画面に入力すると、30秒後に「相手からの応答がありません。」になります。ブローカーにはつながるがホストがいない状況です。
- **`'broker'`**：設定画面で MQTT ブローカーを `wss://example.invalid` だけにして参加すると、すぐに「MQTTブローカーに接続できませんでした。」になります。確認したら「デフォルトに戻す」を押してください。

---

## 5. 理解チェック

1. ホストが、オファーを作る前にデータチャネルを作っているのはなぜですか。
2. `candidateQueue()` は、どんな問題を解決していますか。
3. ゲストが参加要求を3秒ごとに送り直すのはなぜですか。ホストはそれをどう扱っていますか。
4. ホストが参加要求を受け入れた後、別のゲストから参加要求が届いたらどうなりますか。
5. データチャネルが開いた直後に `sig.close()` しているのは、何のためですか。
6. ゲストが30秒でタイムアウトしたとき、失敗の理由はどのように決まりますか。
7. STUN サーバーの設定を0件にすると、どんな場合につながらなくなりますか。
8. `startHost()` の `close()` と `fail()` の違いは何ですか。

<details>
<summary>答え</summary>

1. データチャネルを作っておかないと、オファーの SDP にデータチャネル用の `m=application` の行が入らず、データチャネルを使う接続として交渉されないため。
2. `addIceCandidate()` は相手の SDP を設定した後でないと失敗するが、シグナリングは複数のブローカーを経由するので、SDP より先に ICE 候補が届くことがある。早すぎた候補をためておき、SDP を設定した後でまとめて追加する。
3. QoS 0 のメッセージは、ホストがまだ購読していないブローカーでは失われるため。オファーが届くまで送り続ければ、いずれホストに届く。ホストは、同じゲストの同じ試行IDの参加要求は2回目以降を無視する。
4. 60行目で無視される。1つの部屋に入れるのは2台までで、最初に受け入れたゲストとだけ接続する（要件 F-24、S-05）。
5. ブローカーとの接続を切って、以後の参加要求を受け付けないようにするため（要件 6.2 の手順6、S-05）。接続後はシグナリングが不要になるので、無駄な通信もなくなる。
6. 使えるブローカーが0なら `'broker'`、ブローカーは使えるがオファーが来ていない（`pc` がない）なら `'nohost'`、オファーは来たがつながらないなら `'p2p'`。
7. 異なるネットワーク間（たとえば自宅の Wi-Fi とスマホのモバイル回線）の場合。外から見たアドレス（`srflx` 候補）が集まらないので、相手からたどり着ける候補がなくなる。同じ Wi-Fi 内なら `host` 候補でつながる。
8. どちらも後始末（タイムアウトの取り消し、シグナリングと接続を閉じる）をするが、`fail()` は `onFail` を呼んで失敗を知らせ、`close()` は知らせない。`close()` は呼び出し側が自分でやめるときに使うので、知らせる必要がない。

</details>

---

次回（第8回）は `src/session.ts` の前半を読みます。開いたデータチャネルで、テキストとファイルを送る部分です。
