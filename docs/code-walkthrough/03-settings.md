# 第3回 `src/settings.ts`：外部サーバー設定の保存と読み込み

このファイルは、STUN サーバーと MQTT ブローカーの設定を扱う部品です（要件 F-71〜F-80）。

- コードの中に**デフォルト値**を持つ
- 設定画面で変更された値を**検証**し、正しければブラウザの **localStorage** に保存する
- 起動時に localStorage から読み込む。保存されていない、または壊れていれば、デフォルト値を使う

---

## 1. 前提知識

### 1-1. localStorage

ブラウザに文字列を保存しておける場所です。ページを閉じても、ブラウザを再起動しても残ります。

```js
localStorage.setItem('キー', '値');     // 保存
localStorage.getItem('キー');           // 読み込み。なければ null
localStorage.removeItem('キー');        // 削除
```

- **文字列しか保存できません。** 配列などは `JSON.stringify()` で文字列にしてから保存し、読み込んだら `JSON.parse()` で元に戻します。
- **同じオリジン（`https://pecology.github.io`）のページで共有されます。** GitHub Pages では、同じアカウントの他のリポジトリのページも同じオリジンになります。そのため、キーに `direct-share:` という接頭辞を付けて、他のページのデータと混ざらないようにしています（要件 S-08）。
- ブラウザの設定によっては使えないこともあります（プライベートブラウズの一部や、サイトデータをブロックしている場合など）。その場合、読み書きの関数が例外を投げます。

### 1-2. JSON

データを文字列で表す形式です。

```js
JSON.stringify(['wss://a', 'wss://b'])   // → '["wss://a","wss://b"]'
JSON.parse('["wss://a","wss://b"]')      // → ['wss://a', 'wss://b']
JSON.parse('{壊れた')                    // → 例外を投げる
```

### 1-3. このファイルで出てくる TypeScript の書き方

| 書き方 | 意味 |
|---|---|
| `type SettingKind = 'stun' \| 'mqtt'` | 文字列リテラル型のユニオン。`'stun'` か `'mqtt'` という**その文字列だけ**を受け付ける型 |
| `Record<K, V>` | キーが `K`、値が `V` のオブジェクトの型。`Record<'stun' \| 'mqtt', string[]>` は `{ stun: string[]; mqtt: string[] }` と同じ |
| `Readonly<T>` | `T` のプロパティをすべて読み取り専用にした型（再代入が型エラーになる） |
| `{ label: string; check: (u: string) => boolean }` | オブジェクトの型をその場で書く書き方。`(u: string) => boolean` は「文字列を受け取って真偽値を返す関数」の型 |
| `unknown` | 「何が入っているか分からない」型。中身を確かめるまで、ほとんど何もできない。外から来たデータを安全に扱うために使う |
| `as const` | 値を「変わらない、具体的な値」として扱わせる |
| `void` | 関数の戻り値がないことを表す |
| `const { a, b } = obj` | 分割代入。オブジェクトのプロパティを、同じ名前の変数に取り出す |

---

## 2. ファイルの全体像

| 名前 | 役割 | 使っている場所 |
|---|---|---|
| `PREFIX`、`MAX_URLS` | キーの接頭辞、登録できる件数の上限 | このファイルの中だけ |
| `SettingKind`、`Settings` | 設定の種類と、設定全体の型 | `main.ts`、このファイル |
| `DEFAULTS` | デフォルト値 | `main.ts`（「デフォルトに戻す」の表示） |
| `KINDS` | 種類ごとの表示名と検証のルール | このファイルの中だけ |
| `read()` | 1種類分を localStorage から読む | このファイルの中だけ |
| `loadSettings()` | 設定全体を読む | `main.ts` |
| `sameList()` | 2つの一覧が同じか比べる | `isDefaultMqtt()`、`saveSettings()` |
| `isDefaultMqtt()` | ブローカーがデフォルトのままか | `main.ts`（URL にブローカーを含めるか、注意を表示するか） |
| `parseLines()` | 入力欄の文字列を1行ずつの一覧にする | `main.ts`（設定画面の保存） |
| `validate()` | 形式を検証し、エラーメッセージを返す | `saveSettings()`、`read()`、`connInfo.ts` |
| `saveSettings()` | 検証して保存する | `main.ts` |
| `resetSettings()` | 保存した設定を消す | `main.ts` |

---

## 3. 1行ずつの解説

