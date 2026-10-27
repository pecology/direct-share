# 第5回 `src/mqtt.ts`：MQTT クライアント

このファイルは、**MQTT ブローカーと通信するための最小限のクライアント**です。外部のライブラリを使わず、MQTT のパケット（通信の単位）をバイト単位で組み立て、WebSocket で送受信しています。

できることは5つだけです：接続、購読、送信、切断、死活確認（接続が生きていることをブローカーに伝える）。

---

## 1. 前提知識

### 1-1. MQTT 入門

MQTT は、メッセージをやり取りするための軽量な通信手順（プロトコル）です。もともとは、センサーなど性能の低い機器が、不安定な回線でデータを送るために作られました。今は IoT 機器などで広く使われています。

#### 登場人物

```
               ブローカー（中継サーバー）
              ┌────────────────────┐
  送る側 ────→│ トピック "room/123" │────→ 受け取る側 A
 （Publish）  │                    │────→ 受け取る側 B
              └────────────────────┘    （Subscribe 済み）
```

| 用語 | 意味 |
|---|---|
| **ブローカー** | メッセージを受け取り、配る役のサーバー。direct-share では公開されているものを使う |
| **クライアント** | ブローカーに接続する側。ホストもゲストも、どちらもクライアント |
| **トピック** | メッセージの宛先につける名前。`direct-share/9bab16e3…` のような文字列 |
| **購読**（Subscribe） | 「このトピックに来たメッセージを自分にも届けて」とブローカーに頼むこと |
| **送信**（Publish） | トピックを指定してメッセージを送ること。ブローカーは、そのトピックを購読しているクライアント全員に配る |

送る側と受け取る側は、お互いのアドレスを知りません。**同じトピック名を知っているだけで、ブローカー経由でつながります。** これが、direct-share がブローカーを使う理由です。

送ったメッセージは、**送った本人にも届きます**（本人も同じトピックを購読していれば）。direct-share では、自分のメッセージは受信側で捨てています（第6回）。

#### QoS（配送の品質）

| QoS | 意味 | 確認のやり取り |
|---|---|---|
| 0 | 最大1回。届かないこともある | なし |
| 1 | 最低1回。重複することもある | 受信確認（PUBACK） |
| 2 | ちょうど1回 | 4段階のやり取り |

このクライアントは **QoS 0 だけ**に対応しています。実装が小さく済むためです。届かないかもしれない点は、上の層（第6〜7回）で「再送」と「複数ブローカーへの同時送信」で補っています。

#### パケットの共通形式

MQTT の通信はすべて「パケット」という単位で行います。どのパケットも次の形です。

```
┌───────────┬────────────────┬────────────────────┐
│ 1バイト目  │ 残りの長さ       │ 本体                │
│ 種別＋フラグ │ 1〜4バイト        │ 「残りの長さ」バイト │
└───────────┴────────────────┴────────────────────┘
```

- **1バイト目**：上位4ビットがパケットの種別、下位4ビットがフラグ
- **残りの長さ**：本体のバイト数。可変長（後述）
- **本体**：種別ごとに中身が違う

このクライアントで使う種別：

| 1バイト目 | 種別 | 向き | 意味 |
|---|---|---|---|
| `0x10` | CONNECT | → ブローカー | 接続したい |
| `0x20` | CONNACK | ← ブローカー | 接続の結果 |
| `0x82` | SUBSCRIBE | → ブローカー | このトピックを購読したい |
| `0x90` | SUBACK | ← ブローカー | 購読の結果 |
| `0x30` | PUBLISH | 両方向 | メッセージ |
| `0xC0` | PINGREQ | → ブローカー | まだつながっています |
| `0xD0` | PINGRESP | ← ブローカー | 了解 |
| `0xE0` | DISCONNECT | → ブローカー | 切断します |

上位4ビットだけを見ると、CONNECT は 1、CONNACK は 2、PUBLISH は 3、SUBSCRIBE は 8、SUBACK は 9、PINGREQ は 12、PINGRESP は 13、DISCONNECT は 14 です。

#### 「残りの長さ」の書き方（可変長整数）

1バイトのうち**下位7ビットを数値に使い、最上位ビットを「次のバイトに続く」という印**にします。小さい数は1バイト、大きい数は最大4バイトで表せます。

| 数 | バイト | 説明 |
|---|---|---|
| 27 | `1b` | 127 以下なので1バイト |
| 127 | `7f` | 1バイトで表せる最大 |
| 128 | `80 01` | 128 = 0 + 1 × 128。1バイト目は 0 に「続く」印（`0x80`）を付けて `0x80`、2バイト目は 1 |
| 347 | `db 02` | 347 = 91 + 2 × 128。1バイト目は 91（`0x5b`）に印を付けて `0xdb`、2バイト目は 2 |

