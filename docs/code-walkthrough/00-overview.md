# 第0回 全体像と土台

この回では、アプリの中身（`src/` の処理）に入る前に、次の2つを押さえます。

1. TypeScript と、このプロジェクトでの「ビルドの仕組み」
2. 土台になる4つのファイル：`package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`

---

## 1. 前提知識

### 1-1. TypeScript とは

TypeScript は、**JavaScript に「型」の情報を書き足せるようにした言語**です。

```ts
// JavaScript
function add(a, b) {
  return a + b;
}

// TypeScript：引数と戻り値に型を書ける
function add(a: number, b: number): number {
  return a + b;
}

add(1, 2);     // OK
add('1', 2);   // エラー：'1' は number ではない（実行する前に分かる）
```

大事な性質が3つあります。

1. **型は実行時には消える**
   ブラウザは TypeScript を直接は実行できません。型の部分（`: number` など）を取り除くと、普通の JavaScript になります。型は「書いている間にミスを見つけるための注釈」です。
2. **型のチェックと、型の除去は別の作業**
   - 型のチェック：`tsc`（TypeScript コンパイラ）が行う。ミスがあればエラーを出す
   - 型の除去：Vite（ブラウザ用）や Node.js（テスト用）が行う。型が間違っていても、チェックせずに取り除いて実行してしまう

   このプロジェクトでは、この2つをはっきり分けています（後述の `tsconfig.json` の `noEmit`）。
3. **型は書かなくても推測される**
   `const n = 1;` と書けば、`n` は `number` だと自動で分かります（型推論）。そのため、コードの中で型を書いていない変数もたくさんあります。

### 1-2. モジュール（`import` / `export`）

1つのファイルが1つの「モジュール」です。他のファイルに見せたいものに `export` を付け、使う側は `import` で取り込みます。

```ts
// base32.ts
export function formatCode(code: string): string { … }

// main.ts
import { formatCode } from './base32.ts';
```

`export` を付けていない関数や変数は、そのファイルの中だけで使えます。

### 1-3. Vite の役割

Vite は開発用のツールで、2つの仕事をします。

| 場面 | コマンド | すること |
|---|---|---|
| 開発中 | `npm run dev` | 手元にWebサーバーを立てる。ブラウザが `.ts` を要求するたびに、その場で型を取り除いて JavaScript にして返す。ファイルを保存すると画面が自動で更新される |
| 公開用 | `npm run build` | すべてのファイルを1つの JS と1つの CSS にまとめ、圧縮して `dist/` に出力する。GitHub Pages に置くのはこの `dist/` の中身 |

Vite は開発時にだけ使うツールで、公開されたページの中には含まれません（要件の「実行時の外部ライブラリ0」）。

### 1-4. ファイルの依存関係

`src/` のファイルが、どのファイルを使っているかを示します（矢印は「使っている」）。

```
                         main.ts（画面）
     ┌──────────┬──────────┼───────────┬──────────┬──────────┐
     ▼          ▼          ▼           ▼          ▼          ▼
 connInfo   connection   session      qr      settings    base32
     │          │          │
     │          ▼          │
     │      signaling      │
     │       │    │        │
     │       ▼    ▼        │
     │     mqtt  crypto ◀──┘
     ▼
 base32, settings
```

下の方にあるファイルほど、他に頼らず単独で読めます。解説の順番（base32 → connInfo → settings → crypto → mqtt → signaling → connection → session → main）は、この図を下から上へたどる順番です。

---

## 2. `package.json`

npm（Node.js のパッケージ管理ツール）のための設定ファイルです。プロジェクトの名前、使う開発ツール、よく使うコマンドを書きます。

```json
{
  "name": "direct-share",
  "private": true,
  "version": "0.1.0",
  "type": "module",
```

| 行 | 意味 |
|---|---|
| `"name"` | プロジェクトの名前 |
| `"private": true` | npm の公開サイト（npmjs.com）に誤って公開できないようにする。アプリなので公開する必要がない |
| `"version"` | バージョン番号。このプロジェクトでは特に使っていない |
| `"type": "module"` | このプロジェクトの `.js` ファイルを、`import` / `export` を使う形式（ES モジュール）として扱うよう Node.js に伝える。古い形式（`require`）を使わないための指定 |