### 1〜6行目：定数と型

```ts
// 外部サーバー設定（F-71〜F-80）
const PREFIX = 'direct-share:'; // S-08
const MAX_URLS = 5;

export type SettingKind = 'stun' | 'mqtt';
export type Settings = Record<SettingKind, string[]>;
```

| 行 | 説明 |
|---|---|
| 2 | localStorage のキーの接頭辞。実際のキーは `direct-share:stun` と `direct-share:mqtt` になる |
| 3 | 種類ごとに登録できる URL の上限（要件 F-80） |
| 5 | 設定の種類。この2つの文字列以外を渡すと型エラーになるので、`'mqqt'` のような打ち間違いを防げる |
| 6 | 設定全体の型。`{ stun: string[]; mqtt: string[] }` と同じ意味 |

### 8〜11行目：デフォルト値

```ts
export const DEFAULTS: Readonly<Settings> = Object.freeze({
  stun: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  mqtt: ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081', 'wss://broker.hivemq.com:8884/mqtt'],
});
```

| 部分 | 説明 |
|---|---|
| `: Readonly<Settings>` | 型の上で、`DEFAULTS.mqtt = …` のような再代入を禁止する |
| `Object.freeze(…)` | 実行時にも、オブジェクトを変更できなくする |
| `stun` | Google と Cloudflare の公開 STUN サーバー。`:19302` などはポート番号 |
| `mqtt` | 公開 MQTT ブローカー3つ。いずれも WebSocket over TLS（`wss://`）で接続できるポートとパス |

**注意点**：`Readonly` も `Object.freeze` も、**一番外側のオブジェクトにしか効きません**（浅い凍結）。中の配列は凍結されていないので、`DEFAULTS.mqtt.push('…')` と書けば、型チェックも通り、実行時にも中身が変わってしまいます。

このファイルは、その危険を避けるため、デフォルト値を外に渡すときに**コピー**を渡しています（36行目の `[...DEFAULTS[kind]]`）。設定画面で編集した結果が、デフォルト値そのものを書き換えることはありません。

### 13〜27行目：種類ごとのルール

```ts
const KINDS: Record<SettingKind, { label: string; prefix: string; min: number; check: (u: string) => boolean }> = {
```

`stun` と `mqtt` のそれぞれについて、次の4つを持つオブジェクトです。

| プロパティ | 意味 |
|---|---|
| `label` | エラーメッセージに使う表示名 |
| `prefix` | エラーメッセージに使う「この文字で始まる URL」の説明 |
| `min` | 最低限必要な件数 |
| `check` | 1件の URL が正しい形式かを判定する関数 |

`Record<SettingKind, …>` と型を付けているので、`stun` か `mqtt` のどちらかを書き忘れると型エラーになります。将来、種類を増やしたときの書き忘れも防げます。

```ts
  stun: { label: 'STUNサーバー', prefix: 'stun:', min: 0, check: (u) => /^stun:[^\s/]+$/.test(u) },
```

| 部分 | 説明 |
|---|---|
| `min: 0` | STUN は0件でもよい。同じ Wi-Fi 内なら STUN なしでもつながるため |
| `/^stun:[^\s/]+$/` | `stun:` で始まり、その後に空白と `/` 以外の文字が1文字以上続き、そこで終わる |

正規表現の読み方：

| 部分 | 意味 |
|---|---|
| `^` と `$` | 文字列の先頭と末尾。両方あるので、文字列**全体**がこの形でなければならない |
| `[^\s/]` | `[^…]` は「中に書いた文字**以外**の1文字」。空白（`\s`）と `/` 以外 |
| `+` | 直前のものが1回以上くり返す |

`stun:stun.l.google.com:19302` は当てはまり、`stuns:x`（`stun:` で始まらない）や `stun:a/b`（`/` を含む）は当てはまりません。

```ts
  mqtt: {
    label: 'MQTTブローカー',
    prefix: 'wss://',
    min: 1,
    check: (u) => {
      try {
        return new URL(u).protocol === 'wss:';
      } catch {
        return false;
      }
    },
  },
};
```

| 部分 | 説明 |
|---|---|
| `min: 1` | シグナリングにブローカーが必須なので、最低1件 |
| `new URL(u)` | 文字列を URL として解析する。URL として成り立たない文字列（`not a url` など）だと**例外を投げる**ので、`try` / `catch` で受け止めて `false` を返す |
| `.protocol === 'wss:'` | プロトコルが `wss:` であること。暗号化なしの `ws:` は認めない。GitHub Pages は HTTPS なので、ブラウザがそもそも `ws://` への接続を許さないため |