#### 文字列の書き方

MQTT の中の文字列は、**先頭2バイトに長さ**を書き、その後に UTF-8 のバイト列を続けます。

```
"MQTT" → 00 04 4d 51 54 54
          ───── ───────────
          長さ4    M  Q  T  T
```

### 1-2. WebSocket

ブラウザとサーバーの間で、**つなぎっぱなしの双方向の通信路**を作る仕組みです。普通の HTTP は「ブラウザが要求し、サーバーが応える」の1往復で終わりますが、WebSocket は一度つなげば、どちらからでも好きなときにデータを送れます。

```ts
const ws = new WebSocket('wss://broker.emqx.io:8084/mqtt', 'mqtt');
ws.onopen = () => { /* つながった */ };
ws.onmessage = (e) => { /* データが届いた（e.data） */ };
ws.onclose = () => { /* 切れた */ };
ws.send(bytes);       // データを送る
ws.close();           // 切断する
```

| ポイント | 説明 |
|---|---|
| `wss://` | 暗号化（TLS）された WebSocket。`ws://` は暗号化なし |
| 第2引数 `'mqtt'` | サブプロトコル。「この通信路の中身は MQTT です」とサーバーに伝える。MQTT ブローカーの WebSocket 受付は、これがないと接続を断ることがある |
| `onopen` などの書き方 | 「イベントが起きたら、この関数を呼んで」と登録しておく。起きる順番やタイミングはブラウザが決める |

ブラウザは生の TCP 通信ができないので、MQTT を WebSocket に載せて使います（MQTT over WebSocket）。

**注意**：WebSocket の1回の受信（1つのメッセージ）が、MQTT の1パケットとは限りません。2つのパケットがまとめて届くことも、1つのパケットが分かれて届くこともありえます。そのため、受け取ったバイトをためておき、パケットの区切りを自分で見つける処理が必要です（`receive()`）。

### 1-3. クラス

**クラス**は、データ（プロパティ）と、それを操作する関数（メソッド）をひとまとめにした設計図です。`new` で実体（インスタンス）を作ります。

```ts
class Counter {
  private count = 0;          // プロパティ（初期値 0）

  increment(): void {         // メソッド
    this.count++;             // this は「この実体自身」
  }
}

const c = new Counter();      // 実体を作る
c.increment();
```

| 書き方 | 意味 |
|---|---|
| `private` | クラスの外から使えない（型チェックでエラーになる）。TypeScript だけの印で、実行時には普通に見える |
| `readonly` | 最初に値を入れた後は、変更できない |
| `constructor(…)` | `new` したときに最初に呼ばれる、準備のための関数 |
| `this.○○` | この実体のプロパティやメソッド |

ブローカー1つにつき、`MqttClient` の実体を1つ作ります。3つのブローカーにつなぐなら、実体も3つです。

### 1-4. `new Promise` で Promise を自分で作る

第4回では、Web Crypto API が返す Promise を `await` で待ちました。このファイルでは、**自分で Promise を作ります**。「CONNACK が届いたら成功」のように、イベントの結果を Promise の形にするためです。

```ts
function wait(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // ここで処理を始める
    // 成功したら resolve(結果) を、失敗したら reject(エラー) を呼ぶ
    setTimeout(() => resolve(), ms);
  });
}

await wait(1000);  // 1秒待つ
```

- `resolve` を呼ぶと、`await` している側に結果が返ります。
- `reject` を呼ぶと、`await` している側で例外が起きます。
- **最初に呼んだ方だけが有効**で、2回目以降の `resolve` や `reject` は無視されます。

### 1-5. タイマー

| 関数 | 意味 |
|---|---|
| `setTimeout(関数, ミリ秒)` | 指定時間後に1回だけ関数を呼ぶ。戻り値はタイマーの番号 |
| `clearTimeout(番号)` | まだ呼ばれていないタイマーを取り消す |
| `setInterval(関数, ミリ秒)` | 指定時間ごとに関数を呼び続ける |
| `clearInterval(番号)` | くり返しを止める |

タイマーの番号の型は、ブラウザでは `number`、Node.js では専用のオブジェクトです。どちらでも動くよう、型は `ReturnType<typeof setTimeout>`（「`setTimeout` が返すものの型」）と書いています。

---

## 2. ファイルの全体像

