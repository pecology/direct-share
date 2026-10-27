# 第2回 `src/connInfo.ts`：接続コードとURLの組み立てと解釈

このファイルは、第1回の `base32.ts` を使って、次の2つを行う部品です。

- **組み立て**：秘密値から、接続コード（`79ZG-1HCH-5FJ0-GVFG`）と接続用URL（`https://pecology.github.io/direct-share/#79ZG-…`）を作る
- **解釈**：参加画面に入力された文字列や、開いたURLの `#` 以降から、秘密値とブローカーの設定を取り出す。おかしな入力なら、日本語のエラーメッセージを返す

---

## 1. 前提知識

### 1-1. ユニオン型（`A | B`）

「A か B のどちらか」を表す型です。

```ts
let x: string | null;
x = 'abc';  // OK
x = null;   // OK
x = 123;    // エラー
```

オブジェクトの形が違うものを並べることもできます。このファイルの中心になる型がそれです。

```ts
type ParseResult =
  | { secret: Uint8Array<ArrayBuffer>; brokers: string[] | null; error?: undefined }  // 成功
  | { error: string };                                                                // 失敗
```

関数が「成功した結果」か「失敗の理由」のどちらかを返す、という形を型で表しています。

### 1-2. 型の絞り込み（ナローイング）

ユニオン型の値は、そのままでは「どちらの形か」が分からないので、片方にしかないもの（`secret`）は使えません。`if` で調べると、TypeScript がその中では型を絞り込んでくれます。

```ts
const result = parseInput(text);   // ParseResult（成功か失敗か不明）

if (result.error !== undefined) {
  // ここでは result は { error: string }（失敗）
  console.log(result.error);
  return;
}
// ここでは result は成功の形。secret が使える
console.log(result.secret);
```

失敗の形は `error` が必ず文字列なので、`error !== undefined` なら失敗だと分かります。成功の形は `error?: undefined`（`error` は無いか `undefined`）なので、`error === undefined` なら成功です。

**なぜ成功の形にわざわざ `error?: undefined` を書いているか**：TypeScript では、ユニオン型の値に対して、**片方の形にしかないプロパティ**を読むとエラーになります。成功の形にも「`error` は `undefined`」と書いておくことで、どちらの形でも `result.error` を読めるようになり、上のような絞り込みができます。

### 1-3. URL の構造

```
https://pecology.github.io/direct-share/#79ZG-1HCH-5FJ0-GVFG&b=wss%3A%2F%2F…
└─┬──┘ └───────┬─────────┘└─────┬──────┘└──────────────┬──────────────────┘
プロトコル    ホスト名           パス              フラグメント（# 以降）
└────────────┬──────────┘
          origin
```

- **`location.origin`**：プロトコル＋ホスト名（＋ポート）。`https://pecology.github.io`
- **`location.pathname`**：パス。`/direct-share/`
- **フラグメント（`#` 以降）**：本来はページ内の位置を示す部分。**ブラウザはこの部分をサーバーに送りません。** そのため、秘密値をここに入れればサーバーに届かない（要件 S-03）

### 1-4. URL エンコード

URL には使える文字が決まっています。`:` や `/`、`,` などの記号をデータとして入れるときは、`%` と16進数2桁に置き換えます（パーセントエンコード）。

| 関数 | 例 |
|---|---|
| `encodeURIComponent('wss://a/mqtt')` | `'wss%3A%2F%2Fa%2Fmqtt'`（`:` → `%3A`、`/` → `%2F`） |
| `decodeURIComponent('wss%3A%2F%2Fa%2Fmqtt')` | `'wss://a/mqtt'` |

`decodeURIComponent` は、`%E0%A4%A` のように壊れた書き方を渡すと**例外（エラー）を投げます**。

### 1-5. 例外と `try` / `catch`

関数の中で処理を続けられない問題が起きると、「例外」が投げられ、処理が中断されます。`try { … } catch { … }` で囲むと、例外が起きたときに `catch` の中に飛び、そこで後始末ができます。