`stun:` の URL はブラウザの `URL` で解析すると扱いが特殊になるので、STUN は正規表現で、MQTT は `URL` で判定しています。

### 29〜37行目：`read()`（1種類分を読み込む）

```ts
function read(kind: SettingKind): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PREFIX + kind) ?? 'null');
```

| 部分 | 説明 |
|---|---|
| `localStorage.getItem(PREFIX + kind)` | `direct-share:mqtt` などのキーで読み込む。保存されていなければ `null` |
| `?? 'null'` | `null` なら代わりに文字列 `'null'` を使う。`JSON.parse('null')` は `null` を返すので、「保存なし」も同じ流れで扱える |
| `JSON.parse(…)` | 文字列を元のデータに戻す。壊れた文字列なら例外を投げ、34行目の `catch` に飛ぶ |
| `const v: unknown` | 結果をあえて `unknown` 型として受け取る（下で説明） |

**なぜ `unknown` なのか**：`JSON.parse` の戻り値の型は `any`（何でもあり、チェックなし）です。localStorage の中身は、ユーザーが開発者ツールで書き換えることもできるので、本当に文字列の配列かどうかは分かりません。`unknown` にしておくと、中身を確かめるまで配列として使えないので、確認を忘れると型エラーで気づけます。

```ts
    if (Array.isArray(v) && v.every((s) => typeof s === 'string') && validate(kind, v).length === 0) return v;
```

3つの条件をすべて満たしたときだけ、読み込んだ値を返します。`&&` は左から順に調べ、どれかが偽ならそこで止まります。

| 条件 | 意味 |
|---|---|
| `Array.isArray(v)` | 配列であること。ここで TypeScript は `v` を配列とみなすようになる |
| `v.every((s) => typeof s === 'string')` | `every` は、全要素について関数が `true` を返すかを調べる。すべて文字列であること |
| `validate(kind, v).length === 0` | 形式のエラーが0件であること |

```ts
  } catch {
    // 読めない場合はデフォルト
  }
  return [...DEFAULTS[kind]];
}
```

| 行 | 説明 |
|---|---|
| 33〜35 | `JSON.parse` の失敗や、localStorage が使えない場合の例外を受け止める。何もせず、下に進む |
| 36 | 保存がない、壊れている、形式が正しくない場合は、デフォルト値の**コピー**を返す |

つまり、localStorage がどんな状態でも、この関数は必ず正しい形式の一覧を返します。

### 39〜41行目：`loadSettings()`

```ts
export function loadSettings(): Settings {
  return { stun: read('stun'), mqtt: read('mqtt') };
}
```

2種類を読み込んで、1つのオブジェクトにして返します。

### 43〜49行目：`sameList()` と `isDefaultMqtt()`

```ts
export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
```

2つの一覧が同じかどうかを比べます。長さが同じで、かつ同じ位置の要素がすべて等しければ `true` です。`every` に渡す関数の2つ目の引数 `i` は、要素の位置（0, 1, 2…）です。

**順番も比べます。** 中身が同じでも順番が違えば `false` です。配列は `===` で直接比べると「同じ配列そのものか」を調べてしまい、中身が同じでも別の配列なら `false` になるため、このように1つずつ比べる関数が必要です。

```ts
export function isDefaultMqtt(list: readonly string[]): boolean {
  return sameList(list, DEFAULTS.mqtt);
}
```

ブローカーの設定がデフォルトのままかを返します。`main.ts` はこの結果で、次の2つを決めています。

- `false`（変更している）なら、接続用 URL にブローカーの一覧を含める（要件 F-75）
- `false` なら、待機画面に「相手側も同じ設定が必要」と表示する（要件 F-76）

### 51〜56行目：`parseLines()`

```ts
export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
```

設定画面の入力欄（1行1URL）の文字列を、URL の一覧に変換します。

| 行 | 処理 | 例：`'  wss://a \r\n\n wss://b\n'` |
|---|---|---|
| 53 | 改行で区切る。`\r?\n` は「`\r` があってもなくてもよい `\n`」。Windows の改行（`\r\n`）にも対応する | `['  wss://a ', '', ' wss://b', '']` |
| 54 | 各行の前後の空白を取る | `['wss://a', '', 'wss://b', '']` |
| 55 | 空の行を取り除く | `['wss://a', 'wss://b']` |