```json
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc && tsc -p test",
    "build": "npm run typecheck && vite build",
    "preview": "vite preview",
    "test": "node --experimental-strip-types --no-warnings --test \"test/*.test.ts\""
  },
```

`npm run <名前>` で実行できるコマンドの一覧です。`npm run dev` と打つと `vite` が実行されます。

| 名前 | 実行内容 | 説明 |
|---|---|---|
| `dev` | `vite` | 開発サーバーを起動する |
| `typecheck` | `tsc && tsc -p test` | 型チェックを2回行う。1回目はアプリ本体（`tsconfig.json`）、2回目はテスト（`test/tsconfig.json`）。`&&` は「前が成功したら次を実行」 |
| `build` | `npm run typecheck && vite build` | 型チェックに成功したら、公開用にビルドする。型エラーがあるとビルドされない |
| `preview` | `vite preview` | ビルドした `dist/` を手元で表示して確認する |
| `test` | `node … --test "test/*.test.ts"` | テストを実行する（下で詳しく説明） |

`test` の各部分：

| 部分 | 意味 |
|---|---|
| `node` | Node.js でテストを動かす（ブラウザではなく） |
| `--experimental-strip-types` | `.ts` ファイルの型を取り除いて、そのまま実行する。Node.js 22 では「実験的な機能」なので、このオプションで有効にする |
| `--no-warnings` | 「実験的な機能を使っています」という警告を出さない |
| `--test` | Node.js 標準のテスト機能でテストを実行する |
| `\"test/*.test.ts\"` | 対象のファイル。`\"` は JSON の中で `"` を書くための書き方。引用符で囲むことで、シェルではなく Node.js にファイルの検索を任せている（Windows でも同じように動かすため） |

```json
  "devDependencies": {
    "@types/node": "^22.20.5",
    "typescript": "^7.0.2",
    "vite": "^8.3.5"
  }
}
```

開発時にだけ使うパッケージの一覧です。`npm install` でインストールされ、`node_modules/` に入ります。

| パッケージ | 役割 |
|---|---|
| `@types/node` | Node.js の機能（`node:test` など）の型情報。テストの型チェックだけで使う |
| `typescript` | 型チェックを行う `tsc` コマンド |
| `vite` | 開発サーバーとビルド |

- `^7.0.2` の `^` は「7.x.x の範囲で、7.0.2 以上の新しい版を使ってよい」という意味です。実際にインストールされた正確な版は `package-lock.json` に記録されます。
- **`dependencies`（実行時に使うパッケージ）の項目がありません。** これが「実行時の外部ライブラリ0」の証拠です。

---

## 3. `tsconfig.json`

`tsc`（型チェック）の設定ファイルです。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
```

| 行 | 意味 |
|---|---|
| `"target": "ES2022"` | JavaScript のどの年の仕様までの書き方を使うか。2022年版までの機能を、変換せずにそのまま使える前提でチェックする |
| `"module": "ESNext"` | `import` / `export` を、最新の ES モジュールの形式として扱う |
| `"moduleResolution": "bundler"` | `import` に書いたファイルを、Vite のようなバンドラー（ファイルをまとめるツール）と同じルールで探す |

```json
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
```

| 行 | 意味 |
|---|---|
| `"lib"` | 最初から使える機能の型情報。`ES2022` は `Map` や `Promise` など言語の標準機能、`DOM` は `document` や `WebSocket`、`RTCPeerConnection` などブラウザの機能、`DOM.Iterable` は画面の要素の一覧を `for…of` で回せるようにするもの |
| `"types": ["vite/client"]` | 読み込む追加の型情報を、Vite のものだけに絞る。`main.ts` の `import './style.css'` のような、CSS を `import` する書き方を型チェックで許すために必要。ここで Node.js の型を読み込まないので、ブラウザ用のコードで Node.js の機能をうっかり使うとエラーになる |

```json
    "strict": true,
    "noEmit": true,
