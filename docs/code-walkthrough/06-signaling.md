# 第6回 `src/signaling.ts`：複数ブローカーでの暗号化シグナリング

このファイルは、第5回の `MqttClient` と第4回の暗号を組み合わせて、**シグナリングのメッセージを安全に、確実にやり取りする**部品です（要件 6.2、A-04）。

- 設定されたすべてのブローカーに**同時に**接続する（どれか1つでも動いていれば通信できる）
- 送るメッセージを暗号化し、**すべてのブローカーに**送る
- 届いたメッセージを復号し、**自分が送ったものや重複を捨てて**から、上の層に渡す

---

## 1. 前提知識

### 1-1. シグナリングとは

WebRTC（第7回）で端末同士を直接つなぐには、その前に「自分はどんな条件で、どこで待っているか」という情報を交換しておく必要があります。この事前の情報交換を**シグナリング**と呼びます。

WebRTC 自身はシグナリングの方法を決めていないので、アプリが自由に選べます。direct-share は、公開 MQTT ブローカーを伝言板として使っています。

交換するメッセージは4種類です。

| 種類 | 向き | 中身 |
|---|---|---|
| `join` | ゲスト → ホスト | 参加したい |
| `offer` | ホスト → ゲスト | ホストの通信条件（SDP） |
| `answer` | ゲスト → ホスト | ゲストの通信条件（SDP） |
| `ice` | 両方向 | 通信できそうなアドレスの候補（ICE 候補） |

SDP や ICE 候補の中身は第7回で説明します。このファイルにとっては「暗号化して運ぶ荷物」です。

### 1-2. なぜ複数のブローカーを使うのか

公開ブローカーはテスト用に無料で提供されているもので、保証がありません。実際、この解説を書いている時点（2026年10月27日）でも、3つのうち `test.mosquitto.org` に接続できない状態でした。

```
送信側 ──→ ブローカー1（emqx）      ──→ 受信側   ✓ 届く
      ──→ ブローカー2（mosquitto） ✗ 停止中
      ──→ ブローカー3（hivemq）    ──→ 受信側   ✓ 届く（重複）
```

同じメッセージを全部のブローカーに送れば、1つでも動いていれば届きます（要件 A-04）。そのかわり、動いているブローカーの数だけ**同じメッセージが重複して届く**ので、受信側で捨てる必要があります。

### 1-3. 重複を見分ける：送信者IDと連番

各メッセージに、次の2つを付けて送ります。

| 項目 | 内容 |
|---|---|
| `from` | 送信者の端末ID（起動時に乱数で作る） |
| `seq` | 送信者ごとの連番（1, 2, 3…） |

`from` と `seq` の組が同じなら、同じメッセージです。受信側は、一度受け取った組を覚えておき、2回目以降は捨てます。

これらは暗号化された中身に入れているので、ブローカーや第三者には見えず、書き換えることもできません。

### 1-4. `Set`

重複のない値の集まりです。第1回でも少し出てきました。

```ts
const s = new Set<string>();
s.add('A:1');
s.has('A:1');     // → true
s.add('A:1');     // 2回入れても1つのまま
s.delete('A:1');  // 削除。あったら true、なければ false を返す
s.size;           // 要素の数
```

このファイルでは、「受信済みのメッセージ」と「接続できたブローカー」の管理に使っています。

### 1-5. このファイルで新しく出てくる TypeScript の書き方

| 書き方 | 意味 |
|---|---|
| `RTCIceCandidateInit` | ブラウザが用意している、ICE 候補の情報の型 |
| `A & { from: string }` | 交差型。A のすべてのプロパティに加えて、`from` も持つ型 |
| `void 式` | 式の結果（Promise）を、意図的に使わないことを示す |
| `値 as unknown as 型` | 二重の型アサーション。直接はアサーションできない型どうしで、いったん `unknown` を経由する |

---

## 2. ファイルの全体像

