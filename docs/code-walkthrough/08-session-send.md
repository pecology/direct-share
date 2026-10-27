# 第8回 `src/session.ts` 前半：送信

`session.ts` は、**接続が確立した後のテキストとファイルのやり取りをすべて受け持つ**部品です（要件 4.4、4.5）。453行あるので、2回に分けて読みます。

- 第8回（この回）：型の定義、準備、**送信**（1〜230行目）
- 第9回：**受信**、メモリの管理、終了の処理（232〜453行目）

---

## 1. 前提知識

### 1-1. データチャネル

第7回で開いたデータチャネル（`RTCDataChannel`）は、WebSocket とよく似た使い方ができます。

```ts
dc.send('文字列');        // テキストとして送る
dc.send(arrayBuffer);     // バイナリとして送る
dc.onmessage = (e) => {   // 届いたら呼ばれる。e.data は文字列か ArrayBuffer
};
dc.close();
```

| 性質 | 説明 |
|---|---|
| 確実に届く | 失われたデータは自動で再送される（`ordered: true` で作った場合の既定） |
| 順番どおりに届く | `ordered: true` を指定したので、送った順に届く |
| 1回に送れる大きさに上限がある | SDP の `a=max-message-size`（多くのブラウザで 256KB）。大きなファイルは分割（チャンク）して送る必要がある |
| 文字列とバイナリを区別して届ける | 受け取った側は、`typeof e.data === 'string'` で見分けられる |

### 1-2. 送信バッファと流量の調整

`dc.send()` は、データを**送信バッファ**に入れて、すぐに戻ってきます。実際の送信は、ブラウザが裏で回線の速さに合わせて行います。

```
アプリ ──send()──→ [ 送信バッファ ] ──回線の速さで──→ 相手
                    dc.bufferedAmount
                  （まだ送れていないバイト数）
```

ファイルを読み込む速さは、回線より何倍も速いのが普通です。何も考えずに `send()` し続けると、送信バッファに何十MBもたまり、メモリを圧迫します。バッファが上限（Chrome では 16MB）を超えると、`send()` が例外を投げて送信できなくなります。

そこで、**送信バッファの残量を見ながら送る**ようにします（要件 F-49）。

```
残量が 4MB を超えた → 送るのを一時停止
    ↓ 回線が少しずつ送り出す
残量が 1MB を下回った → bufferedamountlow イベント → 送信を再開
```

| 項目 | 意味 |
|---|---|
| `dc.bufferedAmount` | 送信バッファに残っているバイト数 |
| `dc.bufferedAmountLowThreshold` | この値を下回ったときに `bufferedamountlow` イベントを起こす、という境目 |
| `bufferedamountlow` イベント | 送信バッファの残量が、上の境目を下回ったときに起きる |

上限を「高い水位」（4MB）、再開の境目を「低い水位」（1MB）と呼びます。水位の差があるので、止める・再開するをこまめにくり返さずに済みます。

### 1-3. File と Blob

| 型 | 意味 |
|---|---|
| `Blob` | ひとかたまりのバイナリデータ。中身はメモリやディスクにあり、必要なときに読む |
| `File` | `Blob` にファイル名などが付いたもの。ファイル選択やドラッグ＆ドロップで得られる |
| `blob.slice(開始, 終了)` | 一部分を切り出した `Blob` を作る。この時点ではまだ読み込まない |
| `await blob.arrayBuffer()` | 中身を読み込んで `ArrayBuffer` にする（非同期） |

ファイル全体を一度に読み込まず、**64KB ずつ切り出して読み込み、送る**ことで、100MB のファイルでもメモリを大きく使わずに済みます。

### 1-4. このアプリのやり取りの形式

データチャネルで送るものは2種類です。

- **文字列**：JSON の制御メッセージ（下の表）
- **バイナリ**：ファイルの中身の断片（チャンク）