| 名前 | 役割 |
|---|---|
| `str()` | 文字列を MQTT の形式（長さ2バイト＋UTF-8）にする |
| `packet()` | 1バイト目と本体から、パケットを組み立てる（「残りの長さ」を計算して入れる） |
| `MqttOptions` | クライアントの設定の型 |
| `MqttClient` | クライアント本体のクラス |
| ├ `connect()` | WebSocket を開き、CONNECT を送り、CONNACK を待つ |
| ├ `subscribe()` | SUBSCRIBE を送り、SUBACK を待つ |
| ├ `publish()` | PUBLISH を送る |
| ├ `close()` | DISCONNECT を送り、WebSocket を閉じる |
| ├ `send()` | 接続中ならバイト列を送る（内部用） |
| ├ `handleClose()` | WebSocket が閉じたときの後始末（内部用） |
| ├ `receive()` | 届いたバイトをため、パケットに区切る（内部用） |
| └ `handlePacket()` | パケットの種別ごとに処理する（内部用） |

`MqttClient` を使っているのは `signaling.ts`（第6回）だけです。使い方の流れは次のとおりです。

```ts
const client = new MqttClient('wss://…', { clientId: 'ds-…', onMessage: (topic, payload) => { … } });
await client.connect();          // 接続（CONNECT → CONNACK）
await client.subscribe(topic);   // 購読（SUBSCRIBE → SUBACK）
client.publish(topic, bytes);    // 送信（PUBLISH）
client.close();                  // 切断（DISCONNECT）
```

---

## 3. 1行ずつの解説

### 1〜8行目：文字列の変換

```ts
// MQTT 3.1.1 over WebSocket の最小限のクライアント（接続・購読・送信・切断・死活確認、QoS 0のみ）
const enc = new TextEncoder();
const dec = new TextDecoder();

function str(s: string): number[] {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 0xff, ...b];
}
```

| 行 | 説明 |
|---|---|
| 2〜3 | 文字列とバイト列の変換器（第4回と同じ） |
| 6 | 文字列を UTF-8 のバイト列にする |
| 7 | 先頭に長さを2バイトで付ける。`b.length >> 8` で上位8ビット、`b.length & 0xff` で下位8ビットを取り出す（大きい桁が先。これを「ビッグエンディアン」と呼ぶ）。最後の `...b` でバイト列の中身を並べる |

`str('MQTT')` は `[0, 4, 77, 81, 84, 84]`（16進数で `00 04 4d 51 54 54`）を返します。戻り値を `Uint8Array` ではなく普通の配列（`number[]`）にしているのは、他の値と `...` で並べて組み立てやすくするためです。

### 10〜24行目：`packet()`（パケットの組み立て）

```ts
function packet(header: number, body: ArrayLike<number>): Uint8Array<ArrayBuffer> {
```

1バイト目（`header`）と本体（`body`）を受け取って、パケット全体を返します。`ArrayLike<number>` は「長さと番号付きの要素を持つもの」という型で、普通の配列（`number[]`）と `Uint8Array` のどちらでも受け取れます。

```ts
  const len: number[] = [];
  let n = body.length;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    len.push(byte);
  } while (n > 0);
```

「残りの長さ」（本体のバイト数）を、可変長整数にします。

| 行 | 説明 |
|---|---|
| 11 | 「残りの長さ」のバイトを入れる配列 |
| 12 | 本体のバイト数 |
| 13 | `do { … } while (条件)` は、まず1回実行してから、条件が真の間くり返す。長さ 0 でも、`00` の1バイトを必ず書くため |
| 14 | 128 で割った余り（下位7ビット分） |
| 15 | 128 で割った商（残りの部分）。`Math.floor` は小数点以下の切り捨て |
| 16 | まだ残りがあれば、最上位ビットを立てて「次に続く」の印にする。`\|=` は「OR して代入」 |
| 17 | 1バイト追加する |

347 の場合：1回目は余り 91、商 2 → `91 | 0x80` = `0xdb`。2回目は余り 2、商 0 → `0x02`。結果は `[0xdb, 0x02]` です。

```ts
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = header;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}
```

| 行 | 説明 |
|---|---|
| 19 | 全体の長さのバイト列を作る（1バイト目 + 残りの長さ + 本体） |
| 20 | 先頭に種別とフラグ |
| 21 | 2バイト目から「残りの長さ」 |
| 22 | その後ろに本体 |

### 26〜32行目：設定の型

```ts
export interface MqttOptions {
  clientId: string;
  keepAlive?: number;
  onMessage?: (topic: string, payload: Uint8Array<ArrayBuffer>) => void;
  /** 接続確立後に切れた場合のみ呼ばれる */
  onClose?: () => void;
}
```