| 名前 | 役割 |
|---|---|
| `SignalMessage` | 送るメッセージの型 |
| `ReceivedMessage` | 受け取るメッセージの型（送信者IDと連番が付いている） |
| `BrokerState` | ブローカーの接続状況（何個つながり、何個失敗したか） |
| `SignalingOptions` | 作るときの設定 |
| `Signaling` | 本体のクラス |
| ├ `start()` | 全ブローカーへの接続を始める |
| ├ `connectBroker()` | 1つのブローカーに接続して購読する（内部用） |
| ├ `notify()` | 接続状況の変化を知らせる（内部用） |
| ├ `send()` | メッセージを暗号化して、全ブローカーに送る |
| ├ `receive()` | 届いたメッセージを復号し、ふるい分けて渡す（内部用） |
| └ `close()` | 全ブローカーから切断する |

`Signaling` を使っているのは `connection.ts`（第7回）です。ホストもゲストも、1回の接続の試みにつき1つ作ります。

---

## 3. 1行ずつの解説

### 1〜27行目：読み込みと型

```ts
// 複数のMQTTブローカーを使った暗号化シグナリング（6.2, A-04）
import { decryptMessage, encryptMessage, randomId, type Room } from './crypto.ts';
import { MqttClient } from './mqtt.ts';
```

第4回の暗号の関数と `Room` 型、第5回の `MqttClient` を取り込みます。`Room` は型なので `type` を付けています（第0回の `verbatimModuleSyntax`）。

```ts
export interface SignalMessage {
  type: 'join' | 'offer' | 'answer' | 'ice';
  attempt: string;
  to?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}
```

送るメッセージの型です。

| プロパティ | 必須 | 意味 |
|---|---|---|
| `type` | ○ | メッセージの種類。4つの文字列のどれか |
| `attempt` | ○ | 接続の試行ID。ゲストが「再試行」するたびに変わる（第7回） |
| `to` | | 宛先の端末ID。ホストがゲストに送るときに付ける |
| `sdp` | | 通信条件。`offer` と `answer` のときに付ける |
| `candidate` | | ICE 候補。`ice` のときに付ける |

```ts
export type ReceivedMessage = SignalMessage & { from: string; seq: number };
```

受け取ったメッセージの型です。送るときの中身に、`send()` が自動で付ける `from`（送信者ID）と `seq`（連番）が加わっています。

```ts
export interface BrokerState {
  ready: number;
  failed: number;
  total: number;
}
```

ブローカーの接続状況です。`ready` は使えるブローカーの数、`failed` は失敗した（または途中で切れた）数、`total` は設定されている数です。`ready` が 0 で `failed` が `total` と同じなら、全滅です。

```ts
export interface SignalingOptions {
  brokers: readonly string[];
  room: Room;
  selfId: string;
  onMessage: (msg: ReceivedMessage) => void;
  onBrokerChange?: (s: BrokerState) => void;
}
```

| プロパティ | 意味 |
|---|---|
| `brokers` | 接続するブローカーの URL の一覧 |
| `room` | トピック名と暗号鍵（第4回の `deriveRoom()` で作ったもの） |
| `selfId` | 自分の端末ID |
| `onMessage` | ふるい分けを通ったメッセージを受け取る関数 |
| `onBrokerChange` | 接続状況が変わるたびに呼ばれる関数（省略可） |

### 29〜41行目：プロパティとコンストラクター

```ts
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
```

| プロパティ | 意味 |
|---|---|
| `clients` | 作ったすべての `MqttClient`（失敗したものも含む）。最後にまとめて閉じるため |
| `ready` | 購読まで完了し、送受信に使えるクライアントの集まり |
| `failed` | 失敗したブローカーの数 |
| `sent` | これまでに送った暗号文。後から使えるようになったブローカーにも送り直すため |
| `seen` | 受信済みのメッセージの印（`送信者ID:連番`） |
| `seq` | 自分の送信の連番 |
| `closed` | 閉じたか |

### 43〜45行目：`start()`

```ts
  start(): void {
    for (const url of this.opts.brokers) void this.connectBroker(url);
  }
```

すべてのブローカーへの接続を、**同時に**始めます。

`connectBroker()` は `async` 関数なので Promise を返しますが、ここでは `await` しません。`await` すると1つ目の接続が終わるまで2つ目が始まらず、遅いブローカーや止まっているブローカー（タイムアウトまで8秒）に足を引っ張られるためです。

先頭の `void` は、「返ってきた Promise を待たないのは、わざとです」という印です。Promise を放置するコードは書き忘れのことも多いので、意図を明示しています。