`.filter(Boolean)` は、`Boolean` 関数を判定に使う書き方です。`Boolean('')` は `false`、`Boolean('wss://a')` は `true` なので、空文字列だけが取り除かれます。

### 58〜68行目：`validate()`（形式の検証）

```ts
/** エラーメッセージの配列（空なら正常） */
export function validate(kind: SettingKind, list: readonly string[]): string[] {
  const { label, prefix, min, check } = KINDS[kind];
  const errors: string[] = [];
```

| 行 | 説明 |
|---|---|
| 59 | 戻り値は、エラーメッセージの配列。空なら問題なし |
| 60 | 種類に応じたルールを `KINDS` から取り出し、4つの変数に分ける（分割代入） |
| 61 | エラーメッセージを集める配列 |

```ts
  if (list.length < min) errors.push(`${label}を${min}件以上入力してください`);
  if (list.length > MAX_URLS) errors.push(`${label}は${MAX_URLS}件までです`);
  for (const u of list) {
    if (!check(u)) errors.push(`${label}の形式が正しくありません（${prefix} で始まるURL）：${u}`);
  }
  return errors;
}
```

| 行 | 説明 |
|---|---|
| 62 | 件数が足りない。STUN は `min` が0なので、このメッセージが出るのは MQTT だけ |
| 63 | 件数が多すぎる |
| 64〜66 | 1件ずつ形式を確かめ、正しくないものはその URL を添えてメッセージにする |
| 67 | 集めたメッセージを返す |

最初のエラーで止めずに、**すべてのエラーを集めて返す**のがポイントです。設定画面で、間違いをまとめて表示できます。

| 入力 | 結果 |
|---|---|
| `validate('mqtt', [])` | `['MQTTブローカーを1件以上入力してください']` |
| `validate('mqtt', ['wss://a', 'ws://b', 'not a url'])` | `ws://b` と `not a url` の2件のエラー |
| `validate('stun', ['stun:a:1', 'stuns:x', 'stun:a/b'])` | `stuns:x` と `stun:a/b` の2件のエラー |

### 70〜79行目：`saveSettings()`（検証して保存）

```ts
export function saveSettings(settings: Settings): string[] {
  const errors = [...validate('stun', settings.stun), ...validate('mqtt', settings.mqtt)];
  if (errors.length) return errors;
```

| 行 | 説明 |
|---|---|
| 71 | 2種類のエラーをまとめて1つの配列にする。`...` で、それぞれの配列の中身を展開して並べている |
| 72 | エラーがあれば、**何も保存せずに**エラーを返す（要件 F-78：不正な値は保存しない） |

```ts
  for (const kind of ['stun', 'mqtt'] as const) {
    // デフォルトと同じなら保存しない（デフォルト値の更新に追従させる）
    if (sameList(settings[kind], DEFAULTS[kind])) localStorage.removeItem(PREFIX + kind);
    else localStorage.setItem(PREFIX + kind, JSON.stringify(settings[kind]));
  }
  return [];
}
```

| 行 | 説明 |
|---|---|
| 73 | `'stun'` と `'mqtt'` について順に処理する |
| 75 | デフォルトと同じなら、保存せずに**削除**する |
| 76 | デフォルトと違えば、JSON の文字列にして保存する |
| 78 | 成功したので、空の配列を返す |

**`as const` が必要な理由**：`['stun', 'mqtt']` とだけ書くと、TypeScript はこれを「文字列の配列（`string[]`）」とみなします。すると `kind` は `string` 型になり、`settings[kind]` で「`Settings` に任意の文字列のキーはない」という型エラーになります。`as const` を付けると「`'stun'` と `'mqtt'` という2つの値だけを持つ変更不可の配列」とみなされ、`kind` は `'stun' | 'mqtt'`（＝`SettingKind`）になります。

**デフォルトと同じなら削除する理由**（74行目のコメント）：もしデフォルトと同じ値も保存しておくと、将来アプリのデフォルト値を変えた（たとえば止まったブローカーを入れ替えた）ときに、古い値を保存している人には新しいデフォルトが届きません。保存しないでおけば、`read()` が常に最新のデフォルト値を返します。

### 81〜84行目：`resetSettings()`

