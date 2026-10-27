# 第4回 `src/crypto.ts`：鍵とトピック名の導出、暗号化

このファイルは、シグナリング（MQTT で接続情報を交換する部分）の安全性を支える部品です（要件 S-01、S-02、S-10）。

- **秘密値やIDを乱数で作る**
- **秘密値から、MQTT のトピック名と暗号鍵を作る**（ホストとゲストが同じ計算をして、同じものを得る）
- **シグナリングのメッセージを暗号化・復号する**（改ざんも検知する）

暗号の処理はすべて、ブラウザ標準の **Web Crypto API**（`crypto.subtle`）に任せています。暗号のアルゴリズムを自分で実装することはしていません。

---

## 1. 前提知識

### 1-1. 非同期処理：`Promise` と `async` / `await`

Web Crypto API の関数は、結果をすぐには返しません。代わりに **`Promise`**（「あとで結果を渡す」という約束）を返します。暗号の計算はブラウザの内部で、ページの処理を止めずに行われるためです。

```ts
const p = crypto.subtle.digest('SHA-256', data);  // p は Promise。まだ結果は入っていない
```

結果を受け取るには、`await` を使います。

```ts
const result = await crypto.subtle.digest('SHA-256', data);  // 結果が出るまで、この関数の処理を待つ
```

| 書き方 | 意味 |
|---|---|
| `await 式` | Promise の結果が出るまで待って、結果を取り出す。待っている間、**ページの他の処理（画面の操作など）は止まらない** |
| `async function f()` | 中で `await` を使える関数。この関数自体も Promise を返す |
| `Promise<Room>` | 「あとで `Room` 型の値を渡す Promise」という型 |

`async` 関数の戻り値の型は、必ず `Promise<…>` になります。`deriveRoom()` は `Room` を返しますが、型は `Promise<Room>` で、呼ぶ側も `await deriveRoom(…)` で結果を受け取ります。

`await` している途中で例外が起きた場合は、普通の処理と同じように `try` / `catch` で受け止められます。

### 1-2. 暗号の基本用語

| 用語 | 意味 | このファイルでの使い道 |
|---|---|---|
| **ハッシュ関数**（SHA-256） | 任意のデータから、決まった長さ（256ビット）の値を作る。同じ入力なら必ず同じ値になり、値から元の入力を逆算できない | 秘密値からトピック名を作る |
| **鍵導出関数**（HKDF） | 元になる秘密から、用途に合った鍵を作る。用途ごとにラベル（`info`）を変えると、まったく別の鍵になる | 秘密値から AES の鍵を作る |
| **共通鍵暗号**（AES） | 同じ鍵で暗号化と復号を行う | メッセージの暗号化 |
| **認証付き暗号**（AES-GCM） | 暗号化に加えて、改ざんされていないかも確かめられる方式。暗号文の末尾に「認証タグ」（16バイト）を付ける | 同上 |
| **IV**（初期化ベクトル） | 暗号化のたびに変える値。同じ鍵・同じ文でも、IV が違えば暗号文が変わる。秘密である必要はない | 暗号文の先頭に付けて送る |
| **AAD**（追加認証データ） | 暗号化はしないが、改ざんされていないことを一緒に確かめるデータ | トピック名を指定し、別のトピックへの流用を防ぐ |

### 1-3. バイト列の型

| 型 | 意味 |
|---|---|
| `ArrayBuffer` | メモリ上のバイトの並びそのもの。直接は読み書きできない |
| `Uint8Array` | `ArrayBuffer` を「0〜255 の数の配列」として読み書きするための窓 |
| `Uint8Array<ArrayBuffer>` | 「中身が普通の `ArrayBuffer` である `Uint8Array`」 |

最近の TypeScript では、`Uint8Array` の中身が普通の `ArrayBuffer` か、複数のスレッドで共有する特殊な `SharedArrayBuffer` かを型で区別します。Web Crypto API は普通の `ArrayBuffer` しか受け付けないので、暗号の関数に渡すバイト列には `<ArrayBuffer>` を付けています。付けないと、「共有メモリかもしれないものは渡せない」という型エラーになります。

### 1-4. 文字列とバイト列の変換

暗号はバイト列を扱うので、文字列を変換する必要があります。

| 道具 | 変換 |
|---|---|
| `new TextEncoder().encode('あ')` | 文字列 → UTF-8 のバイト列（`Uint8Array [227, 129, 130]`） |
| `new TextDecoder().decode(bytes)` | UTF-8 のバイト列 → 文字列 |

### 1-5. このファイルで新しく出てくる TypeScript の書き方