### 47〜69行目：`connectBroker()`（1つのブローカーに接続）

```ts
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
```

| 行 | 説明 |
|---|---|
| 48 | `MqttClient` を作る。まだ接続はしない |
| 49 | クライアントIDは `ds-` + 6バイトの乱数（12文字）。ブローカーごと、接続ごとに違う名前になる |
| 50 | メッセージが届いたら `receive()` に渡す |
| 51〜54 | 接続後に予期せず切れたら：使えるブローカーの集まりから外し、外せた（＝入っていた）なら失敗の数を1増やして、状況を知らせる |
| 56 | 作ったクライアントを記録する |

**48行目で `client` の型を `: MqttClient` と明示している理由**：52行目の `onClose` の中で、`client` 自身を使っています。型を書かないと、TypeScript は「`client` の型を決めるために、`client` を使っている関数の型を調べる必要がある」という循環に陥り、型を推測できずにエラーになります。型を書けば、この循環を断ち切れます。

`onClose` の中から `client` を使えるのは、この関数が呼ばれるのが、ずっと後（接続が切れたとき）だからです。そのときには `client` に値が入っています。

```ts
    try {
      await client.connect();
      await client.subscribe(this.opts.room.topic);
      if (this.closed) return client.close();
      this.ready.add(client);
      for (const payload of this.sent) client.publish(this.opts.room.topic, payload);
```

| 行 | 説明 |
|---|---|
| 58 | 接続する（CONNECT → CONNACK）。失敗すると例外になり、63行目に飛ぶ |
| 59 | トピックを購読する（SUBSCRIBE → SUBACK）。失敗すると例外になり、63行目に飛ぶ |
| 60 | 接続や購読を待っている間に、`close()` が呼ばれていたら、このクライアントもすぐ閉じる |
| 61 | 使えるブローカーの集まりに加える |
| 62 | **これまでに送ったメッセージを、このブローカーにも全部送る** |

**62行目が重要です。** ブローカーへの接続にかかる時間はまちまちで、1つ目のブローカーがつながった時点で、もう `send()` が呼ばれているかもしれません。後からつながったブローカーにも過去のメッセージを送っておけば、相手がそのブローカーしか使えない状況でも、メッセージが届きます。

```ts
    } catch {
      if (this.closed) return;
      this.failed++;
      client.close();
    }
    this.notify();
  }
```

| 行 | 説明 |
|---|---|
| 64 | すでに閉じていれば、何もせずに終わる（失敗として数えない） |
| 65 | 失敗の数を1増やす |
| 66 | このクライアントを閉じる |
| 68 | 成功でも失敗でも、接続状況が変わったので知らせる |

### 71〜74行目：`notify()`

```ts
  private notify(): void {
    if (this.closed) return;
    this.opts.onBrokerChange?.({ ready: this.ready.size, failed: this.failed, total: this.opts.brokers.length });
  }
```

現在の接続状況を、`onBrokerChange` に知らせます。閉じた後は知らせません。

呼び出し側の使い方（第7回、第10回）：

- ホスト：全滅したら、待機画面に「MQTTブローカーに接続できません」と表示する
- ゲスト：全滅したら、すぐにエラー画面にする（30秒待たない）

### 76〜81行目：`send()`（送信）

```ts
  async send(msg: SignalMessage): Promise<void> {
    const payload = await encryptMessage(this.opts.room, { ...msg, from: this.opts.selfId, seq: ++this.seq });
    if (this.closed) return;
    this.sent.push(payload);
    for (const client of this.ready) client.publish(this.opts.room.topic, payload);
  }
```

| 行 | 説明 |
|---|---|
| 77 | メッセージに送信者IDと連番を付けて、暗号化する。`{ ...msg, from: …, seq: … }` は、`msg` の中身をすべて並べ、`from` と `seq` を足したオブジェクト。`++this.seq` は「1増やしてから、その値を使う」（`this.seq++` とは順番が逆） |
| 78 | 暗号化を待っている間に閉じていたら、送らない |
| 79 | 暗号文を記録する（後からつながったブローカー用） |
| 80 | 今使えるブローカー全部に送る |

**暗号化は1回だけ**行い、同じ暗号文を全ブローカーに送っています。暗号文が同じなら、中の `from` と `seq` も同じなので、受信側で重複として見分けられます。

