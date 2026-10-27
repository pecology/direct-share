# 第9回 `src/session.ts` 後半：受信、メモリの管理、終了

第8回に続いて `session.ts` の232〜453行目を読みます。

- **受信**：届いた JSON のメッセージとファイルの断片を処理する
- **メモリの管理**：受信したファイルをメモリに持ちすぎないようにする（要件 F-51）
- **終了**：切断したときに後始末をし、履歴を破棄する（要件 F-64）

---

## 1. 前提知識

### 1-1. 受信側の状態の移り変わり

受信側でファイル1つを受け取る流れです。

```
{t:'file'} が届く
   │
   ├─ 100MB を超える ─────────────→ rejected（reject を返す）
   ├─ メモリの空きが足りない ─────→ rejected（reject を返す）
   │
   ▼
receiving（受信中。incoming に記録し、断片をためる）
   │
   ├─ 相手から {t:'cancel'} ─────→ cancelled
   ├─ 自分でキャンセル ───────────→ cancelled（cancel を返す）
   ├─ 予定より多く届いた ─────────→ failed
   │
   ▼ {t:'end'} が届く
   │
   ├─ 届いた量が予定と違う ───────→ failed
   ▼
received（受信済み。Blob ができ、保存できる）
   │
   ▼ 「破棄」または自動解放
released（破棄済み。メモリから消えた）
```

### 1-2. 受信ファイルのメモリ

受信したファイルは、ブラウザのメモリに置いておきます（ディスクには自動で保存しません。要件 2章「データ保存」）。スマホではメモリが少ないので、たくさん受け取るとページが落ちるおそれがあります（要件 R-07）。そこで、次のルールで管理します（要件 F-51）。

1. メモリに持っておく受信ファイルの合計は、**100MB まで**
2. 新しいファイルを受け取ると 100MB を超える場合、**保存済みのファイルを古い順に**メモリから解放する
3. それでも足りなければ、受信を**拒否**し、両方の端末に「受信側の空きが足りない。保存または破棄が必要」と知らせる

「保存済み」とは、「保存」ボタンで端末にダウンロード済みのものです。まだ保存していないファイルは、勝手に消すと取り戻せないので、自動では解放しません。

### 1-3. `switch` と判別可能なユニオン型

`Wire` 型（第8回）は、`t` の値でどの形かが決まります。`switch (msg.t)` で分岐すると、各 `case` の中で TypeScript が `msg` の型を絞り込みます。

```ts
switch (msg.t) {
  case 'text':
    msg.part;    // OK：ここでは msg は { t: 'text'; id; part; total; body }
    break;
  case 'bye':
    msg.part;    // エラー：bye には part がない
    break;
}
```

### 1-4. このファイルで新しく出てくる TypeScript の書き方

| 書き方 | 意味 |
|---|---|
| `Extract<Wire, { t: 'file' }>` | `Wire` のユニオンのうち、`{ t: 'file' }` に当てはまる形だけを取り出した型 |
| `JSON.parse(data) as Wire` | 解析した結果を `Wire` 型とみなす（中身の確認はしない） |
| `x ?? 既定値` | `x` が `null` か `undefined` なら既定値（第1回） |

---

## 2. この回で読む部分

| 名前 | 役割 |
|---|---|
| `handleJson()` | 届いた JSON のメッセージを、種類ごとに処理する |
| `receiveFile()` | ファイルの受信を始める（または拒否する） |
| `handleChunk()` | 届いたファイルの断片をためる |
| `ensureSpace()` | メモリの空きを作る（保存済みを解放する） |
| `heldBytes()` | 今メモリに持っている受信ファイルの合計 |
| `markSaved()` | 保存済みの印を付ける |
| `release()` | 受信ファイルをメモリから解放する |
| `close()` | 自分から切断する |
| `end()` | 終了の後始末 |
| `send()` | JSON のメッセージを送る |
| `add()`、`setStatus()`、`emit()` | 履歴を更新して画面に知らせる |
| `updateBusy()` | 転送中かどうかを更新する |

---

## 3. 1行ずつの解説

### 234〜240行目：`handleJson()` の始まり

```ts
  private handleJson(data: string): void {
    let msg: Wire;
    try {
      msg = JSON.parse(data) as Wire;
    } catch {
      return;
    }
```

届いた文字列を JSON として解析します。解析できなければ無視します。

`as Wire` は、「中身は `Wire` のどれかの形のはず」とみなすだけで、実際に確かめてはいません。相手は同じアプリなので、形が崩れていることは普通ありません。念のため、ファイルの情報（`receiveFile()`）では、数値や文字列に変換し直しています。