| 書き方 | 意味 |
|---|---|
| `interface Room { topic: string; key: CryptoKey }` | オブジェクトの形に名前を付ける。`type Room = { … }` とほぼ同じ |
| `function f(bytes = 8)` | 引数の既定値。省略されたら 8 を使う。型は既定値から `number` と推測される |
| `function f(...parts: Uint8Array[])` | 残余引数。いくつでも引数を受け取り、配列 `parts` にまとめる |
| `値 as 型` | 型アサーション。「この値はこの型だ」と TypeScript に伝える。チェックはしないので、確認した後でだけ使う |
| `object` | `null` 以外の、何らかのオブジェクト |

---

## 2. ファイルの全体像

| 名前 | 役割 | 使っている場所 |
|---|---|---|
| `SECRET_BYTES` | 秘密値のバイト数（10） | このファイル |
| `Room` | トピック名と暗号鍵の組 | `signaling.ts` |
| `randomSecret()` | 80ビットの秘密値を作る | `main.ts`（待機画面を開くたび）、テスト |
| `randomId()` | ランダムなIDを16進数の文字列で作る | `main.ts`、`signaling.ts`、`connection.ts`、`session.ts` |
| `toHex()`、`concat()` | バイト列の小道具 | このファイルの中だけ |
| `deriveRoom()` | 秘密値 → トピック名と暗号鍵 | `connection.ts` |
| `encryptMessage()` | メッセージを暗号化 | `signaling.ts` |
| `decryptMessage()` | 暗号文を復号 | `signaling.ts` |

秘密値から作られるものの関係は次のとおりです。

```
秘密値（10バイト）
  ├─ SHA-256("direct-share/topic/v1:" ‖ 秘密値) の先頭16バイト ──→ トピック名 direct-share/9bab16e3…
  └─ HKDF-SHA256（salt と info を指定） ─────────────────────→ AES-256-GCM の鍵（取り出し不可）
```

`‖` は「バイト列をつなげる」という意味です。

---

## 3. 1行ずつの解説

### 1〜10行目：準備と型

```ts
// シグナリング用の暗号（S-01, S-02, S-10）
const enc = new TextEncoder();
const dec = new TextDecoder();

export const SECRET_BYTES = 10; // 80ビット

export interface Room {
  topic: string;
  key: CryptoKey;
}
```

| 行 | 説明 |
|---|---|
| 2〜3 | 文字列とバイト列の変換器を、ファイルの最初に1つずつ作っておき、使い回す |
| 5 | 秘密値の長さ。10バイト × 8 = 80ビット（要件 S-01） |
| 7〜10 | `Room` 型。MQTT の「部屋」にあたるもので、トピック名（`topic`）と暗号鍵（`key`）を持つ。`CryptoKey` は Web Crypto API の鍵の型で、鍵のバイト列そのものではなく、ブラウザが管理している鍵への「参照」 |

### 12〜22行目：乱数

```ts
export function randomSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}
```

10バイトの空のバイト列を作り、`crypto.getRandomValues` で暗号に使える品質の乱数を詰めて返します。

`Math.random()` も乱数を返しますが、**暗号には使えません**。予測できてしまう可能性があるためです。`crypto.getRandomValues` は、OS が用意する予測不可能な乱数を使います。

```ts
export function randomId(bytes = 8): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
```

ランダムなIDを、16進数の文字列で返します。既定は8バイト（16文字、例：`fd0821021d9abef3`）です。`randomId(4)` なら4バイト（8文字）です。

このIDはあちこちで使われます。

| 使い道 | 長さ |
|---|---|
| 自分の端末のID（シグナリングの送信者ID） | 8バイト |
| MQTT のクライアントID（`ds-` + 6バイト） | 6バイト |
| 接続の試行ID（`attempt`） | 4バイト |
| テキストやファイルのID | 8バイト |