**送信の順番について**：連番は `send()` を呼んだ順に付きますが、暗号化は非同期なので、完了する順番が前後する可能性があります。また、ブローカーが違えば届く順番も変わります。そのため、受信側は「メッセージが送った順に届く」ことを前提にしていません（第7回の「オファーより先に ICE 候補が届く」場合の処理）。

### 83〜91行目：`receive()`（受信とふるい分け）

```ts
  private async receive(topic: string, payload: Uint8Array<ArrayBuffer>): Promise<void> {
    if (topic !== this.opts.room.topic || this.closed) return;
    const msg = await decryptMessage(this.opts.room, payload);
```

| 行 | 説明 |
|---|---|
| 84 | 違うトピックのメッセージや、閉じた後に届いたものは捨てる。購読しているトピックは1つだけなので、違うトピックが届くことは普通ないが、念のため |
| 85 | 復号する。失敗すれば `null` |

```ts
    if (!msg || this.closed || typeof msg.from !== 'string' || msg.from === this.opts.selfId) return;
```

次のどれかに当てはまれば捨てます。

| 条件 | 意味 |
|---|---|
| `!msg` | 復号に失敗した（鍵が違う、改ざんされている、など） |
| `this.closed` | 復号を待っている間に閉じた |
| `typeof msg.from !== 'string'` | 送信者IDがない（正しい形式でない） |
| `msg.from === this.opts.selfId` | 自分が送ったメッセージ。ブローカーは送った本人にも配るため（第5回） |

```ts
    const id = `${msg.from}:${String(msg.seq)}`;
    if (this.seen.has(id)) return; // 複数ブローカーからの重複
    this.seen.add(id);
    this.opts.onMessage(msg as unknown as ReceivedMessage);
  }
```

| 行 | 説明 |
|---|---|
| 87 | `送信者ID:連番` という印を作る（例：`9f8e7d6c5b4a3921:3`）。`msg.seq` の型は `unknown` なので、`String()` で文字列にしている |
| 88 | 受信済みなら捨てる |
| 89 | 受信済みとして記録する |
| 90 | 上の層に渡す |

90行目の `as unknown as ReceivedMessage`：`decryptMessage()` が返す型は `Record<string, unknown>`（中身の形が分からないオブジェクト）です。これと `ReceivedMessage` は形がかけ離れているので、TypeScript は直接の型アサーションを許しません。いったん `unknown` にしてからアサーションしています。

**中身の形は、ここでは確かめていません。** `type` が4種類のどれかか、`sdp` が文字列か、といった確認は、受け取った側（第7回）が必要な分だけ行っています。正しい鍵を持っているのは接続の相手だけなので、形の崩れたメッセージが届くことは、普通はありません。

### 93〜97行目：`close()`

```ts
  close(): void {
    this.closed = true;
    for (const client of this.clients) client.close();
  }
}
```

閉じた印を付け、作ったすべてのクライアントを閉じます。`MqttClient` の `close()` は何度呼んでも安全なので、すでに閉じたクライアントが混ざっていても問題ありません。

接続中や購読中のクライアントは、60行目（`if (this.closed) return client.close();`）で、完了した時点で閉じられます。

#### 気づいた点：途中で切れたブローカーには、つなぎ直さない

接続できた後でブローカーとの接続が切れた場合、そのブローカーは失敗として数えられ、つなぎ直しはしません。シグナリングは数秒〜30秒で終わるので、その間は残りのブローカーで足りる、という考え方です。

---

## 4. 動かして確認

開発サーバーでページを開き、Console で試します。同じ部屋（トピックと鍵）に、A と B の2人を入れて、A から B にメッセージを送ります。

### 4-1. 重複が捨てられる様子