```ts
try {
  decodeURIComponent('%E0%A4%A');  // 例外が投げられる
  console.log('ここは実行されない');
} catch {
  console.log('壊れたURLだった');   // こちらが実行される
}
```

### 1-6. このファイルで新しく出てくる書き方

| 書き方 | 意味 |
|---|---|
| `export type 名前 = …` | 型に名前を付ける（型エイリアス）。`export` で他のファイルからも使える |
| `` `…${式}…` `` | テンプレート文字列。バッククォートで囲み、`${}` の中に式を埋め込める |
| `readonly string[]` | 読み取り専用の配列。この関数の中では中身を変更しない、という約束 |
| `const [a, ...rest] = 配列` | 分割代入。配列の最初の要素を `a` に、残りを配列 `rest` に入れる |
| `continue` | ループの残りの処理を飛ばして、次のくり返しに進む |
| `.filter(Boolean)` | 配列から、空文字列などの「偽とみなされる値」を取り除く |

---

## 2. ファイルの全体像

| 名前 | 役割 | 使っている場所 |
|---|---|---|
| `ParseResult` | 解釈の結果の型（成功か失敗か） | `main.ts` |
| `secretToCode()` | 秘密値 → 表示用の接続コード | `main.ts`（待機画面の表示） |
| `pageUrl()` | 今開いているページのURL（`#` より前） | `main.ts` |
| `buildUrl()` | 接続用URLを作る | `main.ts`（QRとURLのコピー） |
| `parseHash()` | URL の `#` 以降を解釈する | `main.ts`（URLで開いたとき）、`parseInput()` |
| `parseCode()` | 接続コードを解釈する | `parseInput()`、`parseHash()` |
| `parseInput()` | 参加画面の入力を解釈する（コードとURLの両方に対応） | `main.ts` |
| `looksLikeUrl()` | 入力中の文字列が URL らしいか | `main.ts`（入力中の自動整形を止める判定） |

解釈の関数の呼び出し関係はこうなっています。

```
parseInput（参加画面の入力）
  ├─ # がある ──→ parseHash ──→ parseCode
  └─ # がない ───────────────→ parseCode

main.ts の handleHash（URLで開いたとき）──→ parseHash ──→ parseCode
```

---

## 3. 1行ずつの解説

### 1〜7行目：読み込みと型の定義

```ts
// 接続コード・接続用URLの組み立てと解釈（6.1）
import { CODE_LENGTH, decodeBase32, encodeBase32, formatCode, invalidChars, normalizeCode } from './base32.ts';
import { validate } from './settings.ts';
```

| 行 | 説明 |
|---|---|
| 1 | コメント。「6.1」は要件定義書の章番号 |
| 2 | 第1回の `base32.ts` から6つを取り込む |
| 3 | 第3回の `settings.ts` から、設定値の形式チェックの関数を取り込む。URL に入っているブローカーの設定が正しい形式かを確かめるのに使う |

```ts
export type ParseResult =
  | { secret: Uint8Array<ArrayBuffer>; brokers: string[] | null; error?: undefined }
  | { error: string };
```

| 行 | 説明 |
|---|---|
| 5 | `ParseResult` という名前の型を定義する |
| 6 | 成功の形。`secret` は秘密値（10バイト）。`brokers` は URL に入っていたブローカーの一覧で、入っていなければ `null`。`error?: undefined` は前提知識 1-2 のとおり、絞り込みのための書き方。先頭の `\|` は、2行に分けて書くときの見た目をそろえるためのもので、意味はない |
| 7 | 失敗の形。`error` にエラーメッセージが入る |

### 9〜15行目：`secretToCode()` と `pageUrl()`

```ts
export function secretToCode(secret: Uint8Array): string {
  return formatCode(encodeBase32(secret));
}
```

秘密値を Base32 の16文字にし、4文字ごとにハイフンを入れます。内側の関数から順に実行されます。