```

| 行 | 意味 |
|---|---|
| `"strict": true` | 厳しいチェックをまとめて有効にする。特に重要なのは「`null` や `undefined` になるかもしれない値を、確認せずに使うとエラー」というチェック。たとえば `document.getElementById()` は要素が見つからないと `null` を返すので、そのままでは使えない |
| `"noEmit": true` | `tsc` は型のチェックだけを行い、JavaScript ファイルを出力しない。JavaScript への変換は Vite と Node.js に任せている |

```json
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
```

この3つは、**「型を取り除くだけで実行できる」状態を保つ**ための設定です。Node.js の `--experimental-strip-types` は、型の部分を空白に置き換えるだけの単純な仕組みなので、それで壊れない書き方に制限しています。

| 行 | 意味 |
|---|---|
| `"allowImportingTsExtensions"` | `import … from './base32.ts'` のように、拡張子 `.ts` を付けた `import` を許す。Node.js は拡張子を書き換えてくれないので、実在するファイル名 `.ts` をそのまま書く必要がある |
| `"verbatimModuleSyntax"` | 型だけを `import` するときは `type` を付けることを強制する。例：`import { startHost, type Controller } from './connection.ts'`。型は実行時に存在しないので、`type` の印があれば、型を取り除くときにその `import` ごと消せる |
| `"erasableSyntaxOnly"` | 「取り除くだけでは済まない」TypeScript 独自の書き方を禁止する。たとえば `enum`（列挙型）は実行時のコードを生み出すので使えない。このプロジェクトで `enum` の代わりに `'waiting' \| 'connecting'` のような文字列の型を使っているのはこのため |

```json
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true
  },
  "include": ["src", "vite.config.ts"]
}
```

| 行 | 意味 |
|---|---|
| `"noUnusedLocals"` | 使っていない変数があるとエラーにする（消し忘れを見つける） |
| `"noUnusedParameters"` | 使っていない引数があるとエラーにする |
| `"noFallthroughCasesInSwitch"` | `switch` 文で、`break` や `return` を書き忘れて次の `case` に流れ込むとエラーにする |
| `"skipLibCheck"` | `node_modules` の中の型定義ファイル自体はチェックしない（時間短縮のため） |
| `"include"` | チェックの対象。`src/` と `vite.config.ts`。テストは含めない |

### `test/tsconfig.json`

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["."]
}
```

テスト用の設定です。

| 行 | 意味 |
|---|---|
| `"extends"` | 親の `tsconfig.json` の設定をすべて引き継ぐ |
| `"types": ["node"]` | 引き継いだ設定のうち、ここだけ上書きする。テストは Node.js で動くので、Node.js の型（`node:test` など）を読み込む |
| `"include": ["."]` | このフォルダ（`test/`）を対象にする。テストが `import` している `src/` のファイルも、テスト用の設定でチェックされる |

**なぜ設定を2つに分けたのか**：1つにまとめて Node.js の型を読み込むと、ブラウザ用のコードでも Node.js の機能が使えるように見えてしまいます。そうすると、ブラウザでは動かないコードを書いても型チェックで気づけません。

---

## 4. `vite.config.ts`

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/direct-share/',
});
```

| 行 | 意味 |
|---|---|
| 1行目 | Vite から `defineConfig` 関数を取り込む。この関数は受け取った設定をそのまま返すだけだが、通すことでエディターが設定項目の候補や型エラーを表示してくれる |
| `export default` | このファイルの「代表の値」として設定を外に渡す。Vite はこのファイルを読み込み、`default` の値を設定として使う |
| `base: '/direct-share/'` | サイトが置かれるパス。GitHub Pages では `https://pecology.github.io/direct-share/` のように、リポジトリ名のフォルダの下に公開される。これを指定すると、ビルド後の HTML の中の JS・CSS へのリンクが `/direct-share/assets/…` になる。指定しないと `/assets/…` を探しに行って、ファイルが見つからなくなる |

開発サーバーでも同じパスになるので、手元では `http://localhost:5173/direct-share/` で開きます。

---

## 5. `index.html`

ページの骨組みです。**すべての画面をあらかじめ HTML に書いておき、JavaScript で表示・非表示を切り替える**方式です。ページの移動はしません（要件 8.1）。