| メッセージ | 意味 | 向き |
|---|---|---|
| `{ t: 'text', id, part, total, body }` | テキスト（長い場合は分割） | 送信側 → 受信側 |
| `{ t: 'file', id, name, size, mime }` | これからファイルを送る（ファイルの情報） | 送信側 → 受信側 |
| （バイナリ） | ファイルの中身の断片 | 送信側 → 受信側 |
| `{ t: 'end', id }` | ファイルを送り終えた | 送信側 → 受信側 |
| `{ t: 'cancel', id }` | ファイルの転送をキャンセルする | どちらからでも |
| `{ t: 'reject', id, reason }` | ファイルを受け取れない | 受信側 → 送信側 |
| `{ t: 'bye' }` | 切断する | どちらからでも |

ファイルを1つ送るときの流れ：

```
送信側                                   受信側
 │ ─── {t:'file', id:'f1', name, size} ──→ │ 受け取る準備（またはここで reject）
 │ ─── バイナリ（64KB）────────────────→ │ ためる
 │ ─── バイナリ（64KB）────────────────→ │ ためる
 │      …                                │
 │ ─── {t:'end', id:'f1'} ─────────────→ │ つなげて Blob にする
```

**バイナリにはファイルのIDが付いていません。** データチャネルは順番どおりに届くことと、ファイルは1つずつ順に送ることから、「直前の `file` メッセージのファイルの続き」だと分かるからです。

### 1-5. このファイルで新しく出てくる TypeScript の書き方

| 書き方 | 意味 |
|---|---|
| `type Wire = { t: 'text'; … } \| { t: 'file'; … } \| …` | 判別可能なユニオン型。共通のプロパティ（`t`）の値で、どの形かを見分けられる |
| `Iterable<File>` | `for…of` で1つずつ取り出せるもの（配列など）の型 |
| `Extract<Wire, { t: 'file' }>` | `Wire` のうち、`{ t: 'file' }` に当てはまる形だけを取り出した型（第9回） |
| `readonly items = …` | `readonly` のプロパティ。`private` を付けていないので外から読めるが、別の Map に入れ替えることはできない |

---

## 2. ファイルの全体像

| 名前 | 役割 |
|---|---|
| 定数（4〜13行目） | 上限、分割の大きさ、水位、メッセージ |
| `FileStatus` | ファイルの状態 |
| `TextItem`、`FileItem`、`Item` | 履歴の1件分（画面の吹き出し1つ分）の型 |
| `Wire` | データチャネルで送る JSON の型 |
| `SessionEvents` | 画面側に知らせるための関数の型 |
| `Session` | 本体のクラス |
| ├ `sendText()` | テキストを送る |
| ├ `sendFiles()` | ファイルを送信待ちに加える |
| ├ `pump()` | 送信待ちのファイルを1つずつ送る（内部用） |
| ├ `sendFile()` | ファイル1つを分割して送る（内部用） |
| ├ `waitBufferLow()` | 送信バッファが減るのを待つ（内部用） |
| ├ `cancel()` | 転送をキャンセルする |
| ├ `handleJson()` 〜 `release()` | 受信とメモリの管理（第9回） |
| └ `close()` 〜 `updateBusy()` | 終了と小道具（第9回） |

`Session` を使っているのは `main.ts`（第10回）です。接続が確立したら1つ作り、切断したら捨てます。

---

## 3. 1行ずつの解説

### 1〜13行目：定数

```ts
// 接続後のデータ送受信（4.4, 4.5）
import { randomId } from './crypto.ts';

export const MAX_TEXT_LENGTH = 100_000; // F-36
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // F-50
export const MAX_HELD_BYTES = 100 * 1024 * 1024; // F-51
```

| 定数 | 値 | 意味 |
|---|---|---|
| `MAX_TEXT_LENGTH` | 10万 | 1回に送れるテキストの文字数 |
| `MAX_FILE_SIZE` | 100MB | 1ファイルの最大サイズ。`100 * 1024 * 1024` = 104,857,600 バイト |
| `MAX_HELD_BYTES` | 100MB | 受信したファイルを、メモリにまとめて持っておける量 |