```js
const { Signaling } = await import('/direct-share/src/signaling.ts');
const c = await import('/direct-share/src/crypto.ts');
const { DEFAULTS } = await import('/direct-share/src/settings.ts');
const room = await c.deriveRoom(c.randomSecret());
const log = [];
let raw = 0;
const make = (name) => new Signaling({
  brokers: DEFAULTS.mqtt, room, selfId: name,
  onMessage: (m) => log.push(`${name} が受信: ${m.type} from=${m.from} seq=${m.seq}`),
  onBrokerChange: (s) => log.push(`${name} ブローカー ready=${s.ready} failed=${s.failed}/${s.total}`),
});
const A = make('A');
const B = make('B');

// B の receive() を包んで、ふるい分け前に届いた数を数える（確認用）
const origRecv = B.receive.bind(B);
B.receive = (t, p) => { raw++; return origRecv(t, p); };

B.start();                                         // B が先に購読して待つ
await new Promise((r) => setTimeout(r, 4000));
A.start();
await A.send({ type: 'join', attempt: 'x1' });
await new Promise((r) => setTimeout(r, 5000));
A.close(); B.close();
({ raw, log })
```

実際に動かした結果（mosquitto が止まっていたとき）：

```
raw: 2
B ブローカー ready=0 failed=1/3      ← mosquitto に失敗
B ブローカー ready=1 failed=1/3
B ブローカー ready=2 failed=1/3      ← emqx と hivemq が使える
A ブローカー ready=0 failed=1/3
A ブローカー ready=1 failed=1/3
A ブローカー ready=2 failed=1/3
B が受信: join from=A seq=1          ← 1回だけ
```

B には同じメッセージが2つのブローカーから2回届いています（`raw: 2`）が、`onMessage` に渡されたのは1回だけです。A にも自分のメッセージが届いていますが、自分の送信なので捨てられ、ログには出ていません。

### 4-2. 先に送ると届かないことがある

上のコードで、`B.start()` の後の4秒待ちを消して、A と B を同時に始めてみてください。B が何も受け取れないことがあります。

実際に試したときは、A のブローカーが先に使えるようになり、`sent` に記録していた `join` を送りました。しかし、その時点で B はまだそのブローカーで購読を終えていなかったので、受け取れませんでした。QoS 0 のメッセージは、購読していない相手には届かず、後から購読しても受け取れません。

実際のアプリでは、これを次のように防いでいます（第7回）。

- ホストは、画面を開いた時点で購読して待っている（ゲストより十分前）
- ゲストは、オファーが届くまで `join` を**3秒ごとに送り直す**

---

## 5. 理解チェック

1. 全ブローカーに同じメッセージを送ると、受信側では何が起こりますか。それをどう処理していますか。
2. `start()` で、`connectBroker()` を `await` せずに呼んでいるのはなぜですか。
3. `sent` に暗号文を記録しておくのは、何のためですか。
4. `receive()` で、自分が送ったメッセージが届くのはなぜですか。
5. `send()` で、暗号化を全ブローカー分ではなく1回だけ行っているのは、重複の見分けの点でどんな意味がありますか。
6. `connectBroker()` で `const client: MqttClient = …` と型を明示しないと、どうなりますか。
7. 3つのブローカーのうち1つが止まっていても、通信できるのはなぜですか。

<details>
<summary>答え</summary>

1. 動いているブローカーの数だけ、同じメッセージが重複して届く。`送信者ID:連番` の組を `seen` に記録し、2回目以降は捨てている。
2. `await` すると1つずつ順番に接続することになり、遅いブローカーや止まっているブローカー（タイムアウトまで8秒）を待つ間、他のブローカーへの接続が始まらないため。同時に始めれば、早くつながったものから使える。
3. 後から使えるようになったブローカーにも、過去に送ったメッセージを送り直すため。相手がそのブローカーしか使えない場合でも、メッセージが届くようになる。
4. MQTT のブローカーは、トピックを購読している全員に配信し、その中には送った本人も含まれるため。`from` が自分の端末IDのものは捨てている。
5. 同じ暗号文を送るので、どのブローカーから届いても、中の `from` と `seq` は同じになる。そのため、`送信者ID:連番` で重複を確実に見分けられる。
6. `onClose` の中で `client` 自身を使っているため、`client` の型を推測するのに `client` の型が必要になるという循環が起き、TypeScript が型を決められずにエラーになる。
7. 同じメッセージを全ブローカーに送っているので、動いているブローカーが1つでもあれば、そこから届くため。止まっているブローカーへの接続は、失敗として数えられるだけ。

</details>

---

次回（第7回）は `src/connection.ts` を読みます。WebRTC の入門から始め、このシグナリングを使ってホストとゲストが直接つながるまでの流れを見ていきます。