### 241〜252行目：テキストの受信

```ts
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
```

| 行 | 説明 |
|---|---|
| 243 | このテキストの、これまでに届いた部分を取り出す。初めてなら空の配列 |
| 244 | 届いた部分を、番号（`part`）の位置に入れる |
| 245〜248 | まだ全部そろっていなければ、記録して待つ |
| 249 | そろったので、記録を消す |
| 250 | 部分をつなげて1つのテキストにし、履歴に追加する。時刻は受け取った時刻（相手の端末の時計がずれていても困らないように） |

ほとんどのテキストは分割されない（`total` が 1）ので、245行目の条件はすぐに満たされ、そのまま履歴に追加されます。

番号の位置に入れているので、仮に順番が入れ替わって届いても正しくつながります（実際にはデータチャネルが順番どおりに届けるので、入れ替わりは起きません）。

### 253〜255行目：ファイルの情報

```ts
      case 'file':
        this.receiveFile(msg);
        return;
```

`receiveFile()`（303行目）に任せます。

### 256〜270行目：ファイルの終わり

```ts
      case 'end': {
        const inc = this.incoming;
        if (!inc || inc.item.id !== msg.id) return;
        this.incoming = null;
```

| 行 | 説明 |
|---|---|
| 257 | 受信中のファイル |
| 258 | 受信中のファイルがない、または別のファイルの `end` なら無視する。自分がキャンセルした後に、相手がそれを知らずに送ってきた `end` などがこれにあたる |
| 259 | 受信中のファイルなしにする |

```ts
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
```

| 行 | 説明 |
|---|---|
| 260 | 届いた断片の合計バイト数を計算する |
| 261〜262 | 予定のサイズと違えば、失敗にする |
| 264 | 断片をつなげて、1つの `Blob` にする。ファイルの種類が分からなければ、「何かのバイナリ」を表す `application/octet-stream` にする |
| 265〜266 | 進捗を100% にして、受信済みにする |
| 268 | 転送中の状態を更新する |

**メモリについての注意**（要件 R-07）：264行目で `Blob` を作るとき、ブラウザの実装によっては、断片の配列と `Blob` の両方が一時的にメモリにあることになり、ファイルサイズの約2倍のメモリを使います。`inc` はこの関数を抜けると使われなくなるので、断片の配列はその後に片付けられます。

### 271〜285行目：キャンセル

```ts
      case 'cancel': {
        const item = this.items.get(msg.id);
        if (item?.kind !== 'file') return;
        if (item.mine && (item.status === 'sending' || item.status === 'queued')) {
          item.file = null;
          this.setStatus(item, 'cancelled');
          this.events.onNotice(`相手が「${item.name}」の受信をキャンセルしました`);
```

**自分が送っているファイル**を、相手（受信側）がキャンセルした場合です。状態を `cancelled` にすると、`sendFile()` のループが止まります（第8回）。

```ts
        } else if (!item.mine && this.incoming?.item === item) {
          this.incoming = null;
          this.setStatus(item, 'cancelled');
          this.events.onNotice(`相手が「${item.name}」の送信をキャンセルしました`);
        }
        this.updateBusy();
        return;
      }
```

**相手から受け取っているファイル**を、相手（送信側）がキャンセルした場合です。受信中のファイルを捨てて、キャンセル済みにします。

どちらの場合も、すでに終わったファイル（送信済み、受信済みなど）へのキャンセルは無視します。両方が同時にキャンセルボタンを押した場合などに起こりえます。

### 286〜296行目：受信の拒否

```ts
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
```

自分が送ったファイルを、相手が受け取れなかった場合です。状態を `rejected` にして送信を止め、理由に応じたメッセージを表示します。メモリ不足なら、受信側と同じ「受信側の空きが足りません…」を表示します（要件 F-51：両端末に通知）。

### 297〜301行目：切断

```ts
      case 'bye':
        this.end('peer');
        return;
    }
  }
```

相手が切断ボタンを押した（またはページを閉じた）ので、終了します。

### 303〜336行目：`receiveFile()`（ファイルの受信を始める）

```ts
  private receiveFile(msg: Extract<Wire, { t: 'file' }>): void {
    if (this.incoming) {
      this.setStatus(this.incoming.item, 'failed');
      this.incoming = null;
    }
```

前のファイルを受信中なのに次のファイルの情報が届いたら、前のファイルは失敗にします。正しく動いていれば起きないこと（前のファイルの `end` が必ず先に届く）ですが、念のための処理です。

```ts
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
```