```ts
const TEXT_PART_LENGTH = 16_000; // UTF-8 でも1メッセージ64KB未満に収まる長さ
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;
```

| 定数 | 値 | 意味 |
|---|---|---|
| `TEXT_PART_LENGTH` | 16,000文字 | 長いテキストを分割するときの1つ分の文字数（後述） |
| `HIGH_WATER` | 4MB | 送信バッファがこれを超えたら、送るのを止める |
| `LOW_WATER` | 1MB | 送信バッファがこれを下回ったら、再開する |
| `PROGRESS_INTERVAL_MS` | 100ミリ秒 | 進捗を画面に知らせる最短の間隔。64KB ごとに画面を更新すると重くなるため |

```ts
export const NO_SPACE_MESSAGE = '受信側の空きが足りません。保存または破棄が必要です';
```

受信側のメモリが足りないときのメッセージ（要件 F-51）。送信側と受信側の両方で表示するので、定数にしています。

### 15〜49行目：履歴の型

```ts
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
```

ファイルの状態です。状態の移り変わり：

```
送信側：queued（送信待ち）→ sending（送信中）→ sent（送信済み）
                    │             ├→ cancelled（キャンセル）
                    └─────────────┤→ rejected（相手が受信を拒否）
                                  └→ failed（失敗）

受信側：receiving（受信中）→ received（受信済み）→ released（破棄済み）
             ├→ cancelled
             └→ failed
        rejected（受信を拒否した）
```

```ts
export interface TextItem {
  kind: 'text';
  id: string;
  mine: boolean;
  ts: number;
  body: string;
}
```

テキスト1件分です。

| プロパティ | 意味 |
|---|---|
| `kind` | 種類。`'text'` 固定 |
| `id` | ID（送信側が作り、相手にも同じIDで伝わる） |
| `mine` | 自分が送ったものなら `true`（画面で右寄せにする） |
| `ts` | 時刻（1970年1月1日からのミリ秒） |
| `body` | 本文 |

```ts
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
```

ファイル1件分です。

| プロパティ | 意味 |
|---|---|
| `name`、`size`、`mime` | ファイル名、バイト数、種類（`image/png` など） |
| `status` | 状態 |
| `transferred` | 送った（受け取った）バイト数。進捗の表示に使う |
| `blob` | 受信したファイルの中身。受信が終わるまでと、破棄した後は `null` |
| `saved` | 「保存」ボタンで保存したか |
| `file` | 送信するファイル。送り終えたら `null` にして、参照を手放す |

`Item` は、テキストかファイルのどちらかです。`kind` を見れば、どちらか分かります（判別可能なユニオン型）。

### 51〜76行目：やり取りの型と、画面に知らせる関数

```ts
type RejectReason = 'nospace' | 'toolarge';

type Wire =
  | { t: 'text'; id: string; part: number; total: number; body: string }
  | { t: 'file'; id: string; name: string; size: number; mime: string }
  | { t: 'end'; id: string }
  | { t: 'cancel'; id: string }
  | { t: 'reject'; id: string; reason: RejectReason }
  | { t: 'bye' };
```

データチャネルで送る JSON の型です（前提知識 1-4 の表）。`t` は type の略で、通信量を少しでも減らすため1文字にしています。`RejectReason` は受信を拒否する理由（メモリ不足、大きすぎる）です。

```ts
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
```

`Session` から画面（`main.ts`）に知らせるための関数です。`Session` は画面の部品を直接さわらず、これらの関数を呼ぶだけです。画面の作りと、送受信の仕組みを分けておくためです（そのおかげで、画面なしでテストできます。第12回）。