```ts
function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

バイト列を16進数の文字列にします。`[0x0a, 0xff]` を例にします。

| 部分 | 結果 |
|---|---|
| `[...bytes]` | 普通の配列にする：`[10, 255]` |
| `b.toString(16)` | 16進数の文字列にする：`'a'`、`'ff'` |
| `.padStart(2, '0')` | 2文字に満たなければ、左を `0` で埋める：`'0a'`、`'ff'` |
| `.join('')` | つなげる：`'0aff'` |

`padStart` がないと、`0x0a` が `'a'` の1文字になってしまい、桁がずれます。

### 24〜32行目：`concat()`（バイト列をつなげる）

```ts
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
```

| 行 | 説明 |
|---|---|
| 24 | いくつでもバイト列を受け取れる。`concat(a, b)` と呼ぶと、`parts` は `[a, b]` になる |
| 25 | まず全体の長さを計算して、その長さの空のバイト列を作る。`reduce` は配列を1つの値にまとめる関数で、`n` に途中の合計、`p` に各要素が入る。0 から始めて、各バイト列の長さを足していく |
| 26 | 書き込む位置 |
| 27〜30 | 各バイト列を、`out` の `offset` の位置にコピーし、その長さだけ位置を進める |
| 31 | つなげたバイト列を返す |

`Uint8Array` は一度作ると長さを変えられないので、普通の配列の `push` のようには継ぎ足せません。そのため、先に全体の長さを計算しています。

### 34〜50行目：`deriveRoom()`（トピック名と鍵を作る）

```ts
/** 秘密値からトピック名（SHA-256）と暗号鍵（HKDF → AES-GCM）を導出する */
export async function deriveRoom(secret: Uint8Array<ArrayBuffer>): Promise<Room> {
```

`async` 関数なので、中で `await` を使え、戻り値は `Promise<Room>` です。

#### トピック名（36〜39行目）

```ts
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', concat(enc.encode('direct-share/topic/v1:'), secret)),
  );
  const topic = `direct-share/${toHex(digest.slice(0, 16))}`;
```

内側から順に読みます。

| 順番 | 部分 | 結果 |
|---|---|---|
| 1 | `enc.encode('direct-share/topic/v1:')` | 文字列をバイト列にする |
| 2 | `concat(…, secret)` | その後ろに秘密値をつなげる |
| 3 | `crypto.subtle.digest('SHA-256', …)` | SHA-256 のハッシュ値（32バイト）を計算する。結果は `ArrayBuffer` |
| 4 | `await` | 計算が終わるのを待つ |
| 5 | `new Uint8Array(…)` | `ArrayBuffer` を読み書きできる形にする |
| 6 | `digest.slice(0, 16)` | 先頭16バイト（128ビット）だけを使う |
| 7 | `` `direct-share/${toHex(…)}` `` | 16進数32文字にして、`direct-share/` の後に付ける |

秘密値 `3a 7f 00 c5 91 2b e4 08 6d f0` からは、トピック名 `direct-share/9bab16e38ab5d24b963ce1d002bd9797` ができます。

**秘密値の前に `'direct-share/topic/v1:'` を付けている理由**：同じ秘密値から作る別のもの（暗号鍵など）と、計算の入力が絶対に同じにならないようにするためです。これを「ドメイン分離」と呼びます。`v1` は、将来作り方を変えたときに区別するための版番号です。

**トピック名から秘密値を逆算できないこと**（要件 S-10）：SHA-256 は一方向の関数なので、トピック名から秘密値を求めるには、秘密値の候補 2⁸⁰ 通りを1つずつ試すしかありません。現実的な時間では終わりません。

#### 暗号鍵（41〜48行目）

```ts
  const ikm = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
```

秘密値のバイト列を、Web Crypto API の「鍵」として取り込みます。`ikm` は Input Keying Material（鍵の材料）の略です。

| 引数 | 意味 |
|---|---|
| `'raw'` | バイト列をそのまま鍵として扱う |
| `secret` | 鍵の材料（秘密値） |
| `'HKDF'` | この鍵は HKDF の材料として使う |
| `false` | 取り込んだ鍵を、あとで取り出せない（extractable でない）ようにする |
| `['deriveKey']` | この鍵でできることは、別の鍵を導出することだけ |

```ts
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('direct-share/v1'), info: enc.encode('signaling-key') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
```

HKDF で、材料から AES の鍵を作ります。

| 引数 | 意味 |
|---|---|
| 1つ目 | 導出の方法。HKDF を SHA-256 で行う。`salt` と `info` は、用途を区別するためのラベル。`info` を `'signaling-key'` 以外にすれば、同じ秘密値からまったく別の鍵ができる |
| 2つ目 | 材料（41行目の `ikm`） |
| 3つ目 | 作る鍵の種類。AES-GCM の 256ビットの鍵 |
| 4つ目 | `false`：鍵を取り出せないようにする |
| 5つ目 | この鍵でできること：暗号化と復号 |

**秘密値（80ビット）から、なぜ 256ビットの鍵を作れるのか**：HKDF は、短い材料から必要な長さの鍵を作れます。ただし、**強さが増えるわけではありません**。元の秘密値が80ビットなら、攻撃者が総当たりで試す数は 2⁸⁰ 通りのままです。256ビットになるのは、AES の鍵の長さに合わせるためです。

**取り出し不可（`false`）の意味**：鍵は `CryptoKey` という参照としてだけ使え、`crypto.subtle.exportKey` でバイト列を取り出そうとしても拒否されます。万が一ページに悪意のあるコードが入り込んでも、鍵そのものを外に持ち出されにくくなります。

```ts
  return { topic, key };
}
```

トピック名と鍵を `Room` として返します。

### 52〜60行目：`encryptMessage()`（暗号化）

```ts
export async function encryptMessage(room: Room, obj: object): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
```

暗号化のたびに、12バイトのランダムな IV を作ります。AES-GCM では、**同じ鍵で同じ IV を2回使うと、安全性が大きく崩れます**。毎回乱数で作れば、ぶつかる確率は無視できるほど小さくなります。

```ts
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(room.topic) },
    room.key,
    enc.encode(JSON.stringify(obj)),
  );