### 5-1. `<head>`（1〜11行目）

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
```

| 行 | 意味 |
|---|---|
| `<!doctype html>` | 最新の HTML の仕様で解釈するようブラウザに伝える |
| `lang="ja"` | ページの言語は日本語。読み上げソフトの発音や、フォントの選び方に影響する |
| `charset="UTF-8"` | 文字コード。日本語を正しく表示するため |

```html
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
```

スマホでの表示のしかたを決める行です。

| 値 | 意味 |
|---|---|
| `width=device-width` | 画面の幅を端末の実際の幅に合わせる。これがないと、スマホはPC向けの広い画面を縮小して表示してしまう |
| `initial-scale=1` | 最初の拡大率を等倍にする |
| `viewport-fit=cover` | iPhone の画面の切り欠き（ノッチ）や角の丸い部分まで使って表示する。かわりに、CSS の `env(safe-area-inset-top)` などで、切り欠きに隠れないよう余白を取っている |
| `interactive-widget=resizes-content` | スマホで画面上のキーボードが出たとき、ページの表示領域を縮める。これにより、画面下部に固定した入力欄がキーボードに隠れない |

```html
    <meta name="referrer" content="no-referrer" />
    <meta name="theme-color" content="#f5f6f8" />
```

| 行 | 意味 |
|---|---|
| `referrer` | チャットに表示されたリンクを開いたとき、リンク先に「どのページから来たか」（リファラー）を送らない。direct-share を使っていることを外部のサイトに知らせないため。なお、URL の `#` 以降はもともとリファラーに含まれないので、接続コードが漏れることはない |
| `theme-color` | スマホのブラウザで、アドレスバーなどの色をページの背景色に合わせる |

```html
    <link rel="icon" href="data:image/svg+xml,…" />
    <title>direct-share</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
```

| 行 | 意味 |
|---|---|
| `rel="icon"` | ブラウザのタブに出るアイコン。画像ファイルを別に用意せず、SVG（図形を文字で記述する画像形式）を URL の中に直接埋め込んでいる（`data:` URL）。`%3C` は `<`、`%23` は `#` を URL 用に置き換えたもの |
| `<title>` | タブに表示されるページ名 |
| `rel="stylesheet"` | CSS の読み込み。**ただし、これは不要な行です。** `main.ts` の1行目でも `import './style.css'` で同じ CSS を読み込んでいます。ビルドすると Vite が1つにまとめるので公開版では問題になりませんが、開発サーバーでは同じ CSS が2回読み込まれます（見た目には影響しない）。どちらか一方で十分なので、`index.html` 側を消すのが Vite の一般的な書き方です |

### 5-2. 画面の共通ルール

`<body>` の中には5つの画面と、設定ダイアログ、トースト（画面下に一時的に出るお知らせ）があります。

```html
<section id="screen-wait" class="screen card-screen" hidden>
```

- **`id="screen-○○"`**：JavaScript が画面を見分けるための名前です。`main.ts` の `show('wait')` は、`id` が `screen-wait` の画面だけを表示し、他を非表示にします。
- **`class="screen"`**：「これは画面の1つ」という印です。`show()` はこのクラスを持つ要素をすべて調べます。
- **`hidden`**：最初は全画面を非表示にしておき、起動時の処理で必要な画面だけを表示します。

JavaScript から要素を探すための印として、`data-` で始まる独自の属性も使っています。

| 印 | 付いている場所 | 使い道 |
|---|---|---|
| `data-status` | 各画面の左上の状態表示 | `setStatus()` が、全画面の状態表示を一度に「待機中」「接続済み」などに書き換える |
| `data-open-settings` | 待機画面と参加画面の歯車ボタン | 2つあるので `id` ではなく共通の印にし、両方に同じ処理を付ける |

### 5-3. 待機画面（13〜35行目）

```html
      <header class="bar">
        <span class="status" data-status></span>
        <button type="button" class="icon-btn" data-open-settings aria-label="設定">
          <svg viewBox="0 0 24 24" aria-hidden="true">…</svg>
        </button>
      </header>
```

| 部分 | 意味 |
|---|---|
| `<span class="status" data-status>` | 左上の「● 待機中」。中身は空で、JavaScript が文字を入れる |
| `type="button"` | 「ただのボタン」であることを明示する。`<form>` の中のボタンは、何も書かないと「送信ボタン」になってしまうため、ボタンには常に `type` を書いている |
| `aria-label="設定"` | 歯車アイコンには文字がないので、読み上げソフト向けに「設定」という名前を付ける |
| `aria-hidden="true"` | アイコンの図形自体は読み上げ不要なので、読み上げの対象から外す |