| 関数 | 画面側ですること |
|---|---|
| `onItem` | 吹き出しを追加・更新する |
| `onNotice` | トーストを表示する |
| `onBusyChange` | 画面のスリープ防止をオン・オフする |
| `onClose` | 「切断しました」と表示し、待機画面に戻る。`'local'` は自分から、`'peer'` は相手から（または通信の断絶で）切れた |

```ts
interface Incoming {
  item: FileItem;
  chunks: ArrayBuffer[];
}
```

受信中のファイルです。届いた断片を `chunks` にためます（第9回）。

### 78〜108行目：プロパティとコンストラクター

```ts
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
```

| プロパティ | 意味 |
|---|---|
| `items` | 履歴のすべての項目。ID → 項目。`Map` は追加した順番を覚えているので、古い順に取り出せる |
| `queue` | 送信待ちのファイル |
| `sending` | 今送っているファイル |
| `incoming` | 今受け取っているファイル |
| `textParts` | 分割されたテキストの、届いた分 |
| `busy` | ファイルの転送中か |
| `ended` | 終わったか |
| `chunkSize` | ファイルを分割する大きさ |
| `pc`、`dc` | 接続とデータチャネル |
| `events` | 画面に知らせる関数 |

```ts
  constructor(pc: RTCPeerConnection, dc: RTCDataChannel, events: SessionEvents) {
    this.pc = pc;
    this.dc = dc;
    this.events = events;
    const max = pc.sctp?.maxMessageSize || 65536;
    this.chunkSize = Math.min(64 * 1024, max);
```

| 行 | 説明 |
|---|---|
| 95 | 相手と取り決めた、1回に送れる最大のバイト数。`pc.sctp` は接続の SCTP（データ運搬）の情報。分からなければ 64KB とみなす |
| 96 | 分割の大きさは、64KB と最大値の小さい方 |

64KB にしているのは、どのブラウザの組み合わせでも安全に送れる大きさだからです。実際に Chrome 同士で試すと最大値は 256KB でしたが、それでも 64KB を使います。

```ts
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (typeof e.data === 'string') this.handleJson(e.data);
      else this.handleChunk(e.data);
    };
```

| 行 | 説明 |
|---|---|
| 98 | バイナリを `ArrayBuffer` で受け取る（第5回の WebSocket と同じ） |
| 99 | 送信バッファが 1MB を下回ったら、`bufferedamountlow` イベントを起こすようにする |
| 100〜103 | 届いたものが文字列なら JSON のメッセージとして、バイナリならファイルの断片として処理する |

```ts
    dc.onclose = () => this.end('peer');
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.end('peer');
    });
  }
```

| 行 | 説明 |
|---|---|
| 104 | データチャネルが閉じたら、終了する。相手がページを閉じたときなど |
| 105〜107 | 接続が失敗・終了したら、終了する。通信が途切れた場合など |

105行目で `onconnectionstatechange =` ではなく `addEventListener` を使っているのは、`connection.ts` がすでに `onconnectionstatechange` を設定しているからです。`on…=` で設定すると上書きになりますが、`addEventListener` なら追加になります。

### 112〜125行目：`sendText()`（テキストを送る）

```ts
  /** エラーがあればメッセージを返す */
  sendText(body: string): string | null {
    if (body.length > MAX_TEXT_LENGTH) {
      return `テキストは${MAX_TEXT_LENGTH.toLocaleString()}文字までです（現在：${body.length.toLocaleString()}文字）`;
    }
```

10万文字を超えていたら、送らずにエラーメッセージを返します（要件 F-36）。`toLocaleString()` は、数を `100,000` のように桁区切りにします。戻り値が `null` なら成功です。

```ts
    const id = randomId();
    const total = Math.max(1, Math.ceil(body.length / TEXT_PART_LENGTH));
    for (let part = 0; part < total; part++) {
      const piece = body.slice(part * TEXT_PART_LENGTH, (part + 1) * TEXT_PART_LENGTH);
      this.send({ t: 'text', id, part, total, body: piece });
    }
    this.add({ kind: 'text', id, mine: true, ts: Date.now(), body });
    return null;
  }
```