```
秘密値 ──encodeBase32──→ '79ZG1HCH5FJ0GVFG' ──formatCode──→ '79ZG-1HCH-5FJ0-GVFG'
```

```ts
export function pageUrl(): string {
  return location.origin + location.pathname;
}
```

今開いているページの URL から、`#` 以降（と `?` 以降）を除いたものを返します。公開版なら `https://pecology.github.io/direct-share/`、開発中なら `http://localhost:5173/direct-share/` です。

`location` はブラウザにしかないので、この関数は Node.js で動くテストでは使えません。そのため次の `buildUrl()` は、ページのURLを引数 `base` で受け取る形にしてあり、テストでは好きな URL を渡せます。

### 17〜22行目：`buildUrl()`（接続用URLを作る）

```ts
/** brokers が null ならブローカー設定を含めない */
export function buildUrl(base: string, secret: Uint8Array, brokers: readonly string[] | null): string {
  let hash = secretToCode(secret);
  if (brokers) hash += '&b=' + brokers.map(encodeURIComponent).join(',');
  return `${base}#${hash}`;
}
```

| 行 | 説明 |
|---|---|
| 18 | 引数は、ページのURL、秘密値、ブローカーの一覧（含めないなら `null`） |
| 19 | まず接続コード（ハイフン入り）を `#` 以降の中身にする |
| 20 | `brokers` が `null` でなければ、`&b=` に続けてブローカーの一覧を足す。それぞれの URL をエンコードしてから `,` でつなぐ。エンコードすると URL の中の `,` も `%2C` になるので、区切りの `,` と混ざらない |
| 21 | テンプレート文字列で `base` + `#` + 中身 をつなげて返す |

20行目の `brokers.map(encodeURIComponent)` は、`brokers.map((u) => encodeURIComponent(u))` を短く書いたものです。関数そのものを `map` に渡しています。

**どちらを渡すかは `main.ts` が決めています。** ブローカーの設定がデフォルトと同じなら `null` を渡し、URL（とQR）を短く保ちます（要件 6.1）。

| ブローカー設定 | 作られる URL |
|---|---|
| デフォルトのまま | `https://pecology.github.io/direct-share/#79ZG-1HCH-5FJ0-GVFG` |
| 変更している | `https://pecology.github.io/direct-share/#79ZG-1HCH-5FJ0-GVFG&b=wss%3A%2F%2Fmy.example%3A8084%2Fmqtt,wss%3A%2F%2Fb.example` |

### 24〜41行目：`parseHash()`（URL の `#` 以降を解釈する）

```ts
/** URLの # 以降の文字列を解釈する */
export function parseHash(hash: string): ParseResult {
  try {
```

関数全体を `try` で囲んでいます。中で `decodeURIComponent` が例外を投げても、38行目の `catch` で受け止めて、エラーメッセージを返すためです。

```ts
    const [codePart, ...params] = hash.replace(/^#/, '').split('&');
```

1行に3つの処理があります。`'#79ZG-1HCH-5FJ0-GVFG&b=wss%3A…'` を例にします。

| 順番 | 部分 | 結果 |
|---|---|---|
| 1 | `.replace(/^#/, '')` | 先頭の `#` があれば取り除く。`^` は「文字列の先頭」という意味。`'79ZG-…&b=wss%3A…'` |
| 2 | `.split('&')` | `&` で区切って配列にする。`['79ZG-1HCH-5FJ0-GVFG', 'b=wss%3A…']` |
| 3 | `const [codePart, ...params] =` | 配列の最初の要素を `codePart` に、残りすべてを配列 `params` に入れる |

```ts
    const result = parseCode(decodeURIComponent(codePart));
    if (result.error !== undefined) return result;
```

| 行 | 説明 |
|---|---|
| 28 | 接続コードの部分をデコードしてから `parseCode()` で解釈する。このアプリが作る URL では接続コードに記号がエンコードされることはないので、普通はデコードしても変わらない。外部のツールなどを通って、エンコードされた状態で届いた場合への念のための備え |
| 29 | 接続コードが不正なら、その失敗の結果をそのまま返す。この行より後では、`result` は成功の形に絞り込まれる |