| プロパティ | 意味 |
|---|---|
| `clientId` | ブローカーに名乗る名前。ブローカーは同じ名前の接続を1つしか認めないので、`ds-` + 乱数で毎回違う名前にする |
| `keepAlive?` | 死活確認の間隔（秒）。`?` は「省略してよい」 |
| `onMessage?` | メッセージが届いたときに呼ぶ関数。トピック名と中身（バイト列）を受け取る |
| `onClose?` | 接続できた後に、予期せず切れたときに呼ぶ関数 |

`onMessage` と `onClose` は「コールバック」と呼ばれる書き方です。クラスの外から関数を渡しておき、何かが起きたときにクラスの中から呼んでもらいます。

### 34〜48行目：クラスのプロパティとコンストラクター

```ts
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
```

| プロパティ | 意味 |
|---|---|
| `ws` | WebSocket。`connect()` するまでは `null` |
| `buffer` | 受信したが、まだパケットとして処理していないバイト（最初は空） |
| `nextPacketId` | 次に使うパケットID。SUBSCRIBE と SUBACK の対応づけに使う |
| `pendingSubs` | 結果待ちの購読。パケットID → 「結果を受け取る関数」の対応表（`Map`） |
| `pingTimer` | 死活確認のタイマー |
| `onConnack` | CONNACK が届いたときに呼ぶ関数。`connect()` の中で設定する |
| `closed` | 自分から閉じた（または閉じられた）か |
| `url` | ブローカーの URL。`readonly` なので後から変えられない |
| `opts` | 設定。`MqttOptions & { keepAlive: number }` は「`MqttOptions` であり、かつ `keepAlive` は必ずある」という型（`&` は「両方の条件を満たす」） |

`Map` は、キーと値の組を保存する入れ物です。`map.set(キー, 値)` で保存、`map.get(キー)` で取り出し、`map.delete(キー)` で削除します。

```ts
  constructor(url: string, opts: MqttOptions) {
    this.url = url;
    this.opts = { keepAlive: 30, ...opts };
  }
```

`{ keepAlive: 30, ...opts }` は、まず `keepAlive: 30` を入れ、その後に `opts` の中身を上書きで並べたオブジェクトです。`opts` に `keepAlive` があればそちらが使われ、なければ 30（秒）になります。既定値を与えるよくある書き方です。

コンストラクターでは、まだ接続しません。接続は `connect()` を呼んだときです。

### 50〜90行目：`connect()`（接続）

この関数の流れ：

```
WebSocket を開く ─→ onopen：CONNECT を送る ─→ CONNACK が届く ─→ 成功（resolve）
       │                                          │
       └─ エラー・切断・8秒経過 ──────────────────→ 失敗（reject）
```

```ts
  connect(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.close();
        reject(err);
      };
```

| 行 | 説明 |
|---|---|
| 50 | 引数はタイムアウトの時間（既定 8000ミリ秒＝8秒）。戻り値は、結果の値を持たない Promise（`Promise<void>`）。成功したかどうかだけを伝える |
| 51 | Promise を作って返す。中の関数はすぐに実行される |
| 52 | 結果（成功か失敗）が決まったかどうか |
| 53〜58 | 失敗のときの共通処理。すでに結果が決まっていれば何もしない。そうでなければ、接続を閉じて `reject` する |

`fail` を共通にしているのは、失敗の原因（エラー、切断、タイムアウト）が複数あり、**どれが先に起きても、処理を1回だけにする**ためです。たとえばエラーの後には、たいてい切断も起きますが、2回目の `fail` は `settled` で止まります。

`fail` はアロー関数で書いています。アロー関数の中の `this` は、外側（この `connect()` を呼んだ `MqttClient` の実体）の `this` をそのまま使えます。

```ts
      const timer = setTimeout(() => fail(new Error('timeout')), timeoutMs);
```

8秒たっても成功しなければ、タイムアウトとして失敗にします。ブローカーが応答しないときに、いつまでも待たないためです。

```ts
      this.onConnack = (rc) => {
        clearTimeout(timer);
        if (rc !== 0) return fail(new Error(`CONNACK ${rc}`));
        settled = true;
        this.pingTimer = setInterval(() => this.send(new Uint8Array([0xc0, 0])), (this.opts.keepAlive * 1000) / 2);
        resolve();
      };
```

CONNACK が届いたときの処理を、プロパティに登録しておきます。実際に呼ばれるのは、後の `handlePacket()` の中です。

| 行 | 説明 |
|---|---|
| 61 | タイムアウトを取り消す |
| 62 | `rc`（リターンコード）が 0 以外なら、ブローカーに接続を断られた（1：プロトコルの版が違う、2：クライアントIDが不正、3：サーバーが使えない、など） |
| 63 | 成功で確定 |
| 64 | 死活確認を始める。キープアライブ（30秒）の半分の15秒ごとに PINGREQ（`c0 00`）を送る。MQTT では、キープアライブの時間（の1.5倍）何も送らないと、ブローカーが接続を切ってよいことになっているため |
| 65 | `await client.connect()` している側に成功を伝える |