| 行 | 説明 |
|---|---|
| 117 | テキストのID |
| 118 | 分割する数。`Math.ceil` は切り上げ。空の文字列でも1つは送るよう、`Math.max(1, …)` にしている |
| 119〜122 | 16,000文字ずつ切り出して、番号（`part`）と総数（`total`）を付けて送る |
| 123 | 自分の履歴に追加し、画面に知らせる |

**なぜ分割するのか**：データチャネルには1回に送れる大きさの上限があります。10万文字の日本語は、UTF-8 で約300KB になり、上限（256KB）を超えます。16,000文字なら、日本語（1文字3バイト）でも約48KB に収まります。

**分割で文字が壊れないか**：絵文字などは、JavaScript の文字列の中では2つの部品（サロゲートペア）でできています。16,000文字目でちょうど2つに割れてしまうことがありえます。それでも、`JSON.stringify` は割れた片方を `\ud83d` のような形で正しく書き出し、受信側でつなげ直せば元の絵文字に戻ります。

**気づいた点**：コメントには「1メッセージ64KB未満に収まる」とありますが、これは普通の文章の場合です。JSON にすると、改行は `\n` の2文字に、制御文字は `\u0000` の6文字になります。制御文字だけの16,000文字なら約96KB になります。それでも上限の 256KB には収まるので、実際に問題になることはありません。

### 127〜152行目：`sendFiles()`（送信待ちに加える）

```ts
  sendFiles(files: Iterable<File>): void {
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        this.events.onNotice(`「${file.name}」は100MBを超えるため送信できません`);
        continue;
      }
```

選ばれたファイルを1つずつ調べます。100MB を超えるものは、通知して飛ばします（要件 F-50）。送る前に確かめるので、無駄な通信をしません。

```ts
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
```

履歴の項目を「送信待ち」として作り、送信待ちの列（`queue`）と履歴に加えます。`file` は `file: file` の省略形です。

```ts
    this.updateBusy();
    void this.pump();
  }
```

転送中の状態を更新し（スリープ防止をオンにするため）、送信を始めます。

### 154〜169行目：`pump()`（1つずつ順に送る）

```ts
  private async pump(): Promise<void> {
    if (this.sending) return;
```

すでに送っている途中なら、何もしません。送信中の `pump()` が、送信待ちの列から次のファイルを取り出してくれるからです。こうして、**同時に送るファイルを1つに限っています**（要件 F-44：1ファイルずつ順に送信）。

```ts
    for (let item = this.queue.shift(); item && !this.ended; item = this.queue.shift()) {
      if (item.status !== 'queued' || !item.file) continue;
```

`for` の3つの部分を分けて読みます。

| 部分 | 意味 |
|---|---|
| `let item = this.queue.shift()` | 最初に1回：列の先頭を取り出す。`shift()` は配列の先頭を取り除いて返す。空なら `undefined` |
| `item && !this.ended` | くり返す条件：取り出せていて、終わっていない |
| `item = this.queue.shift()` | 1回終わるごとに：次を取り出す |

157行目：送信待ちの間にキャンセルされたもの（状態が `queued` でない）は飛ばします。

```ts
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
```

| 行 | 説明 |
|---|---|
| 158〜160 | 送信中にして、画面に知らせる |
| 161〜165 | 1ファイルを送り終わるまで待つ。途中で例外が起きたら、そのファイルは失敗にして、次のファイルに進む |
| 166 | 送信中のファイルなし |
| 168 | 全部送り終えたら、転送中の状態を更新する（スリープ防止をオフにするため） |

### 171〜202行目：`sendFile()`（1ファイルを分割して送る）

```ts
  private async sendFile(item: FileItem, file: File): Promise<void> {
    this.send({ t: 'file', id: item.id, name: item.name, size: item.size, mime: item.mime });
    let offset = 0;
    let lastEmit = 0;
```