```ts
    let brokers: string[] | null = null;
    for (const p of params) {
      if (!p.startsWith('b=')) continue;
```

| 行 | 説明 |
|---|---|
| 30 | ブローカーの一覧。URL に含まれていなければ `null` のまま |
| 31 | `&` で区切った残りの部分を1つずつ調べる |
| 32 | `b=` で始まらないものは無視する。将来ほかの設定を URL に足しても、古い版のページが壊れないようにするため |

```ts
      const list = p.slice(2).split(',').filter(Boolean).map(decodeURIComponent);
      if (validate('mqtt', list).length) return { error: 'URL内のブローカー設定が正しくありません' };
      brokers = list;
    }
```

| 行 | 説明 |
|---|---|
| 33 | `p.slice(2)` で先頭の `b=` の2文字を取り除き、`,` で区切り、空の要素を取り除き、それぞれをデコードする |
| 34 | `settings.ts` の `validate()` で形式を確かめる。`validate()` はエラーメッセージの配列を返すので、`.length` が1以上（＝エラーがある）なら失敗を返す。0 は「偽」とみなされるので、エラーがなければ `if` の中は実行されない |
| 35 | 正しければ `brokers` に入れる。`b=` が複数あった場合は、最後のものが使われる |

34行目のチェックは重要です。URL は誰でも作れるので、`ws://`（暗号化なし）や変な文字列のブローカーを指定されても、そのまま使わないようにしています。

```ts
    return { secret: result.secret, brokers };
  } catch {
    return { error: 'URLの形式が正しくありません' };
  }
}
```

| 行 | 説明 |
|---|---|
| 37 | 成功の結果を返す。`{ brokers }` は `{ brokers: brokers }` の省略形（プロパティ名と変数名が同じときに使える） |
| 38〜40 | `try` の中で例外が起きたら、ここに来て失敗の結果を返す |

### 43〜51行目：`parseCode()`（接続コードを解釈する）

```ts
export function parseCode(input: string): ParseResult {
  const code = normalizeCode(input);
  const bad = invalidChars(code);
  if (bad.length) return { error: `使えない文字が含まれています：${bad.join(' ')}` };
  if (code.length !== CODE_LENGTH) return { error: `接続コードは${CODE_LENGTH}文字です（入力：${code.length}文字）` };
  const secret = decodeBase32(code);
  if (!secret) return { error: '接続コードが正しくありません' };
  return { secret, brokers: null };
}
```

| 行 | 説明 |
|---|---|
| 44 | 入力のゆれを直す（大文字にする、ハイフンや空白を消す、`O` → `0` など） |
| 45〜46 | 使えない文字があれば、その文字を並べたエラーを返す |
| 47 | 16文字でなければ、入力された文字数を添えたエラーを返す |
| 48 | Base32 からバイト列に戻す |
| 49 | `decodeBase32()` は不正な文字があると `null` を返す。45〜46行目で確認済みなので、実際にはここで失敗することはない。ただ、戻り値の型が `Uint8Array \| null` なので、`null` の場合を処理しないと、50行目で型エラーになる。型の絞り込みのための行でもある |
| 50 | 成功の結果を返す。接続コードにはブローカーの設定が含まれないので、`brokers` は `null`（要件 F-76） |

**チェックの順番に意味があります。** 文字数より先に使えない文字を調べているので、`79ZG-1HCH-5FJ0-GVFU`（最後が `U`）のような入力には、「16文字です」ではなく「使えない文字が含まれています：U」と、より具体的なエラーが出ます。

### 53〜61行目：`parseInput()`（参加画面の入力を解釈する）

```ts
/** 参加画面の入力欄の値（接続コードまたは接続用URL）を解釈する（F-14） */
export function parseInput(input: string): ParseResult {
  const text = input.trim();
  if (!text) return { error: '接続コードまたはURLを入力してください' };
```