```ts
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url, 'mqtt');
      } catch (e) {
        clearTimeout(timer);
        fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
```

WebSocket を作ります。この時点で接続が始まります。URL の形式が不正だと、`new WebSocket` はその場で例外を投げるので、`try` / `catch` で受け止めて失敗にします。

73行目の `e instanceof Error ? e : new Error(String(e))` は、受け止めたものが `Error` ならそのまま、そうでなければ `Error` に包んでいます。JavaScript では `Error` 以外のもの（文字列など）も投げられるため、`catch` で受け取る `e` の型は `unknown` です。

```ts
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const ka = this.opts.keepAlive;
        this.send(packet(0x10, [...str('MQTT'), 4, 0x02, ka >> 8, ka & 0xff, ...str(this.opts.clientId)]));
      };
```

| 行 | 説明 |
|---|---|
| 77 | 受信したバイナリを `ArrayBuffer` で受け取る設定。既定は `Blob`（ファイルのような扱いで、読むのに非同期の処理が必要）なので変えている |
| 78〜81 | WebSocket がつながったら、CONNECT パケットを送る |

80行目の CONNECT の本体：

| 部分 | バイト | 意味 |
|---|---|---|
| `...str('MQTT')` | `00 04 4d 51 54 54` | プロトコル名 |
| `4` | `04` | プロトコルのレベル。4 は MQTT 3.1.1 |
| `0x02` | `02` | 接続フラグ。Clean Session（以前の接続の状態を引き継がない）だけを立てる。ユーザー名・パスワードは使わない |
| `ka >> 8, ka & 0xff` | `00 1e` | キープアライブ 30秒を2バイトで |
| `...str(this.opts.clientId)` | `00 0f 64 73 2d …` | クライアントID（長さ＋文字列） |

クライアントIDが15文字なら、本体は 6 + 1 + 1 + 2 + 2 + 15 = 27 バイトです。1バイト目 `0x10` と「残りの長さ」`0x1b`（27）が付き、パケットは `10 1b 00 04 4d 51 54 54 04 02 00 1e 00 0f …` になります。

```ts
      ws.onmessage = (e: MessageEvent<ArrayBuffer>) => this.receive(new Uint8Array(e.data));
      ws.onerror = () => fail(new Error('websocket error'));
      ws.onclose = () => {
        clearTimeout(timer);
        fail(new Error('closed'));
        this.handleClose();
      };
    });
  }
```

| 行 | 説明 |
|---|---|
| 82 | データが届いたら、`receive()` に渡す |
| 83 | WebSocket のエラーは失敗にする（接続後なら `fail` は何もしない） |
| 84〜88 | WebSocket が閉じたら：接続前なら失敗にし、どちらの場合も `handleClose()` で後始末する |

**`ws.onclose` は接続後にも呼ばれます。** 成功した後に切れた場合、`settled` が `true` なので `fail` は何もしません。`handleClose()` だけが働き、`onClose` コールバックで呼び出し元に伝えます（134行目）。

### 92〜106行目：`subscribe()`（購読）

```ts
  subscribe(topic: string, timeoutMs = 8000): Promise<void> {
    const id = this.nextPacketId++;
```

パケットIDを1つ取り、次のために1増やします。`x++` は「今の値を使ってから1増やす」です。

```ts
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
```

| 行 | 説明 |
|---|---|
| 95〜98 | 8秒たっても SUBACK が来なければ、待ちの登録を消して失敗にする |
| 99〜103 | パケットIDに対応づけて、「結果を受け取る関数」を登録しておく。SUBACK が届くと `handlePacket()` がこの関数を呼び、成功なら `resolve`、拒否なら `reject` する |
| 104 | SUBSCRIBE パケットを送る |

104行目の SUBSCRIBE パケット：

| 部分 | 意味 |
|---|---|
| `0x82` | 種別 8（SUBSCRIBE）。下位4ビットの `0010` は、仕様で決められた固定値 |
| `id >> 8, id & 0xff` | パケットID（2バイト） |
| `...str(topic)` | 購読するトピック名 |
| `0` | 希望する QoS（0） |

**なぜパケットIDで対応づけるのか**：複数のトピックを続けて購読した場合、どの SUBACK がどの SUBSCRIBE への返事か分からなくなるためです。ブローカーは、SUBSCRIBE と同じパケットIDを SUBACK に入れて返します。

### 108〜118行目：`publish()` と `send()`