```

| 引数 | 意味 |
|---|---|
| 1つ目 | 方式は AES-GCM、IV はさっき作ったもの、AAD はトピック名のバイト列。`{ iv }` は `{ iv: iv }` の省略形 |
| 2つ目 | 暗号鍵 |
| 3つ目 | 暗号化する中身。オブジェクトを JSON の文字列にし、さらにバイト列にしたもの |

結果の `ct`（ciphertext＝暗号文）には、暗号文の後ろに16バイトの認証タグが付いています。

**AAD にトピック名を入れる理由**：暗号文を盗んだ人が、それを別のトピックに投稿しても、復号するときに AAD（トピック名）が一致しないので、改ざんとみなされて失敗します。

```ts
  return concat(iv, new Uint8Array(ct));
}
```

IV と暗号文をつなげて返します。受け取った側は、先頭12バイトを IV として取り出して復号に使います。

出来上がりの形：

```
[IV 12バイト][暗号文（元の JSON と同じ長さ）][認証タグ 16バイト]
```

たとえば70バイトの JSON（`{"type":"join","attempt":"a1b2c3d4","from":"9f8e7d6c5b4a3921","seq":1}`）を暗号化すると、12 + 70 + 16 = **98バイト**になります。

### 62〜76行目：`decryptMessage()`（復号）

```ts
/** 復号・改ざん検知に失敗した場合は null */
export async function decryptMessage(room: Room, bytes: Uint8Array<ArrayBuffer>): Promise<Record<string, unknown> | null> {
  if (bytes.length < 13) return null;
```

| 行 | 説明 |
|---|---|
| 63 | 戻り値は、復号したオブジェクトか `null`。中身の形は分からないので `Record<string, unknown>`（キーは文字列、値は何か分からない）としている |
| 64 | IV（12バイト）にも満たない短いデータは、明らかに不正なので、すぐに `null` を返す |

64行目の `13` は、厳密には「IV 12 + 認証タグ 16 = 28」でもよいところです。28未満でも、復号の段階で必ず失敗して `null` になるので、結果は変わりません。

```ts
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(room.topic) },
      room.key,
      bytes.slice(12),
    );
```

| 部分 | 意味 |
|---|---|
| `bytes.slice(0, 12)` | 先頭12バイト（IV） |
| `additionalData` | 暗号化のときと同じトピック名。違えば失敗する |
| `bytes.slice(12)` | 残り（暗号文＋認証タグ） |
| `pt` | plaintext（平文＝元のデータ）。`ArrayBuffer` |

**次の場合、`decrypt` は例外を投げます**：鍵が違う、1ビットでも改ざんされている、IV が違う、AAD（トピック名）が違う。AES-GCM の認証タグで、これらをすべて検知できます。

```ts
    const obj: unknown = JSON.parse(dec.decode(pt));
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
```

| 行 | 説明 |
|---|---|
| 71 | バイト列を文字列に戻し、JSON として解析する。正しい鍵で暗号化されたものなら、普通は失敗しない |
| 72 | 結果がオブジェクトなら返し、そうでなければ（数値や `null` など）`null` を返す |

72行目の書き方：

| 部分 | 意味 |
|---|---|
| `条件 ? A : B` | 条件演算子。条件が真なら A、偽なら B |
| `obj && typeof obj === 'object'` | `typeof null` も `'object'` になってしまうので、先に `obj` が `null` でないこと（真とみなされること）を確かめている |
| `(obj as Record<string, unknown>)` | オブジェクトだと確かめたので、型アサーションで型を伝える |

```ts
  } catch {
    return null;
  }
}
```

復号の失敗（例外）や JSON の解析の失敗は、すべて `null` にします。呼び出す側（`signaling.ts`）は、`null` のメッセージを黙って捨てます（要件 6.2：復号・改ざん検知に失敗したメッセージは無視する）。公開ブローカーには、他人の無関係なメッセージや、いたずらのメッセージが届く可能性もあるため、例外を外に漏らさないようにしています。

---

## 4. 動かして確認

開発サーバーでページを開き、Console で試します。

### 4-1. 同じ秘密値から同じトピック名ができる

```js
const c = await import('/direct-share/src/crypto.ts');
const secret = new Uint8Array([0x3a, 0x7f, 0x00, 0xc5, 0x91, 0x2b, 0xe4, 0x08, 0x6d, 0xf0]);
const room = await c.deriveRoom(secret);
room.topic
// → 'direct-share/9bab16e38ab5d24b963ce1d002bd9797'