```ts
export function resetSettings(): void {
  localStorage.removeItem(PREFIX + 'stun');
  localStorage.removeItem(PREFIX + 'mqtt');
}
```

保存した設定を削除します。次に `loadSettings()` を呼ぶとデフォルト値が返ります（要件 F-74）。

#### 気づいた点：保存時の例外は受け止めていない

`read()` は localStorage の例外を `try` / `catch` で受け止めていますが、`saveSettings()` と `resetSettings()` は受け止めていません。localStorage が使えない環境で「保存」を押すと、例外が発生して処理が止まり、何も表示されません。起動や接続には影響しないので、実害は小さいです。

---

## 4. 動かして確認

### 4-1. 保存された値を見る

1. 開発サーバーでページを開き、歯車アイコンから MQTT ブローカーを `wss://broker.emqx.io:8084/mqtt` の1行だけにして保存します。
2. 開発者ツールの「Application」タブ（Firefox では「ストレージ」）→ Local Storage → `http://localhost:5173` を開きます。
3. `direct-share:mqtt` というキーに `["wss://broker.emqx.io:8084/mqtt"]` が保存されていることを確認します。待機画面には「相手側も同じ設定が必要」の注意が表示されます。
4. 設定画面で「デフォルトに戻す」を押し、キーが消えることを確認します。

### 4-2. 壊れた値を入れてみる

Console で次を実行し、それぞれページを再読み込みします。

```js
localStorage.setItem('direct-share:mqtt', '{壊れた');      // JSON として不正
localStorage.setItem('direct-share:mqtt', '["ws://bad"]'); // 形式が不正
```

どちらの場合も、歯車アイコンから設定画面を開くと、デフォルトの3件が表示されます。`read()` が壊れた値を捨てて、デフォルト値を返しているためです。確認したら、次のコマンドで元に戻します。

```js
localStorage.removeItem('direct-share:mqtt');
```

### 4-3. 関数を直接呼ぶ

```js
const s = await import('/direct-share/src/settings.ts');
s.validate('mqtt', ['wss://a', 'ws://b', 'not a url'])
s.parseLines('  wss://a \r\n\n wss://b\n')
s.sameList(['a', 'b'], ['b', 'a'])   // → false（順番が違う）
```

---

## 5. 理解チェック

1. localStorage のキーに `direct-share:` を付けているのはなぜですか。
2. `read()` で `JSON.parse` の結果を `unknown` 型で受け取っているのはなぜですか。
3. `read()` の最後で `DEFAULTS[kind]` ではなく `[...DEFAULTS[kind]]` を返しているのはなぜですか。
4. 設定画面で、デフォルトと同じ内容を「保存」すると、localStorage はどうなりますか。そうしている理由は何ですか。
5. `saveSettings()` の `['stun', 'mqtt'] as const` から `as const` を消すと、どうなりますか。
6. STUN サーバーは0件でもよいのに、MQTT ブローカーは1件以上必要なのはなぜですか。

<details>
<summary>答え</summary>

1. GitHub Pages では、同じアカウントの他のリポジトリのページも同じオリジン（`https://pecology.github.io`）になり、localStorage を共有するため。接頭辞を付けて、他のページのデータとキーがぶつからないようにしている（要件 S-08）。
2. localStorage の中身は、ユーザーが書き換えたり壊れていたりする可能性があり、本当に文字列の配列かどうか分からないため。`unknown` にしておくと、配列であること・中身が文字列であることを確かめるまで使えないので、確認漏れを型チェックで防げる。
3. `DEFAULTS` は一番外側しか凍結されておらず、中の配列は変更できてしまうため。コピーを渡せば、受け取った側が配列を変更しても、デフォルト値そのものは変わらない。
4. 該当するキーが削除される（保存されない）。将来アプリのデフォルト値を変えたときに、新しいデフォルトが自動で使われるようにするため。
5. `kind` が `string` 型とみなされ、`settings[kind]` や `DEFAULTS[kind]` で「`string` 型のキーでは参照できない」という型エラーになる。
6. ブローカーはシグナリング（接続情報の交換）に必須で、ないと接続を始められないため。STUN はグローバルアドレスを調べるためのもので、同じ Wi-Fi 内ならなくても接続できる。

</details>

---

次回（第4回）は `src/crypto.ts` を読みます。秘密値から MQTT のトピック名と暗号鍵を作る部分で、非同期処理（`Promise`、`async` / `await`）が初めて本格的に出てきます。