| 行 | 説明 |
|---|---|
| 55 | 前後の空白や改行を取り除く。コピーしたときに紛れ込みやすいため |
| 56 | 空なら、入力を促すエラーを返す。空文字列は「偽」とみなされるので、`!text` は「空なら」という意味になる |

```ts
  const hashIndex = text.indexOf('#');
  if (hashIndex >= 0) return parseHash(text.slice(hashIndex + 1));
```

| 行 | 説明 |
|---|---|
| 57 | `#` の位置を探す。なければ `-1` |
| 58 | `#` があれば、その次の文字以降を `parseHash()` に渡す。`#` より前（`https://…/`）は見ない。そのため、ドメインが違っていても、`#` 以降が正しければ接続できる |

```ts
  if (/^https?:\/\//i.test(text)) return { error: 'URLに接続情報（# 以降）が含まれていません' };
  return parseCode(text);
}
```

| 行 | 説明 |
|---|---|
| 59 | `#` がないのに `http://` か `https://` で始まっていれば、URL の `#` 以降が欠けている。コピーするときに一部だけ選んでしまった場合などを想定し、分かりやすいエラーを返す |
| 60 | それ以外は接続コードとして解釈する |

59行目の正規表現：

| 部分 | 意味 |
|---|---|
| `^` | 文字列の先頭 |
| `https?` | `http` の後に `s` が0個か1個（`?` は「直前の文字があってもなくてもよい」） |
| `:\/\/` | `://`。`/` は正規表現の区切りと同じ文字なので、`\` を付けて文字そのものとして扱う |
| `i` | 大文字と小文字を区別しない（`HTTPS://` にも当てはまる） |
| `.test(text)` | 当てはまれば `true`、なければ `false` |

### 63〜65行目：`looksLikeUrl()`

```ts
export function looksLikeUrl(text: string): boolean {
  return /[:/#]/.test(text);
}
```

`:`、`/`、`#` のどれかが含まれていれば `true` を返します。接続コードにはこれらの文字が入らないので、URL を入力している途中だと判断できます。

`main.ts` は、入力欄に文字が入るたびに、接続コードとして整形（大文字化とハイフン挿入）しています。URL まで整形すると壊れてしまうので、この関数が `true` を返したら整形をやめます。

#### 気づいた点：URL を1文字ずつ手で打つと、先頭が崩れる

URL を貼り付けた場合は、最初から `:` などを含むので問題ありません。ところが1文字ずつ手で打つと、最初の `https` までは `:` がまだないので、接続コードとして整形されてしまいます。

```
h → H → HT → HTT → HTTP → HTTP-S → HTTP-S: → …（ここからは整形されない）→ HTTP-S://x/#79zg
```

ただし、`parseInput()` は `#` より後ろしか見ないので、**接続には影響しません**（見た目が崩れるだけ）。また、URL を手で打つ人はほとんどおらず、手入力なら接続コードを打つのが普通です（要件 M-3）。

---

## 4. 動かして確認

### 4-1. コンソールで試す

開発サーバーでページを開き、開発者ツールの Console で次を入力します。

```js
const c = await import('/direct-share/src/connInfo.ts');
const secret = new Uint8Array([0x3a, 0x7f, 0x00, 0xc5, 0x91, 0x2b, 0xe4, 0x08, 0x6d, 0xf0]);

c.secretToCode(secret)
// → '79ZG-1HCH-5FJ0-GVFG'

c.buildUrl('https://pecology.github.io/direct-share/', secret, null)
// → 'https://pecology.github.io/direct-share/#79ZG-1HCH-5FJ0-GVFG'

c.buildUrl('https://pecology.github.io/direct-share/', secret, ['wss://my.example:8084/mqtt'])
// → '…#79ZG-1HCH-5FJ0-GVFG&b=wss%3A%2F%2Fmy.example%3A8084%2Fmqtt'
```