| 行 | 説明 |
|---|---|
| 172 | まず、ファイルの情報を送る。受信側はこれで受け取る準備をする |
| 173 | 次に送る位置（バイト） |
| 174 | 最後に進捗を画面に知らせた時刻 |

```ts
    while (offset < item.size) {
      if (this.ended || item.status !== 'sending') return;
      if (this.dc.bufferedAmount > HIGH_WATER) {
        await this.waitBufferLow();
        continue;
      }
```

| 行 | 説明 |
|---|---|
| 175 | 最後まで送るまでくり返す |
| 176 | 終了した、またはキャンセル・拒否された（状態が `sending` でなくなった）ら、途中でやめる |
| 177〜180 | **送信バッファが 4MB を超えていたら、減るまで待つ**。`continue` で、待った後にもう一度ループの先頭から調べ直す |

```ts
      const buf = await file.slice(offset, offset + this.chunkSize).arrayBuffer();
      if (this.ended || item.status !== 'sending') return;
      this.dc.send(buf);
      offset += buf.byteLength;
```

| 行 | 説明 |
|---|---|
| 181 | ファイルの `offset` から 64KB 分を切り出し、読み込む。最後の断片は 64KB より小さくなる |
| 182 | 読み込みを待っている間にキャンセルされていないか、もう一度確かめる |
| 183 | バイナリとして送る |
| 184 | 送った分だけ位置を進める |

```ts
      if (Date.now() - lastEmit > PROGRESS_INTERVAL_MS) {
        lastEmit = Date.now();
        item.transferred = Math.max(0, offset - this.dc.bufferedAmount);
        this.emit(item);
      }
    }
```

100ミリ秒以上たっていたら、進捗を画面に知らせます。

**進捗の計算**：`offset` は「送信バッファに入れた量」で、まだ相手に送り出されていない分（`bufferedAmount`）を含みます。それを引いた値を「送った量」としています。バッファにたまっている間、進捗が先走らないようにするためです。

```ts
    this.send({ t: 'end', id: item.id });
    // 相手に届くまで（送信バッファが空になるまで）進捗を更新する
    while (this.dc.bufferedAmount > 0 && !this.ended && item.status === 'sending') {
      await new Promise((r) => setTimeout(r, PROGRESS_INTERVAL_MS));
      item.transferred = Math.max(0, item.size - this.dc.bufferedAmount);
      this.emit(item);
    }
```

| 行 | 説明 |
|---|---|
| 191 | 送り終えたことを伝える |
| 193〜197 | 送信バッファが空になるまで、100ミリ秒ごとに進捗を更新する。バッファにはまだ最大4MBほど残っているので、すぐに「送信済み」にすると、実際にはまだ送っている途中になるため |

194行目の `new Promise((r) => setTimeout(r, 100))` は、「100ミリ秒待つ」ための書き方です。

```ts
    if (item.status !== 'sending') return;
    item.transferred = item.size;
    item.file = null;
    this.setStatus(item, 'sent');
  }
```

| 行 | 説明 |
|---|---|
| 198 | 待っている間にキャンセルされていたら、何もしない |
| 199 | 進捗を100% にする |
| 200 | ファイルへの参照を手放す。もう読む必要がないため |
| 201 | 送信済みにして、画面に知らせる |

### 204〜214行目：`waitBufferLow()`（送信バッファが減るのを待つ）

```ts
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
```

`bufferedamountlow` イベント（送信バッファが 1MB を下回った）が起きるか、1秒たつまで待つ Promise を返します。

| 行 | 説明 |
|---|---|
| 206〜210 | 待ち終わったときの処理：タイマーとイベントの登録を両方とも片付けて、`resolve` する |
| 211 | 1秒たったら、イベントが来なくても待ち終わる |
| 212 | イベントが起きたら待ち終わる |

**1秒で待ち終わるようにしている理由**：何かの事情でイベントが届かなかった場合に、送信が止まったままになるのを防ぐためです。待ち終わった後、`sendFile()` はもう一度バッファの残量を確かめるので、まだ多ければまた待ちます。