(await c.deriveRoom(secret.slice())).topic === room.topic
// → true（ホストとゲストが同じ計算をして、同じトピック名を得られる）

room.key
// → CryptoKey { type: 'secret', extractable: false, algorithm: {name: 'AES-GCM', length: 256}, usages: ['encrypt', 'decrypt'] }
```

### 4-2. 鍵は取り出せない

```js
await crypto.subtle.exportKey('raw', room.key)
// → エラー（key is not extractable）
```

### 4-3. 暗号化と改ざんの検知

```js
const msg = { type: 'join', attempt: 'a1b2c3d4', from: '9f8e7d6c5b4a3921', seq: 1 };
const ct = await c.encryptMessage(room, msg);
ct.length
// → 98（IV 12 + JSON 70 + 認証タグ 16）

await c.decryptMessage(room, ct)
// → 元のオブジェクト

const ct2 = await c.encryptMessage(room, msg);
ct.join() === ct2.join()
// → false（IV が毎回違うので、同じ内容でも暗号文は毎回変わる）

const bad = ct.slice(); bad[20] ^= 1;   // 21バイト目の1ビットを反転
await c.decryptMessage(room, bad)
// → null（改ざんを検知）

const other = await c.deriveRoom(c.randomSecret());
await c.decryptMessage(other, ct)
// → null（鍵が違う）

await c.decryptMessage({ topic: other.topic, key: room.key }, ct)
// → null（鍵は正しいが、AAD のトピック名が違う）
```

`^=` は「XOR して代入」です。`bad[20] ^= 1` で、21バイト目の一番下のビットだけを反転させています。

### 4-4. テストを読む

`test/codec.test.ts` の `シグナリングの暗号は往復でき、改ざん・別の鍵を検知する` が、このファイルのテストです。4-3 と同じことを自動で確かめています。

---

## 5. 理解チェック

1. `crypto.subtle.digest` などに `await` が必要なのはなぜですか。
2. 秘密値から 256ビットの AES 鍵を作っていますが、攻撃者にとっての強さは何ビット分ですか。
3. 暗号化のたびに IV を乱数で作り直しているのはなぜですか。
4. AAD にトピック名を指定することで、どんな攻撃を防げますか。
5. 鍵を `extractable: false` で作ると、何ができなくなりますか。
6. 70バイトの JSON を `encryptMessage()` で暗号化すると、何バイトになりますか。内訳も答えてください。
7. `decryptMessage()` が、失敗したときに例外ではなく `null` を返すようにしているのはなぜですか。

<details>
<summary>答え</summary>

1. Web Crypto API の関数は、結果をすぐに返さず `Promise` を返すため。計算はブラウザの内部でページの処理を止めずに行われ、`await` で結果が出るのを待つ。
2. 80ビット分。HKDF は鍵の長さを伸ばせるが、元の秘密値の強さ（2⁸⁰ 通り）を増やすことはできない。
3. AES-GCM では、同じ鍵で同じ IV を2回使うと安全性が大きく崩れるため。乱数で毎回作れば、ぶつかる確率は無視できるほど小さい。また、同じ内容のメッセージでも暗号文が毎回変わる。
4. 盗んだ暗号文を、別のトピック（別の部屋）に投稿して使い回す攻撃。トピック名が違えば認証タグの検証に失敗し、復号されない。
5. `crypto.subtle.exportKey` などで、鍵のバイト列を取り出すこと。鍵は暗号化・復号に使えるだけになる。
6. 98バイト。IV 12バイト + 暗号文 70バイト（元のデータと同じ長さ）+ 認証タグ 16バイト。
7. 公開ブローカーには、無関係なメッセージや不正なメッセージが届く可能性があり、それらは「無視すればよいもの」だから。例外にすると、呼び出し側で毎回受け止める必要があり、受け止め忘れると処理全体が止まってしまう。

</details>

---

次回（第5回）は `src/mqtt.ts` を読みます。MQTT の入門から始め、WebSocket の上で MQTT のパケットをバイト単位で組み立てる部分を見ていきます。