履歴の項目を作ります。`String()` と `Number()` で、届いた値を文字列と数値に変換し直しています。型の上では文字列と数値のはずですが、JSON の中身は確かめていないので、ここで形をそろえています。

```ts
    let reject: RejectReason | null = null;
    if (!(item.size >= 0) || item.size > MAX_FILE_SIZE) reject = 'toolarge';
    else if (!this.ensureSpace(item.size)) reject = 'nospace';
```

受け取れるかを判定します。

| 条件 | 理由 |
|---|---|
| `!(item.size >= 0)` | サイズが負、または数でない（`NaN`）。`NaN >= 0` は `false` なので、`!(…)` で `true` になる。`item.size < 0` と書くと `NaN` を見逃してしまう |
| `item.size > MAX_FILE_SIZE` | 100MB を超える（送信側でも確かめているが、受信側でも確かめる） |
| `!this.ensureSpace(item.size)` | メモリの空きを作れなかった |

```ts
    if (reject) {
      item.status = 'rejected';
      this.add(item);
      this.send({ t: 'reject', id: item.id, reason: reject });
      this.events.onNotice(reject === 'nospace' ? NO_SPACE_MESSAGE : `「${item.name}」は100MBを超えるため受信できません`);
      return;
    }
```

受け取れない場合は、「受信できませんでした」の項目を履歴に追加し、送信側に拒否を伝え、通知します。`incoming` には記録しないので、この後に届く断片は捨てられます（`handleChunk()`）。

```ts
    this.incoming = { item, chunks: [] };
    this.add(item);
    this.updateBusy();
  }
```

受け取れる場合は、受信中のファイルとして記録し、履歴に追加して、転送中の状態を更新します。

### 338〜355行目：`handleChunk()`（断片をためる）

```ts
  private lastProgress = 0;
```

最後に進捗を画面に知らせた時刻です。プロパティは普通クラスの先頭にまとめますが、ここではこの関数でしか使わないので、すぐ上に置いています。

```ts
  private handleChunk(buf: ArrayBuffer): void {
    const inc = this.incoming;
    if (!inc) return; // キャンセル・拒否したファイルの残り
    inc.chunks.push(buf);
    inc.item.transferred += buf.byteLength;
```

| 行 | 説明 |
|---|---|
| 342 | 受信中のファイルがなければ捨てる。キャンセルや拒否をした後、送信側がそれを知るまでの間に届く断片がこれにあたる |
| 343 | 断片をためる |
| 344 | 受け取った量を増やす |

```ts
    if (inc.item.transferred > inc.item.size) {
      this.incoming = null;
      this.setStatus(inc.item, 'failed');
      this.updateBusy();
      return;
    }
```

予定のサイズより多く届いたら、何かがおかしいので失敗にします。予定外のデータでメモリを使いすぎないための安全策でもあります。

```ts
    if (Date.now() - this.lastProgress > PROGRESS_INTERVAL_MS) {
      this.lastProgress = Date.now();
      this.emit(inc.item);
    }
  }
```

100ミリ秒以上たっていたら、進捗を画面に知らせます。

### 357〜376行目：メモリの管理

```ts
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
```

| 行 | 説明 |
|---|---|
| 359 | 今メモリに持っている量 |
| 360 | 履歴を古い順に見ていく。`Map` は追加した順に取り出せるので、そのまま古い順になる |
| 361 | 新しいファイルが収まるようになったら、そこでやめる |
| 362〜365 | 受信済みで、保存済みのファイルなら、メモリから解放し、持っている量を減らす |
| 367 | 収まるなら `true`、それでも足りなければ `false` |

**具体例**：100MB の上限に対して、60MB のファイル（保存済み）を持っている状態で、さらに 60MB のファイルが届いた場合。

```
持っている量 60MB + 新しい 60MB = 120MB > 100MB
  → 60MB のファイル（保存済み）を解放 → 0MB + 60MB = 60MB ≤ 100MB → 受け取れる
```

同じ状況で、持っている 60MB のファイルが**まだ保存されていなければ**、解放できないので受信を拒否します。

**気づいた点**：解放しても足りずに拒否する場合でも、途中で解放した保存済みのファイルは、解放されたままになります。

```
持っている量：保存済み 10MB + 未保存 80MB = 90MB
30MB のファイルが届く：90 + 30 = 120MB > 100MB
  → 保存済みの 10MB を解放：80 + 30 = 110MB > 100MB → まだ足りないので拒否
  → 結果：受け取れなかったうえに、10MB のファイルも解放されている
```