`removeEventListener` で登録を消さないと、待つたびに `done` が登録されたまま増えていきます。

### 216〜230行目：`cancel()`（キャンセル）

```ts
  /** 送信中・送信待ち・受信中のファイルをキャンセルする（F-46） */
  cancel(id: string): void {
    const item = this.items.get(id);
    if (item?.kind !== 'file') return;
```

IDで項目を探します。見つからない、またはテキストなら何もしません。`item?.kind` は、`item` が `undefined` なら `undefined` になるので、どちらの場合も `'file'` と一致せず、ここで終わります。この行の後では、TypeScript は `item` を `FileItem` とみなします。

```ts
    if (item.mine && (item.status === 'queued' || item.status === 'sending')) {
      if (item.status === 'sending') this.send({ t: 'cancel', id });
      item.file = null;
      this.setStatus(item, 'cancelled');
```

**自分が送っているファイル**の場合：

| 行 | 説明 |
|---|---|
| 221 | 送信中なら、相手にキャンセルを伝える。送信待ちなら、相手はまだ何も知らないので伝えない |
| 222 | ファイルへの参照を手放す |
| 223 | キャンセル済みにする。`sendFile()` のループは、次に状態を確かめたときに止まる。送信待ちなら、`pump()` が取り出したときに飛ばす |

```ts
    } else if (!item.mine && item.status === 'receiving' && this.incoming?.item === item) {
      this.send({ t: 'cancel', id });
      this.incoming = null;
      this.setStatus(item, 'cancelled');
    }
    this.updateBusy();
  }
```

**相手から受け取っているファイル**の場合：相手にキャンセルを伝え、受信中のファイルを捨てて、キャンセル済みにします。相手がキャンセルを受け取るまでの間に届いた断片は、受信中のファイルがないので捨てられます（第9回）。

---

## 4. 動かして確認

### 4-1. 同じページの中で2つの Session をつなぐ

開発サーバーでページを開き、Console で次を実行します。同じページの中に2つの接続を作って直結し、それぞれに `Session` を付けて、A から B に 20MB のファイルとテキストを送ります。シグナリングを使わず、SDP と ICE 候補を直接渡しています。

```js
const { Session } = await import('/direct-share/src/session.ts');
const pa = new RTCPeerConnection();
const pb = new RTCPeerConnection();
pa.onicecandidate = (e) => e.candidate && pb.addIceCandidate(e.candidate);
pb.onicecandidate = (e) => e.candidate && pa.addIceCandidate(e.candidate);
const da = pa.createDataChannel('direct-share', { ordered: true });
const dbP = new Promise((r) => (pb.ondatachannel = (e) => r(e.channel)));
await pa.setLocalDescription(await pa.createOffer());
await pb.setRemoteDescription(pa.localDescription);
await pb.setLocalDescription(await pb.createAnswer());
await pa.setRemoteDescription(pb.localDescription);
const db = await dbP;
await Promise.all([da, db].map((d) => d.readyState === 'open' ? 0 : new Promise((r) => (d.onopen = r))));

const mk = (name, pc, dc) => new Session(pc, dc, {
  onItem: (it) => console.log(name, it.kind === 'file'
    ? `${it.name} ${it.status} ${Math.floor(it.transferred / it.size * 100)}% バッファ=${(dc.bufferedAmount / 1048576).toFixed(1)}MB`
    : `テキスト ${it.mine ? '送信' : '受信'}：${it.body}`),
  onNotice: (m) => console.log(name, '通知：', m),
  onBusyChange: (b) => console.log(name, '転送中：', b),
  onClose: (r) => console.log(name, '終了：', r),
});
const A = mk('A', pa, da);
const B = mk('B', pb, db);

A.sendFiles([new File([new Uint8Array(20 * 1024 * 1024)], 'test20mb.bin')]);
A.sendText('こんにちは');
```