```ts
  publish(topic: string, payload: Uint8Array): void {
    const t = str(topic);
    const body = new Uint8Array(t.length + payload.length);
    body.set(t);
    body.set(payload, t.length);
    this.send(packet(0x30, body));
  }
```

| 行 | 説明 |
|---|---|
| 109 | トピック名を MQTT の文字列の形式にする |
| 110〜112 | トピック名の後ろに中身をつなげて本体にする |
| 113 | `0x30`：種別 3（PUBLISH）、フラグは全部 0（重複送信の印なし、QoS 0、保持なし）で送る |

QoS 0 の PUBLISH にはパケットIDがないので、本体は「トピック名＋中身」だけです。`publish()` は送りっぱなしで、届いたかどうかの返事はありません。そのため Promise ではなく `void` を返します。

```ts
  private send(bytes: Uint8Array<ArrayBuffer>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }
```

WebSocket がつながっている（`readyState` が `OPEN`）ときだけ送ります。つながっていなければ、**何もせず黙って捨てます**。切断の処理中に送ろうとしても、例外にならないようにするためです。

### 120〜139行目：`close()` と `handleClose()`

```ts
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
```

| 行 | 説明 |
|---|---|
| 121〜122 | 2回目以降は何もしない。何度呼んでも安全にしている |
| 123 | 死活確認を止める |
| 125 | DISCONNECT（`e0 00`）を送り、ブローカーに「意図的な切断です」と伝える |
| 127 | WebSocket を閉じる |

```ts
  private handleClose(): void {
    clearInterval(this.pingTimer);
    const wasOpen = !this.closed;
    this.closed = true;
    if (wasOpen) this.opts.onClose?.();
  }
```

WebSocket が閉じたとき（`ws.onclose`）に呼ばれます。

| 状況 | `closed` | `onClose` を呼ぶか |
|---|---|---|
| 自分で `close()` した後 | すでに `true` | 呼ばない |
| 接続前に失敗した（`fail` の中で `close()` 済み） | すでに `true` | 呼ばない |
| 接続後に、ブローカーやネットワークの都合で切れた | `false` | **呼ぶ** |

つまり `onClose` は、30行目のコメントどおり「接続確立後に予期せず切れた場合」だけ呼ばれます。`this.opts.onClose?.()` の `?.()` は、「`onClose` が設定されていれば呼ぶ」という意味です。

### 141〜169行目：`receive()`（パケットの区切り）

```ts
  private receive(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
```

届いたバイトを、前回までの残り（`buffer`）の後ろにつなげます。

```ts
    for (;;) {
      if (this.buffer.length < 2) return;
```

`for (;;)` は、条件なしでくり返す書き方です（`while (true)` と同じ）。中の `return` か `break` で抜けます。ためたバイトから、パケットを取り出せるだけ取り出します。

2バイト未満では、1バイト目と「残りの長さ」すらそろっていないので、次の受信を待ちます。

```ts
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
```

「残りの長さ」を読みます（`packet()` の逆）。

| 行 | 説明 |
|---|---|
| 149 | 読み取った長さ |
| 150 | 今のバイトの重み（1、128、128²…） |
| 151 | 読む位置。0番目は1バイト目なので、1番目から |
| 153 | 長さのバイトがまだ全部届いていなければ、次の受信を待つ |
| 154 | 1バイト読み、位置を進める |
| 155 | 下位7ビットに重みを掛けて足す |
| 156 | 次のバイトの重みは128倍 |
| 157 | 最上位ビットが 0 なら、長さはここまで |
| 158〜161 | 4バイト読んでもまだ続くなら、仕様違反（壊れたデータ）なので切断する |

```ts
      if (this.buffer.length < i + len) return;
      const header = this.buffer[0];
      const body = this.buffer.slice(i, i + len);
      this.buffer = this.buffer.slice(i + len);
      this.handlePacket(header, body);
    }
  }
```

| 行 | 説明 |
|---|---|
| 163 | 本体がまだ全部届いていなければ、次の受信を待つ |
| 164 | 1バイト目 |
| 165 | 本体を切り出す |
| 166 | 処理した分を `buffer` から取り除く（残りは次のパケット） |
| 167 | パケットを処理する。その後、147行目に戻って、次のパケットがあれば続けて取り出す |

### 171〜203行目：`handlePacket()`（種別ごとの処理）

```ts
  private handlePacket(header: number, body: Uint8Array<ArrayBuffer>): void {
    switch (header >> 4) {
```

1バイト目を右に4ビットずらして、上位4ビット（種別）だけを取り出し、`switch` で分岐します。`switch` は、値に一致する `case` に飛び、`break` までを実行します。