解放されるのは保存済みのファイルだけで、端末には保存してあるので、困ることはほとんどありません。要件 F-51 の「保存済みを古い順に解放する。それでも超える場合は拒否」を、そのまま実装した形です。足りるかどうかを先に計算してから解放するようにすれば、この解放され損はなくせます。

```ts
  heldBytes(): number {
    let held = this.incoming?.item.size ?? 0;
    for (const item of this.items.values()) {
      if (item.kind === 'file' && item.blob) held += item.size;
    }
    return held;
  }
```

今メモリに持っている受信ファイルの合計です。

| 行 | 説明 |
|---|---|
| 371 | 受信中のファイルがあれば、その（予定の）サイズを含める。受け取り終わればその分のメモリを使うため |
| 372〜374 | `blob` を持っている（受信済みで、まだ解放していない）ファイルのサイズを足す |

`private` を付けていないので、外からも呼べます。テストで「キャンセルしたらメモリが空になること」を確かめるのに使っています。

### 378〜391行目：保存済みの印と解放

```ts
  markSaved(id: string): void {
    const item = this.items.get(id);
    if (item?.kind !== 'file' || item.saved) return;
    item.saved = true;
    this.emit(item);
  }
```

「保存」ボタンで保存したときに、画面（`main.ts`）から呼ばれます。保存済みの印を付け、画面に「保存済み」と表示させます。

```ts
  /** 受信ファイルをメモリから解放する */
  release(id: string): void {
    const item = this.items.get(id);
    if (item?.kind !== 'file' || item.status !== 'received') return;
    item.blob = null;
    this.setStatus(item, 'released');
  }
```

受信済みのファイルの `blob` を `null` にして、破棄済みにします。`blob` への参照がなくなれば、ブラウザがそのメモリを回収できます（ガベージコレクション）。「破棄」ボタンと、`ensureSpace()` の自動解放の両方から呼ばれます。

### 395〜422行目：終了

```ts
  close(): void {
    if (this.ended) return;
    this.send({ t: 'bye' });
    this.end('local');
  }
```

自分から切断するときに呼びます（切断ボタン、ページを閉じるとき）。相手に `bye` を送ってから、終了します。

```ts
  private end(reason: CloseReason): void {
    if (this.ended) return;
    this.ended = true;
```

2回目以降は何もしません。終了のきっかけは複数あり（`bye` の受信、データチャネルの切断、接続の失敗）、たいてい続けて起きるためです。

```ts
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
```

送信待ち、受信中のファイル、受信したファイルの中身、履歴をすべて捨てます（要件 F-64）。画面側（`main.ts`）が項目への参照を持っていても中身が残らないよう、`blob` と `file` を明示的に `null` にしています。

```ts
    try {
      this.dc.close();
    } catch {
      // 既に閉じている
    }
    this.pc.close();
    this.updateBusy();
    this.events.onClose(reason);
  }
```

| 行 | 説明 |
|---|---|
| 414〜418 | データチャネルを閉じる。すでに閉じていても大丈夫なように `try` で囲んでいる |
| 419 | 接続を閉じる |
| 420 | 転送中の状態を更新する（終了したので「転送中でない」になり、スリープ防止がオフになる） |
| 421 | 画面に、終了したことと理由を知らせる |

自分から `close()` した場合、415行目で自分のデータチャネルを閉じると、104行目の `dc.onclose` から `end('peer')` が呼ばれますが、402行目で止まります。理由は最初の `'local'` のままです。

### 424〜431行目：`send()`

```ts
  private send(msg: Wire): void {
    if (this.ended || this.dc.readyState !== 'open') return;
    try {
      this.dc.send(JSON.stringify(msg));
    } catch {
      this.end('peer');
    }
  }
```

JSON のメッセージを送ります。終了した後や、データチャネルが開いていなければ送りません。送るときに例外が起きたら（データチャネルが壊れているなど）、相手との通信が切れたとみなして終了します。

引数の型が `Wire` なので、このアプリのやり取りの形式に合わないメッセージを送ろうとすると、型エラーになります。

### 433〜452行目：小道具

```ts
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
```

| 関数 | 役割 |
|---|---|
| `add` | 履歴に追加して、画面に知らせる |
| `setStatus` | ファイルの状態を変えて、画面に知らせる |
| `emit` | 画面に知らせる。終了した後は知らせない |

```ts
  private updateBusy(): void {
    const busy = !this.ended && (this.sending !== null || this.incoming !== null || this.queue.length > 0);
    if (busy === this.busy) return;
    this.busy = busy;
    this.events.onBusyChange(busy);
  }
}
```