実際に動かした結果の一部：

```
A test20mb.bin queued 0% バッファ=0.0MB
A 転送中： true
A test20mb.bin sending 0% バッファ=0.0MB
A テキスト 送信：こんにちは
B test20mb.bin receiving 0% バッファ=0.0MB
B 転送中： true
B テキスト 受信：こんにちは          ← ファイルより先に届く
A test20mb.bin sending 17% バッファ=1.0MB
B test20mb.bin receiving 15% バッファ=0.0MB
…
B test20mb.bin received 100% バッファ=0.0MB
```

確かめてほしい点：

- **テキストがファイルより先に届いています。** ファイルの情報（`file`）を送った直後、最初の断片を読み込んでいる間にテキストを送ったためです。順番どおりに届くデータチャネルの上で、文字列とバイナリが混ざって流れていることが分かります。
- **A のバッファが 0〜4MB の間で上下しています。** 4MB を超えると止まり、1MB を下回ると再開しています。
- 同じ PC の中なので、20MB が4秒ほどで届きます。実際の回線では、回線の速さに応じて遅くなります。

最後に `A.close()` を実行すると、`A 終了： local`、`B 終了： peer` と表示されます。

### 4-2. キャンセルを試す

4-1 の準備をもう一度行い、大きなファイルを送ってすぐにキャンセルします。

```js
A.sendFiles([new File([new Uint8Array(80 * 1024 * 1024)], 'big.bin')]);
setTimeout(() => A.cancel([...A.items.keys()][0]), 500);
```

A が `cancelled` になり、少し遅れて B も `cancelled` になり、「相手が「big.bin」の送信をキャンセルしました」と通知されることを確かめてください。

---

## 5. 理解チェック

1. ファイルを 64KB ずつ分割して送るのはなぜですか。
2. 送信バッファの残量を見ずに、ファイルの断片を全部 `send()` すると、どうなりますか。
3. 高い水位（4MB）と低い水位（1MB）の2つを使うのはなぜですか。
4. ファイルの断片（バイナリ）にファイルのIDを付けなくてよいのはなぜですか。
5. `pump()` の最初で `if (this.sending) return;` としているのは、何のためですか。
6. `sendFile()` で、`end` を送った後すぐに「送信済み」にしないのはなぜですか。
7. 10万文字のテキストは、いくつに分割されて送られますか。
8. 送信待ちのファイルをキャンセルしたとき、相手に `cancel` を送らないのはなぜですか。

<details>
<summary>答え</summary>

1. データチャネルには1回に送れる大きさの上限（多くのブラウザで 256KB）があるため。また、ファイル全体を一度に読み込まずに済むので、メモリを大きく使わない。
2. ファイルの読み込みは回線より速いので、送信バッファに大量のデータがたまり、メモリを圧迫する。バッファが上限（Chrome では 16MB）を超えると、`send()` が例外を投げて送信できなくなる。
3. 1つの境目だけだと、境目のあたりで止める・再開するを細かくくり返してしまうため。差を設けると、ある程度まとめて送り出してから再開できる。
4. データチャネルは順番どおりに届き、ファイルは1つずつ順に送るので、届いたバイナリは「直前の `file` メッセージのファイルの続き」だと分かるため。
5. 同時に送るファイルを1つに限るため。すでに送信中なら、その `pump()` が送信待ちの列から次のファイルを取り出して送ってくれる。
6. `end` を送った時点では、送信バッファにまだ最大4MB ほどのデータが残っていて、相手に届いていないため。バッファが空になるまで待ってから「送信済み」にする。
7. 7つ。100,000 ÷ 16,000 = 6.25 を切り上げて 7。
8. 送信待ちのファイルについては、まだ `file` メッセージを送っておらず、相手は何も知らないため。

</details>

---

次回（第9回）は `session.ts` の後半を読みます。受信側の処理と、受信したファイルのメモリの管理、切断の処理です。