いろいろな入力を `parseInput()` に渡して、結果を見てください。

| 入力 | 結果 |
|---|---|
| `'  79zg 1hch 5fjo gvfg '` | 成功（小文字・空白・`o` を直して解釈） |
| `'79ZG-1HCH'` | `接続コードは16文字です（入力：8文字）` |
| `'79ZG-1HCH-5FJ0-GVFU'` | `使えない文字が含まれています：U` |
| `'https://pecology.github.io/direct-share/'` | `URLに接続情報（# 以降）が含まれていません` |
| `''` | `接続コードまたはURLを入力してください` |

`parseHash()` も試します。

| 入力 | 結果 |
|---|---|
| `'79ZG1HCH5FJ0GVFG&b=ws%3A%2F%2Fx'` | `URL内のブローカー設定が正しくありません`（`ws://` は不可） |
| `'79ZG1HCH5FJ0GVFG&b=%E0%A4%A'` | `URLの形式が正しくありません`（デコードで例外） |
| `'79ZG1HCH5FJ0GVFG&x=1'` | 成功（知らない `x=` は無視） |

### 4-2. URL で開いてみる

1. 待機画面で「URLをコピー」を押します。
2. 別のタブを開き、そのURLを貼り付けて開きます。
3. 接続されたら、アドレスバーを見てください。`#` 以降が消えています。これは `main.ts` の `handleHash()` が、URL を読み取った直後に `history.replaceState` で消しているためです（要件 S-07。第10回で扱います）。

### 4-3. テストを読む

`test/codec.test.ts` の `接続コード・URLを解釈する` が、このファイルのテストです。URL を作って解釈し直すと元の秘密値とブローカーに戻ること、小文字と空白で入力しても解釈できること、各種エラーになることを確かめています。

---

## 5. 理解チェック

1. 接続用URLで、秘密値を `?code=…` ではなく `#…` に入れているのはなぜですか。
2. `ParseResult` の成功の形に `error?: undefined` がないと、何が困りますか。
3. `parseHash()` 全体を `try` / `catch` で囲んでいるのはなぜですか。
4. `parseCode()` の49行目（`if (!secret) …`）は実際には実行されないのに、なぜ書いてあるのですか。
5. `buildUrl()` で、ブローカーの URL を `encodeURIComponent` せずに `,` でつなぐと、どんな問題が起こりえますか。
6. 参加画面に `hello#79ZG-1HCH-5FJ0-GVFG` と入力すると、どうなりますか。

<details>
<summary>答え</summary>

1. `#` 以降（フラグメント）はブラウザがサーバーに送らないため。`?` 以降（クエリ）はサーバーに送られるので、GitHub Pages のアクセスログなどに秘密値が残るおそれがある（要件 S-03）。
2. ユニオン型の片方にしかないプロパティは読めないので、`result.error !== undefined` と書いた時点で型エラーになる。成功か失敗かを `error` で見分けられなくなる。
3. `decodeURIComponent` は、壊れたパーセントエンコード（`%E0%A4%A` など）を渡すと例外を投げるため。例外を受け止めて、「URLの形式が正しくありません」というエラーの結果にしている。
4. `decodeBase32()` の戻り値の型が `Uint8Array | null` なので、`null` の場合を処理しないと、`secret` を成功の結果に入れるところで型エラーになるため。型の絞り込みのための行でもあり、念のための安全策でもある。
5. ブローカーの URL の中に `,` が含まれていると、区切りの `,` と区別できず、1つの URL が2つに割れてしまう。また、URL の中の `&` や `#` も、`#` 以降の構造（`&` で区切る）を壊してしまう。
6. `#` があるので、`#` より後の `79ZG-1HCH-5FJ0-GVFG` が `parseHash()` で解釈され、接続が始まる。`hello` は無視される。

</details>

---

次回（第3回）は `src/settings.ts` を読みます。このファイルの34行目で使った `validate()` を含め、外部サーバーの設定を localStorage に保存・読み込みする部分です。