```ts
      case 2: // CONNACK
        this.onConnack?.(body[1]);
        break;
```

CONNACK の本体は2バイトです。1バイト目は「前回のセッションが残っているか」、2バイト目がリターンコード（0 なら成功）です。`connect()` で登録した関数に、リターンコードを渡します。

```ts
      case 3: {
        // PUBLISH
        const qos = (header >> 1) & 3;
        const topicLen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.slice(2, 2 + topicLen));
        let offset = 2 + topicLen;
```

| 行 | 説明 |
|---|---|
| 176 | `case` の中で `const` を使うときは、`{ }` で囲んで範囲を区切る（他の `case` の変数と名前がぶつからないように） |
| 178 | QoS は1バイト目の2〜3ビット目（右から数えて）。1ビット右にずらして、下位2ビットを取り出す |
| 179 | トピック名の長さ（2バイト、大きい桁が先） |
| 180 | トピック名を文字列にする |
| 181 | 中身が始まる位置 |

```ts
        if (qos > 0) {
          const id = [body[offset], body[offset + 1]];
          offset += 2;
          if (qos === 1) this.send(new Uint8Array([0x40, 2, ...id])); // PUBACK
        }
        this.opts.onMessage?.(topic, body.slice(offset));
        break;
      }
```

| 行 | 説明 |
|---|---|
| 182〜186 | QoS 1 以上ならパケットIDがあるので読み飛ばす。QoS 1 なら受信確認（PUBACK）を返す |
| 187 | トピック名と中身を `onMessage` コールバックに渡す |

**182〜186行目は念のための処理です。** ブローカーは、配信するときの QoS を「送った側の QoS」と「購読したときの QoS」の小さい方にします。このクライアントは QoS 0 で購読しているので、QoS 1 以上のメッセージは届かないはずです。

```ts
      case 9: {
        // SUBACK
        const id = (body[0] << 8) | body[1];
        const cb = this.pendingSubs.get(id);
        this.pendingSubs.delete(id);
        cb?.(body[2] !== 0x80);
        break;
      }
```

| 行 | 説明 |
|---|---|
| 192 | パケットID |
| 193〜194 | 対応する「結果を受け取る関数」を取り出し、登録を消す |
| 195 | 結果を伝える。本体の3バイト目が `0x80` なら拒否、それ以外（`0x00` など、許可された QoS）なら成功 |

```ts
      default:
        // PINGRESP など
        break;
    }
  }
}
```

それ以外の種別（PINGRESP など）は何もしません。PINGRESP を受け取っても、特にすることはないためです。

#### 気づいた点：PINGRESP が来なくても気づけない

このクライアントは PINGREQ を送りますが、PINGRESP が返ってきたかは確認していません。ブローカーが応答しないまま接続が残る（WebSocket が閉じない）状況では、切れたことに気づけません。

ただし、direct-share でブローカーを使うのは、接続の確立までの数秒〜30秒程度です。その間に問題が起きても、30秒のタイムアウト（第7回）でエラーになるので、実用上の影響は小さいです。

---

## 4. 動かして確認

### 4-1. 実際のブローカーとバイト列をやり取りする

開発サーバーでページを開き、Console で次を貼り付けて実行します。送受信したバイト列を16進数で記録します。

```js
const { MqttClient } = await import('/direct-share/src/mqtt.ts');
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const log = [];

// WebSocket の送信を横取りして、送ったバイト列を記録する（確認用）
const orig = WebSocket.prototype.send;
WebSocket.prototype.send = function (d) { log.push('送信 ' + hex(new Uint8Array(d))); return orig.call(this, d); };

let got;
const a = new MqttClient('wss://broker.emqx.io:8084/mqtt', {
  clientId: 'ds-walkthrough1',
  onMessage: (t, p) => { got = t + ' / ' + new TextDecoder().decode(p); },
});
await a.connect();
a.ws.addEventListener('message', (e) => log.push('受信 ' + hex(new Uint8Array(e.data))));
await a.subscribe('direct-share/test/abc');
a.publish('direct-share/test/abc', new TextEncoder().encode('hi'));
await new Promise((r) => setTimeout(r, 1500));
a.close();
WebSocket.prototype.send = orig;   // 元に戻す
({ log, got })
```

実際に動かした結果：

```
送信 10 1b 00 04 4d 51 54 54 04 02 00 1e 00 0f 64 73 2d 77 61 6c 6b 74 68 72 6f 75 67 68 31
送信 82 1a 00 01 00 15 64 69 72 65 63 74 2d 73 68 61 72 65 2f 74 65 73 74 2f 61 62 63 00
送信 30 19 00 15 64 69 72 65 63 74 2d 73 68 61 72 65 2f 74 65 73 74 2f 61 62 63 68 69
受信 90 03 00 01 00
受信 30 19 00 15 64 69 72 65 63 74 2d 73 68 61 72 65 2f 74 65 73 74 2f 61 62 63 68 69
送信 e0 00

got: 'direct-share/test/abc / hi'
```