```html
      <div class="card">
        <p class="lead">相手の端末で読み取るか、<br />コードを入力してください</p>
        <div id="qr" class="qr"></div>
        <p id="code" class="code" aria-label="接続コード"></p>
```

| 要素 | 中身を入れる処理（`main.ts` の `startHosting()`） |
|---|---|
| `#qr` | QRコードの SVG 画像を入れる |
| `#code` | 接続コード（`7K3Q-M9XA-…`）を入れる |

```html
        <div class="row">
          <button type="button" class="btn" id="copy-code">コードをコピー</button>
          <button type="button" class="btn" id="copy-url">URLをコピー</button>
        </div>
        <p class="expiry"><span id="expiry"></span><button type="button" class="link-btn" id="refresh">更新</button></p>
```

- `#copy-code`、`#copy-url`：クリックすると、接続コードまたは URL をクリップボードにコピーします。
- `#expiry`：「残り 9:32」の表示。1秒ごとに書き換えます。
- `#refresh`：接続情報を作り直すボタン。

```html
        <p id="broker-note" class="note" hidden>ブローカー設定を変更しているため、…</p>
        <p id="broker-error" class="error-text" hidden>MQTTブローカーに接続できません。…</p>
        <p id="joining" class="joining" hidden><span class="spinner small"></span>相手と接続中…</p>
      </div>
      <button type="button" class="join-link" id="go-join">この端末から参加する <span aria-hidden="true">→</span></button>
    </section>
```

状況に応じて表示するメッセージです。最初はすべて `hidden` で隠しています。

| 要素 | 表示する条件 |
|---|---|
| `#broker-note` | ブローカーの設定をデフォルトから変えているとき（要件 F-76） |
| `#broker-error` | 設定したブローカーのどれにも接続できなかったとき |
| `#joining` | ゲストから参加要求が届き、接続を進めているとき。`spinner` はくるくる回る印 |

`→` を `aria-hidden` で囲んでいるのは、読み上げソフトが「右矢印」と読まないようにするためです。

### 5-4. 参加画面（37〜51行目）

```html
      <form class="card" id="join-form" novalidate>
        <label for="join-input" class="lead">接続コードまたはURL</label>
        <input id="join-input" class="code-input" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" />
        <p id="join-error" class="error-text" role="alert"></p>
        <button type="submit" class="btn primary wide">接続</button>
      </form>
```

| 部分 | 意味 |
|---|---|
| `<form>` | 入力欄とボタンを `<form>` で囲むと、入力欄で Enter を押したときにも「送信」が起きる。`main.ts` はこの送信を受け取って接続処理を始める |
| `novalidate` | ブラウザが標準で行う入力チェックを使わない。チェックは自分のコード（`parseInput()`）で行い、日本語で分かりやすいエラーを出すため |
| `<label for="join-input">` | 入力欄の見出し。`for` で入力欄と結びつけると、見出しをクリックしても入力欄にカーソルが入る |
| `autocomplete="off"` | ブラウザが過去の入力を候補として出さないようにする（接続コードは毎回違うため） |
| `autocapitalize="characters"` | スマホのキーボードを最初から大文字入力にする |
| `spellcheck="false"` | スペルミスの赤い波線を出さない |
| `placeholder` | 空のときに薄く表示する入力例 |
| `role="alert"` | ここに文字が入ったとき、読み上げソフトがすぐに読み上げる（エラーの通知） |
| `type="submit"` | 押すとフォームを送信するボタン |

### 5-5. 接続中画面・エラー画面（53〜75行目）

```html
    <section id="screen-connecting" class="screen card-screen" hidden>
      <header class="bar"><span class="status" data-status></span></header>
      <div class="card center">
        <div class="spinner"></div>
        <p class="lead">接続中…</p>
        <button type="button" class="link-btn" id="connecting-cancel">やめる</button>
      </div>
    </section>
```

ゲストとして接続している間の画面です。`#connecting-cancel` で接続をやめて参加画面に戻ります。

```html
    <section id="screen-error" class="screen card-screen" hidden>
      …
        <p class="lead">接続できませんでした</p>
        <p id="error-reason" class="error-text"></p>
        <ul id="error-hints" class="hints"></ul>
        <div class="row">
          <button type="button" class="btn primary" id="retry">再試行</button>
          <button type="button" class="btn" id="reinput">入力し直す</button>
        </div>
      …
```