ファイルを送信中、受信中、または送信待ちがあれば「転送中」です。前回から**変わったときだけ**画面に知らせます。画面側は、転送中ならスリープ防止をオンにします（要件 U-06）。

---

## 4. 動かして確認

### 4-1. テストを読む

`test/session.test.ts` は、このファイルのテストです。本物のデータチャネルの代わりに、偽物（`FakeChannel`）を使って、2つの `Session` を直結しています（偽物の作りは第12回で読みます）。

| テスト | 確かめていること |
|---|---|
| 長いテキストも分割して届く | 10万文字の日本語が分割されて届き、元通りになる。10万1文字はエラーになる |
| ファイルが分割送信され、同じ内容で受信される | 300KB のファイルと空のファイルが、同じ中身・同じ種類で届く |
| 送信中のファイルをキャンセルすると両側で止まる | 50MB の送信中にキャンセルすると、両側が `cancelled` になり、受信側のメモリが 0 になる |
| 受信側の空きが足りなければ… | 60MB を受信（未保存）→ 次の 60MB は拒否され両側に通知 → 保存済みにすると、次の 60MB で古い方が自動解放される |
| 100MBを超えるファイルは送信前に拒否する | 送信側で通知され、履歴に追加されない |
| 切断すると相手に通知され、履歴が破棄される | `close()` で、両側の終了の理由が正しく、履歴が空になる |

```bash
npm test
```

### 4-2. メモリの管理をブラウザで試す

第8回 4-1 の準備（2つの `Session` を直結する）を行ってから、次を順に実行します。

```js
const big = (name) => new File([new Uint8Array(60 * 1024 * 1024)], name);
A.sendFiles([big('1.bin')]);
// B に 1.bin が received で届くまで待ってから
A.sendFiles([big('2.bin')]);
// → B 通知： 受信側の空きが足りません…、A 通知： 同じ。2.bin は rejected
B.markSaved([...B.items.values()].find((i) => i.name === '1.bin').id);
A.sendFiles([big('3.bin')]);
// → 1.bin が released になり、3.bin が received で届く
B.heldBytes() / 1024 / 1024
// → 60（3.bin の分だけ）
```

---

## 5. 理解チェック

1. 受信中のファイルがないときに届いたファイルの断片は、どう扱われますか。それはどんな場合に起こりますか。
2. `receiveFile()` で、`item.size < 0` ではなく `!(item.size >= 0)` と書いているのはなぜですか。
3. メモリが足りないとき、まだ保存していない受信ファイルを自動で解放しないのはなぜですか。
4. `ensureSpace()` で、ファイルを「古い順」に調べられるのはなぜですか。
5. `end` が届いたとき、受信した合計と予定のサイズを比べているのは何のためですか。
6. 切断ボタンを押したとき、自分と相手の `onClose` には、それぞれどんな理由が渡されますか。
7. `end()` の中で、`items.clear()` の前に `blob` と `file` を `null` にしているのはなぜですか。
8. `updateBusy()` が、状態が変わったときだけ `onBusyChange` を呼ぶのはなぜですか。

<details>
<summary>答え</summary>

1. 捨てられる。自分がキャンセルや拒否をした後、送信側がそれを知るまでの間に届いた断片がこれにあたる。
2. `size` が数でない（`NaN`）場合を拒否するため。`NaN < 0` は `false` なので見逃してしまうが、`NaN >= 0` も `false` なので、`!(…)` なら `true` になって拒否できる。
3. 保存していないファイルを解放すると、内容を取り戻す方法がなくなるため。保存済みなら、端末に保存した分があるので解放してよい。
4. `items` は `Map` で、`Map` は追加した順番を覚えていて、`values()` でその順に取り出せるため。
5. 途中で断片が失われたり、余計なデータが混ざったりしていないかを確かめるため。合わなければ、壊れたファイルを「受信済み」にせず、失敗にする。
6. 自分は `'local'`、相手は `'peer'`。自分は `close()` から `end('local')` が呼ばれ、相手は `bye` を受け取って `end('peer')` が呼ばれる。
7. 画面側などが項目への参照を持ち続けていても、ファイルの中身（大きなメモリ）が残らないようにするため。`items.clear()` は Map から項目を外すだけで、項目そのものへの他の参照は消えない。
8. 画面側は、転送中になったらスリープ防止をオンにし、終わったらオフにする。変わっていないのに何度も知らせると、そのたびに無駄な処理が走るため。

</details>

---

次回（第10回）は `src/main.ts` を読みます。ここまでの部品をすべて組み合わせて、画面を動かしている部分です。