1行ずつ読み解いてみてください。

| 行 | 読み方 |
|---|---|
| `10 1b …` | CONNECT。残り27バイト。`00 04 4d 51 54 54`＝"MQTT"、`04`＝3.1.1、`02`＝Clean Session、`00 1e`＝30秒、`00 0f`＝15文字のクライアントID `ds-walkthrough1` |
| `82 1a 00 01 00 15 …00` | SUBSCRIBE。残り26バイト。パケットID 1、21文字（`0x15`）のトピック名、最後の `00` が QoS 0 |
| `30 19 00 15 … 68 69` | PUBLISH。残り25バイト。トピック名の後ろの `68 69` が中身の "hi" |
| `90 03 00 01 00` | SUBACK。パケットID 1 の購読が QoS 0 で許可された |
| `30 19 …` | 自分が送った PUBLISH が、そのまま自分に届いた |
| `e0 00` | DISCONNECT |

**`got` を見ると、自分が送った "hi" を自分で受け取っています。** ブローカーは、送った本人にも配信するためです。

補足：

- CONNACK（`20 02 00 00`）は記録されていません。受信の記録を始めたのが `connect()` の完了後だからです。
- 送信の PUBLISH が、受信の SUBACK より前に記録されています。SUBACK を受け取ると、このクラスの `onmessage` が先に実行されて `subscribe()` が完了し、PUBLISH を送ります。記録用に後から追加した受信の処理は、その後に動くためです。実際の通信の順番は、SUBACK の受信 → PUBLISH の送信です。
- `a.ws` は `private` のプロパティですが、`private` は TypeScript の型チェックだけの制限なので、実行時には外から見えます。ここでは確認のためにあえて使っています。

### 4-2. 開発者ツールで見る

開発者ツールの Network タブで「WS」に絞り込むと、アプリが接続している3つのブローカーが表示されます。1つを選んで「Messages」を開くと、送受信したバイナリのメッセージが並んでいます。ブラウザによっては、16進数などで中身を表示できます。

---

## 5. 理解チェック

1. MQTT で、送る側と受け取る側がお互いのアドレスを知らなくても通信できるのはなぜですか。
2. 本体が 200 バイトのとき、「残りの長さ」は何バイトで、どんな値になりますか。
3. `connect()` の中の `settled` は、何を防ぐためにありますか。
4. `send()` は、WebSocket がつながっていないときにどうしますか。そうしている理由は何ですか。
5. `subscribe()` でパケットIDを使っているのはなぜですか。
6. `receive()` で、受け取ったバイトをすぐに処理せず `buffer` にためているのはなぜですか。
7. `onClose` コールバックが呼ばれるのは、どんなときですか。
8. `20 02 00 05` という CONNACK が届いたら、`connect()` はどうなりますか。

<details>
<summary>答え</summary>

1. 両者がブローカーに接続し、同じトピック名を使っているため。ブローカーが、トピックを購読しているクライアントにメッセージを配る。
2. 2バイトで `c8 01`。200 = 72 + 1 × 128。1バイト目は 72（`0x48`）に「続く」の印 `0x80` を付けて `0xc8`、2バイト目は 1。
3. 成功や失敗の処理が2回以上行われること。たとえばエラーの後に切断が起きても、失敗の処理（接続を閉じて `reject` する）は1回だけになる。
4. 何もせず、黙って捨てる。切断の処理中などに送ろうとしたときに、例外で処理全体が止まらないようにするため。
5. 複数の購読を続けて行ったとき、届いた SUBACK がどの SUBSCRIBE への返事かを対応づけるため。
6. WebSocket の1回の受信が、MQTT の1パケットとは限らないため。パケットが途中までしか届いていない場合は、続きが届くまで待つ必要がある。逆に、複数のパケットがまとめて届くこともある。
7. 接続に成功した後で、自分から `close()` していないのに、WebSocket が閉じたとき（ブローカーやネットワークの都合で切れたとき）。
8. リターンコードが 5（認可されていない）で 0 ではないので、失敗になる。`CONNACK 5` というエラーで `reject` され、接続は閉じられる。

</details>

---

次回（第6回）は `src/signaling.ts` を読みます。このクラスを3つのブローカー分まとめて動かし、第4回の暗号と組み合わせて、シグナリングのメッセージをやり取りする部分です。