| 要素 | 中身 |
|---|---|
| `#error-reason` | 原因（「相手からの応答がありません。」など）。`showError()` が入れる |
| `#error-hints` | 対処法の箇条書き。`<li>` を JavaScript で作って入れる |
| `#retry` | 同じ接続コードでもう一度接続する |
| `#reinput` | 参加画面に戻る |

### 5-6. メイン画面（77〜93行目）

```html
    <section id="screen-main" class="screen chat" hidden>
      <header class="bar chat-bar">
        <span class="status" data-status></span>
        <button type="button" class="btn danger small" id="disconnect">切断</button>
      </header>
      <ol id="history" class="history" aria-live="polite"></ol>
```

| 要素 | 意味 |
|---|---|
| `#disconnect` | 切断ボタン |
| `<ol id="history">` | 送受信の履歴。`<ol>` は順番のあるリスト。吹き出し1つが `<li>` 1つで、JavaScript で追加していく |
| `aria-live="polite"` | 中身が増えたとき、読み上げソフトが「今読んでいるものを読み終えてから」新しい内容を読み上げる |

```html
      <form id="composer" class="composer">
        <label class="icon-btn attach" aria-label="ファイルを選択">
          <svg …>…</svg>
          <input type="file" id="file-input" multiple hidden />
        </label>
        <textarea id="text-input" rows="1" placeholder="テキストを入力…" enterkeyhint="enter"></textarea>
        <button type="submit" class="btn primary send">送信</button>
      </form>
      <div id="drop-overlay" class="drop-overlay" hidden><p>ドロップして送信</p></div>
    </section>
```

| 部分 | 意味 |
|---|---|
| `<label>` で `<input type="file">` を囲む | 標準のファイル選択欄は見た目を変えにくいので、非表示（`hidden`）にしておく。`<label>` の中の入力欄は、`<label>` をクリックしたときに反応するので、クリップのアイコンを押すとファイル選択が開く。JavaScript なしで実現できる |
| `multiple` | 複数のファイルを一度に選べるようにする（要件 F-44） |
| `<textarea rows="1">` | 複数行の入力欄。最初は1行の高さで、入力に合わせて JavaScript で高さを広げる |
| `enterkeyhint="enter"` | スマホのキーボードの Enter キーを「改行」の表示にする。スマホでは Enter は改行で、送信は送信ボタンで行う仕様のため（要件 8.5） |
| `#drop-overlay` | ファイルをドラッグしてページに重ねたときに出す「ドロップして送信」の表示 |

### 5-7. 設定ダイアログ・トースト・スクリプト（95〜116行目）

```html
    <dialog id="settings" class="settings">
      <form id="settings-form" method="dialog">
        <h2>外部サーバー設定</h2>
        <label for="set-stun">STUNサーバー（1行1URL、5件まで）</label>
        <textarea id="set-stun" rows="3" spellcheck="false"></textarea>
        <label for="set-mqtt">MQTTブローカー（1行1URL、5件まで）</label>
        <textarea id="set-mqtt" rows="4" spellcheck="false"></textarea>
        <ul id="settings-errors" class="error-text"></ul>
        <div class="row end">
          <button type="button" class="btn" id="settings-reset">デフォルトに戻す</button>
          <span class="spacer"></span>
          <button type="button" class="btn" id="settings-close">閉じる</button>
          <button type="button" class="btn primary" id="settings-save">保存</button>
        </div>
      </form>
    </dialog>
```

| 部分 | 意味 |
|---|---|
| `<dialog>` | ブラウザ標準のダイアログ。JavaScript で `showModal()` を呼ぶと、背景を暗くして手前に表示し、背景を操作できなくする。Esc キーで閉じる機能も標準で付いている |
| `method="dialog"` | このフォームを送信すると、ページ移動ではなくダイアログが閉じる。ただし、ボタンはすべて `type="button"` にして自動では送信しないようにし、閉じるかどうかは JavaScript で決めている（入力にエラーがあれば閉じない、など） |
| `#settings-errors` | 入力値の形式エラーを表示する場所 |
| `<span class="spacer">` | 空の要素。CSS で横に伸ばし、「デフォルトに戻す」を左端、「閉じる」「保存」を右端に寄せるために使う |

```html
    <div id="toast" class="toast" role="status" hidden></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

| 行 | 意味 |
|---|---|
| `#toast` | 「コピーしました」などを画面下に数秒間表示する場所。`role="status"` で、読み上げソフトにも控えめに伝える |
| `<script type="module" src="/src/main.ts">` | アプリの入口。`type="module"` で ES モジュールとして読み込む（`import` が使える）。ブラウザは `.ts` を直接は実行できないが、開発中は Vite がその場で JavaScript に変換して返し、ビルド時には `/direct-share/assets/index-…js` のようなまとめたファイルへの参照に書き換えられる |

`<script>` が `<body>` の最後にあり、しかも `type="module"` なので、HTML の要素がすべて読み込まれてから実行されます。そのため `main.ts` はいきなり `document.getElementById(…)` で要素を取得できます。

---

## 6. 動かして確認

### 6-1. 開発サーバーを動かす

```bash
npm run dev
```

`http://localhost:5173/direct-share/` を開きます。

1. ブラウザの開発者ツールを開き（F12）、「Elements」タブを見ます。
2. `<section id="screen-wait" …>` だけ `hidden` が付いていないことを確認します。
3. 「この端末から参加する」を押し、`hidden` の付いている画面が入れ替わることを確認します。

### 6-2. 型エラーを起こしてみる

1. `src/main.ts` を開き、`setStatus('waiting');` と書かれている行を探します（`startHosting` 関数の中）。
2. `'waiting'` を `'online'` に書き換えて保存します。
3. 次のコマンドを実行します。

```bash
npm run typecheck
```

`Argument of type '"online"' is not assignable to parameter of type 'StatusName'.`（`"online"` という値は `StatusName` 型の引数には渡せない）のようなエラーが出るはずです。`setStatus` は `'waiting' | 'connecting' | 'connected' | 'disconnected'` のどれかしか受け付けないよう型が付いているためです。

4. このとき、開発サーバーの画面はどうなっているか見てください。Vite は型を取り除くだけでチェックしないので、エラーがあっても画面は表示され、状態表示が空欄になります。**「型チェックと型の除去は別」**がこれで確認できます。
5. 確認したら `'waiting'` に戻してください。

### 6-3. ビルドの結果を見る

```bash
npm run build
```

`dist/` フォルダが作られます。`dist/index.html` を開くと、`<script src="/src/main.ts">` が `/direct-share/assets/index-…js` に書き換わっていることを確認してください。

---

## 7. 理解チェック

1. `npm run dev` で開いたページで型エラーがあっても画面が表示されるのはなぜですか。
2. `package.json` に `dependencies` がないことは、何を意味しますか。
3. `vite.config.ts` の `base: '/direct-share/'` を消すと、GitHub Pages ではどうなりますか。
4. `import { startHost, type Controller } from './connection.ts'` の `type` は、何のために付けていますか。
5. 参加画面の入力欄で Enter を押すと接続処理が始まるのは、HTML のどの書き方のおかげですか。

<details>
<summary>答え</summary>

1. Vite（開発サーバー）は型を取り除いて JavaScript にするだけで、型チェックはしないため。型チェックは `tsc`（`npm run typecheck`）が別に行う。
2. 公開されたページが実行時に使う外部ライブラリが1つもないこと。Vite や TypeScript は開発時だけ使う `devDependencies`。
3. ビルド後の HTML が JS・CSS を `/assets/…` に探しに行く。実際のファイルは `/direct-share/assets/…` にあるので見つからず、ページが真っ白になる（スタイルも処理も読み込まれない）。
4. `Controller` は型で、実行時には存在しない。`type` の印があると、型を取り除くとき（Vite や Node.js）にこの部分を安全に消せる。`tsconfig.json` の `verbatimModuleSyntax` で、この印を付けることを強制している。
5. 入力欄と送信ボタンを `<form>` で囲んでいること。入力欄で Enter を押すとフォームの送信（`submit`）が起き、`main.ts` がそれを受け取る。

</details>

---

次回（第1回）は `src/base32.ts` を読みます。接続コードの16文字が、80ビットの秘密値とどう対応しているかを、ビット演算と一緒に見ていきます。
