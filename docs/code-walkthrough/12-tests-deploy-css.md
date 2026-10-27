# 第12回 テスト、デプロイ、`style.css` の要点

最終回は、アプリの本体を支える3つを読みます。

| 対象 | 内容 |
|---|---|
| `test/codec.test.ts`、`test/session.test.ts` | 部品が正しく動くことを自動で確かめるテスト |
| `.github/workflows/deploy.yml` | GitHub に push すると、テストして公開するまでを自動で行う設定 |
| `src/style.css` | 見た目。全行ではなく、動作に関わる要点だけを読む |

---

## 1. 前提知識

### 1-1. 自動テスト

自動テストは、「この関数にこれを渡したら、これが返るはず」をコードで書いておき、まとめて実行して確かめる仕組みです。コードを変更したときに、前に動いていたものが壊れていないか（デグレード）をすぐに確かめられます。

このプロジェクトでは、Node.js に標準で付いているテストの機能を使っています（外部のテストライブラリは使っていません）。

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('1 + 1 は 2', () => {
  assert.equal(1 + 1, 2);       // 等しくなければ、テストは失敗
});
```

| 書き方 | 意味 |
|---|---|
| `test(名前, 関数)` | テストを1つ定義する。関数の中で例外が起きなければ成功 |
| `assert.equal(a, b)` | `a` と `b` が等しいことを確かめる |
| `assert.deepEqual(a, b)` | 配列やオブジェクトの**中身**が等しいことを確かめる |
| `assert.ok(x)` | `x` が真とみなされることを確かめる |
| `assert.match(文字列, 正規表現)` | 文字列が正規表現に当てはまることを確かめる |
| `assert.throws(関数)` | 関数が例外を投げることを確かめる |
| `assert.fail(メッセージ)` | その場で失敗させる |

`node:` で始まる名前は、Node.js に組み込まれた部品です。

### 1-2. 偽物の部品（モック）

`session.ts` は WebRTC のデータチャネルを使いますが、Node.js には WebRTC がありません。そこで、**データチャネルと同じ使い方ができる偽物**を作り、それを渡してテストします。偽物はモック（mock）やフェイク（fake）と呼ばれます。

`Session` は、データチャネルの `send()`、`bufferedAmount`、`onmessage` など、ごく一部の機能しか使っていません。その部分だけを持つ偽物を作れば、`Session` は本物と区別がつかずに動きます。

### 1-3. CI/CD と GitHub Actions

| 用語 | 意味 |
|---|---|
| CI（継続的インテグレーション） | コードを変更するたびに、自動でテストやビルドを行うこと |
| CD（継続的デリバリー／デプロイ） | テストに通ったものを、自動で公開すること |
| GitHub Actions | GitHub が提供する CI/CD の仕組み。リポジトリの `.github/workflows/` に YAML ファイルを置くと、GitHub のサーバーで実行される |

### 1-4. YAML

設定ファイルによく使われる書き方です。字下げ（スペース）で階層を表します。

```yaml
キー: 値
親:
  子: 値
リスト:
  - 1つ目
  - 2つ目
```

---

## 2. `test/codec.test.ts`

第1〜4回、第11回の部品のテストです。それぞれの解説の「動かして確認」で、テストの内容に触れてきました。ここでは書き方の要点だけを見ます。

```ts
test('base32 は往復できて16文字になる', () => {
  for (let i = 0; i < 200; i++) {
    const secret = randomSecret();
    const code = encodeBase32(secret);
    assert.equal(code.length, 16);
    assert.deepEqual(decodeBase32(code), secret);
  }
});
```

**ランダムな入力で200回試しています。** 特定の例だけでなく、いろいろな値で「変換して戻すと元に戻る」ことを確かめる書き方です。

```ts
  const fromUrl = parseInput(url);
  if (fromUrl.error !== undefined) assert.fail(fromUrl.error);
  assert.deepEqual(fromUrl.secret, secret);
```

`parseInput()` の結果は、成功か失敗かのユニオン型です（第2回）。`assert.fail()` は必ず例外を投げるので、TypeScript は「この `if` を抜けた後は成功の形」と分かり、次の行で `secret` を使えます。`assert.ok(!fromUrl.error)` と書くと、この絞り込みが効かず、型エラーになります。

```ts
  ct[20] ^= 1;
  assert.equal(await decryptMessage(room, ct), null);
```

暗号文の1ビットを反転させて、改ざんとして検知されることを確かめています（第4回）。

```ts
  assert.throws(() => encodeQr('x'.repeat(3000)));
```

QR コードに入りきらない長さで、例外が投げられることを確かめています（第11回）。

---

## 3. `test/session.test.ts`

### 3-1. 偽のデータチャネル（5〜37行目）

```ts
/** 2つのセッションを直結する偽のデータチャネル */
class FakeChannel extends EventTarget {
  peer!: FakeChannel;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState = 'open';
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
```

| 部分 | 説明 |
|---|---|
| `extends EventTarget` | `EventTarget` を引き継ぐ。`addEventListener` や `dispatchEvent` が使えるようになる。`Session` は `bufferedamountlow` イベントを `addEventListener` で待つため |
| `peer!: FakeChannel` | 相手側の偽物。`!` は「コンストラクターでは値を入れないが、使う前に必ず入れる」と TypeScript に伝える書き方（後で `a.peer = b` と入れる） |
| その他のプロパティ | `Session` が読み書きする、本物のデータチャネルのプロパティと同じ名前 |

```ts
  send(data: string | ArrayBuffer) {
    const copy = typeof data === 'string' ? data : data.slice(0);
    const size = typeof data === 'string' ? data.length : data.byteLength;
    this.bufferedAmount += size;
    setTimeout(() => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= size;
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.dispatchEvent(new Event('bufferedamountlow'));
      }
      this.peer.onmessage?.({ data: copy });
    });
  }
```

本物のデータチャネルの「送信バッファ」を真似ています。

| 行 | 説明 |
|---|---|
| 16 | バイナリはコピーしてから渡す。本物も、送ったデータは相手側では別のデータになるため |
| 18 | 送信バッファの量を増やす |
| 19 | `setTimeout`（待ち時間なし）で、今の処理が終わった後に、届ける処理を行う。本物と同じく、`send()` はすぐに戻り、相手には後で届く |
| 20〜24 | 送信バッファを減らし、境目を下回ったら `bufferedamountlow` イベントを起こす |
| 25 | 相手側の `onmessage` を呼んで、届ける |

**この送信バッファの真似は、最初の版にはありませんでした。** バッファが常に0だと、送信側は一瞬で全部を送り終えてしまい、「送信中のファイルをキャンセルする」テストで、キャンセルする前に受信が終わって失敗しました。送信バッファを真似たことで、第8回の流量の調整（4MB で止まり、1MB で再開）も、テストの中で実際に動くようになりました。

```ts
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    setTimeout(() => {
      this.peer.close();
      this.peer.onclose?.();
    });
  }
}
```

閉じると、少し後で相手側も閉じ、相手側の `onclose` を呼びます。相手側の `close()` も同じ処理を行うので、自分の `onclose` も呼ばれます。本物でも、片方が閉じると両側で `close` イベントが起きます。

```ts
const fakePc = () => ({ sctp: null, connectionState: 'connected', addEventListener() {}, close() {} });
```

偽の `RTCPeerConnection` です。`Session` が使う `sctp`、`connectionState`、`addEventListener`、`close` だけを持ち、何もしません。

### 3-2. テストの準備（41〜64行目）

```ts
function pair() {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  …
  const make = (dc: FakeChannel, side: 'a' | 'b') =>
    new Session(fakePc() as unknown as RTCPeerConnection, dc as unknown as RTCDataChannel, { … });
  return { sa: make(a, 'a'), sb: make(b, 'b'), notices, closed };
}
```

2つの偽物を互いにつなぎ、それぞれに `Session` を作ります。`as unknown as RTCDataChannel` で、偽物を本物の型とみなして渡しています（型の上では本物と違うので、直接は渡せない）。通知の内容と、終了の理由を記録しておき、テストで確かめます。

```ts
async function until(cond: () => boolean) {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'timeout');
}
```

条件が満たされるまで、5ミリ秒ごとに調べて待ちます。最大2000回（10秒）待っても満たされなければ、失敗にします。届くタイミングが決まっていない非同期の処理を、テストで待つための小道具です。

```ts
const files = (s: Session) => [...s.items.values()].filter((i: Item): i is FileItem => i.kind === 'file');
```

`(i: Item): i is FileItem => …` は**型の述語**です。「この関数が `true` を返したら、`i` は `FileItem`」と TypeScript に伝えます。これで、`filter` の結果の型が `Item[]` ではなく `FileItem[]` になります。

### 3-3. テストの内容

各テストの内容は、第9回 4-1 の表のとおりです。1つだけ詳しく見ます。

```ts
test('受信側の空きが足りなければ保存済みを解放し、それでも足りなければ拒否する', async () => {
  const { sa, sb, notices } = pair();
  const big = (name: string) => new File([new Uint8Array(MAX_HELD_BYTES * 0.6)], name);
  sa.sendFiles([big('1.bin')]);
  await until(() => byName(sb, '1.bin')?.status === 'received');

  // 未保存のままだと拒否される
  sa.sendFiles([big('2.bin')]);
  await until(() => byName(sa, '2.bin')?.status === 'rejected');
  assert.equal(byName(sb, '2.bin')?.status, 'rejected');
  assert.ok(notices.a.includes(NO_SPACE_MESSAGE));
  assert.ok(notices.b.includes(NO_SPACE_MESSAGE));

  // 保存済みにすると古い順に自動で解放されて受信できる
  sb.markSaved(byName(sb, '1.bin')!.id);
  sa.sendFiles([big('3.bin')]);
  await until(() => byName(sb, '3.bin')?.status === 'received');
  assert.equal(byName(sb, '1.bin')?.status, 'released');
});
```

要件 F-51 の3つの場面（保持する、拒否して両側に知らせる、保存済みを解放して受け取る）を、1つの流れで確かめています。上限の60% のファイルを使うので、2つは入らず、1つなら入ります。

`byName(sb, '1.bin')!.id` の `!` は、「`undefined` ではない」と TypeScript に伝える書き方です（非 null アサーション）。直前の `until` で受信済みを確かめているので、必ずあります。

### 3-4. 実行のしかた

```bash
npm test
```

`package.json` の `test` スクリプト（第0回）で、Node.js が `.ts` の型を取り除いて実行します。型チェックはしないので、別に `npm run typecheck` を実行します。テスト用の型チェックは `test/tsconfig.json` の設定で行われ、Node.js の型（`node:test` など）が使えます。

---

## 4. `.github/workflows/deploy.yml`

`main` ブランチに push すると、GitHub のサーバーで、テストからデプロイまでが自動で行われます。

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:
```

| 部分 | 意味 |
|---|---|
| `name` | GitHub の Actions タブに表示される名前 |
| `on.push.branches: [main]` | `main` ブランチに push されたら実行する |
| `workflow_dispatch` | Actions タブのボタンから、手動でも実行できるようにする |

```yaml
permissions:
  contents: read
  pages: write
  id-token: write
```

このワークフローに与える権限です。必要なものだけを与えます。

| 権限 | 理由 |
|---|---|
| `contents: read` | リポジトリのコードを読む |
| `pages: write` | GitHub Pages に公開する |
| `id-token: write` | 公開のときに、このワークフローが本物であることを GitHub に証明するための一時的な証明書（OIDC トークン）を受け取る |

```yaml
concurrency:
  group: pages
  cancel-in-progress: true
```

続けて push したとき、前の実行がまだ終わっていなければ、それを取り消して新しい方だけを実行します。古い版が後から公開されて、新しい版を上書きしてしまうのを防ぎます。

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
```

**build ジョブ**：Ubuntu（Linux）の仮想マシンで、上から順に実行します。どこかで失敗すると、そこで止まり、公開されません。

| 手順 | 意味 |
|---|---|
| `actions/checkout@v4` | リポジトリのコードを取ってくる |
| `actions/setup-node@v4` | Node.js 22 を用意する。`cache: npm` で、ダウンロードしたパッケージを次回のために保存し、速くする |
| `npm ci` | `package-lock.json` のとおりに、正確に同じ版のパッケージをインストールする。`npm install` と違い、lock ファイルを書き換えない |
| `npm run typecheck` | 型チェック |
| `npm test` | テスト |
| `npm run build` | `dist/` にビルド |
| `actions/upload-pages-artifact@v3` | `dist/` を、公開用の成果物としてアップロードする |

`uses:` は、他の人が作った手順（アクション）を使う書き方で、`run:` はコマンドを実行する書き方です。`@v4` はアクションの版です。

```yaml
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

**deploy ジョブ**：build ジョブが成功した後（`needs: build`）に実行し、アップロードした成果物を GitHub Pages に公開します。`environment` で、公開先の URL を Actions の画面に表示します。`${{ … }}` は、実行中の値を埋め込む書き方です。

### 気づいた点

- **型チェックを2回行っています。** `npm run build` の中でも `npm run typecheck` を実行する（第0回）ので、`npm run typecheck` の手順は省いても結果は同じです。失敗したときに、型チェックで失敗したことが Actions の画面で分かりやすい、という利点はあります。
- **Node.js 20 は非推奨という警告が出ています。** `actions/checkout@v4` などが古い Node.js 向けに作られているためです。今は GitHub が自動で新しい Node.js で実行しているので、動作に影響はありません。それぞれのアクションの新しい版に上げれば、警告は消えます。

---

## 5. `src/style.css` の要点

604行のうち、見た目の細かな調整（色、余白、角の丸み）は省き、動作や考え方に関わる部分だけを読みます。

### 5-1. 色などを変数にまとめる

```css
:root {
  --accent: #2563eb;
  --bg: #f5f6f8;
  --bubble-peer: #eceef1;
  …
  color-scheme: light;
}
```

`--` で始まるのは CSS の変数（カスタムプロパティ）で、`var(--accent)` で使います。アクセントカラーを1か所にまとめているので、ここを変えるだけで、自分の吹き出しやボタンの色がすべて変わります（要件 8.5：アクセントカラーは1色）。

`color-scheme: light` は、このページが明るい配色だけに対応していることをブラウザに伝えます。端末がダークモードでも、入力欄などの標準の部品が暗い色にならず、ページの配色と合います。

### 5-2. `[hidden]` を必ず効かせる（36行目）

```css
[hidden] {
  display: none !important;
}
```

`hidden` 属性の付いた要素を非表示にします。ブラウザは標準でも `hidden` を非表示にしますが、**CSS で `display: flex` などを指定した要素では、そちらが優先されて表示されてしまいます。** たとえば各画面は `.card-screen { display: flex; }` なので、この行がないと `hidden` を付けても消えません。`!important` で、`hidden` を常に優先させています。

`main.ts` の画面の切り替え（`el.hidden = …`）は、この1行に頼っています。

### 5-3. スマホの画面の高さと、切り欠き

```css
.screen {
  min-height: 100dvh;
}

.bar {
  padding-top: max(8px, env(safe-area-inset-top));
}
```

| 部分 | 意味 |
|---|---|
| `100dvh` | 画面の高さ。`dvh` は「動的な画面の高さ」で、スマホのブラウザでアドレスバーが出たり引っ込んだりしても、実際に見えている高さになる。`vh` だと、アドレスバーの分だけはみ出すことがある |
| `env(safe-area-inset-top)` | iPhone の画面上部の切り欠き（ノッチ）の高さ。`index.html` の `viewport-fit=cover`（第0回）で画面の端まで使うようにしたので、切り欠きに隠れないよう余白を取る |
| `max(8px, …)` | 切り欠きがない端末では 8px |

画面下の入力欄（492行目）とトースト（588行目）も、同じように `safe-area-inset-bottom`（画面下のホームバーの高さ）の分だけ余白を取っています。

### 5-4. チャット画面のレイアウト（347〜360行目）

```css
.chat {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
}

.history {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
```

メイン画面を、上からヘッダー・履歴・入力欄の3段にし、**履歴だけがスクロールする**ようにしています（要件 8.5：入力エリアは下部に固定）。

| 部分 | 意味 |
|---|---|
| `display: flex; flex-direction: column` | 子要素を縦に並べる |
| `height: 100dvh` | 画面の高さちょうどにする |
| `.history { flex: 1 }` | 履歴が、ヘッダーと入力欄の残りの高さをすべて使う |
| `.history { overflow-y: auto }` | 中身があふれたら、履歴の中だけをスクロールする |
| `min-height: 0` | **これがないと、履歴がスクロールせずに伸びてしまう。** flex の子要素は、標準では「中身より小さくならない」ので、`min-height: 0` で縮むことを許す必要がある |

### 5-5. 吹き出し

```css
.msg {
  align-self: flex-start;
}
.msg.mine {
  align-self: flex-end;
}
.bubble {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
```

| 部分 | 意味 |
|---|---|
| `align-self: flex-start` / `flex-end` | 受信は左寄せ、自分の送信（`mine`）は右寄せ（要件 8.5） |
| `white-space: pre-wrap` | テキストの改行や連続した空白を、そのまま表示する（複数行のテキスト、要件 F-35）。HTML は標準では改行を空白1つにまとめてしまう |
| `overflow-wrap: anywhere` | 長い URL など、区切りのない長い文字列を、吹き出しの幅で折り返す。これがないと、吹き出しが画面からはみ出す |

自分の吹き出しは `.msg.mine .bubble` でアクセントカラーにし、相手は薄いグレー（`--bubble-peer`）にしています。片側の角だけ丸みを小さくして、吹き出しの「しっぽ」のように見せています。

### 5-6. 状態の点の色（76行目など）

```css
.status::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.status[data-state='connected'] {
  color: var(--ok);
}
```

| 部分 | 意味 |
|---|---|
| `::before` | 要素の中身の前に、飾りを1つ足す。ここでは丸い点 |
| `background: currentColor` | 点の色を、文字の色と同じにする |
| `[data-state='connected']` | `data-state` 属性が `connected` の要素。`main.ts` の `setStatus()` がこの属性を設定する |

文字の色を変えるだけで、点の色も一緒に変わります。

### 5-7. ドロップの表示（532行目）

```css
.drop-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
}
```

| 部分 | 意味 |
|---|---|
| `position: fixed; inset: 0` | 画面全体を覆う |
| `pointer-events: none` | マウスの操作やドラッグの対象にならず、下の要素に素通りさせる。これがないと、表示が出た瞬間に「ドラッグがこの表示の上に入った」とみなされ、`dragenter` と `dragleave` が余計に起きて、表示がちらつく |

### 5-8. 画面の幅で切り替える（600行目）

```css
@media (min-width: 720px) {
  .card-screen .card {
    margin-top: 6vh;
  }
}
```

画面の幅が 720px 以上（PC など）のとき、待機画面などのカードを少し下げて、画面の中央寄りに表示します。端末の種類ではなく、**画面の幅で切り替えています**（要件 U-03）。スマホを横にしたり、PC のウィンドウを狭くしたりしても、見た目が合います。

ほかにも、`width: min(440px, calc(100% - 32px))`（広い画面では 440px、狭い画面では左右 16px の余白を残した幅）のように、1つの指定で幅に合わせて変わる書き方を使っています。

### 5-9. 接続コードの文字の大きさ（277行目）

```css
.code {
  font-size: clamp(16px, 5.6vw, 30px);
  white-space: nowrap;
}
```

| 部分 | 意味 |
|---|---|
| `clamp(16px, 5.6vw, 30px)` | 画面の幅の 5.6%（`vw` は画面の幅の1%）の大きさにする。ただし 16px より小さく、30px より大きくはしない |
| `white-space: nowrap` | 折り返さない |

最初の版では、スマホの幅で接続コードが2行に折り返されていました。手入力するときに読みにくいので、画面の幅に合わせて文字を小さくし、1行に収めるように直しました。

### 5-10. 気づいた点

- **271行目の `image-rendering: pixelated` は効いていません。** これは画像を拡大するときのぼかし方の指定で、ベクター画像の SVG の図形には効きません。QR コードの輪郭をくっきりさせているのは、`qr.ts` が SVG に付けた `shape-rendering: crispEdges` です（第11回）。消しても見た目は変わりません。
- 第0回で触れたとおり、この CSS は `index.html` の `<link>` と `main.ts` の `import` の両方から読み込まれています。

---

## 6. 動かして確認

### 6-1. テストを壊してみる

1. `src/base32.ts` の2行目の `ALPHABET` で、`'Z'` と `'Y'` の順番を入れ替えます（`…WXZY'` にする）。
2. `npm test` を実行します。

結果は「12件すべて成功」になります（実際に試して確かめました）。変換と逆変換の両方が同じ `ALPHABET` を使うので、往復のテストでは見つからないためです。ただし、この状態では、以前のコードで作った接続コードと互換性がなくなり、別の版のページどうしではつながらなくなります。このように、**テストで確かめていないことは、壊れても気づけません。**

3. 次に、元に戻してから、`ALPHABET` の最後の `'Z'` を `'U'` に変えて（`…WXYU'` にする）、`npm test` を実行します。今度は `接続コード・URLを解釈する` の1件だけが失敗します。このテストは「`U` を含むコードは『使えない文字』のエラーになる」ことを確かめているので、`U` が使える文字になると、エラーが返らなくなるためです。
4. 確認したら、元に戻します。

```bash
git checkout -- src/base32.ts
```

### 6-2. CI の実行結果を見る

GitHub のリポジトリの「Actions」タブを開くと、push するたびに実行された結果の一覧があります。1つを開き、`build` → `npm test` の手順を開くと、テストの結果が表示されています。

### 6-3. `[hidden]` の1行を無効にしてみる

1. 開発サーバーで待機画面を開き、開発者ツールの「Elements」タブで `<section id="screen-join" …hidden>` を選びます。
2. 右側の「Styles」に、`style.css` の `[hidden] { display: none !important; }` が表示されています。左のチェックを外して、この指定を無効にします。
3. 非表示だった参加画面が、待機画面の下に表示されることを確かめてください。`.card-screen { display: flex; }` が、ブラウザ標準の「`hidden` なら非表示」より優先されるためです。
4. チェックを戻すと、また非表示になります（再読み込みでも元に戻ります）。

なお、CSS をまるごと無効にした場合は、`display: flex` の指定もなくなるので、ブラウザ標準の働きで `hidden` の画面は非表示のままです。問題が起きるのは、「自分で `display` を指定した要素」に `hidden` を付けたときだけ、ということが分かります。

---

## 7. 理解チェック

1. `session.test.ts` で、本物のデータチャネルの代わりに偽物を使っているのはなぜですか。
2. 偽のデータチャネルに、送信バッファの真似（`bufferedAmount` の増減）を入れたのはなぜですか。
3. `assert.ok(!result.error)` ではなく、`if (result.error !== undefined) assert.fail(…)` と書いているのはなぜですか。
4. ワークフローで、`npm install` ではなく `npm ci` を使うのはなぜですか。
5. `concurrency` の `cancel-in-progress: true` は、どんな問題を防ぎますか。
6. CSS の `[hidden] { display: none !important; }` がないと、どうなりますか。
7. 履歴の要素に `min-height: 0` がないと、どうなりますか。
8. ドロップの表示に `pointer-events: none` を付けているのはなぜですか。

<details>
<summary>答え</summary>

1. テストは Node.js で実行するが、Node.js には WebRTC がないため。`Session` が使う機能（`send()`、`bufferedAmount`、`onmessage` など）だけを持つ偽物を作れば、本物と同じように動かせる。
2. 送信バッファが常に0だと、送信側が一瞬で全部を送り終えてしまい、「送信中にキャンセルする」ような場面を作れなかったため。真似を入れたことで、流量の調整（4MB で止まり、1MB で再開）もテストの中で動くようになった。
3. `assert.fail()` は必ず例外を投げるので、TypeScript が「`if` を抜けた後は成功の形」と型を絞り込める。`assert.ok(!result.error)` では絞り込みが効かず、次の行で `result.secret` を使うと型エラーになる。
4. `package-lock.json` のとおりに、正確に同じ版のパッケージをインストールするため。手元と CI で違う版になって、結果が変わることを防ぐ。
5. 続けて push したとき、古い版の実行が後から終わって、新しい版の公開を上書きしてしまう問題。
6. `display: flex` などを指定した要素（各画面など）では、`hidden` 属性を付けても非表示にならず、すべての画面が同時に表示されてしまう。
7. flex の子要素は標準では中身より小さくならないので、履歴が中身に合わせて伸び、履歴の中でスクロールしなくなる。入力欄が画面の外に押し出されてしまう。
8. 表示がドラッグの対象になると、表示が出た瞬間に `dragenter` と `dragleave` が余計に起きて、表示がちらつくため。下の要素に操作を素通りさせている。

</details>

---

## おわりに

これで、direct-share のすべてのソースコードを読み終えました。最後に、全体のつながりをもう一度確かめておきましょう。

```
ページを開く（main.ts の633行目）
 │
 ├─ ホスト：startHosting()
 │    randomSecret()（crypto）→ secretToCode()・buildUrl()（connInfo・base32）
 │    → encodeQr()・qrToSvg()（qr）で QR を表示
 │    → startHost()（connection）
 │         → deriveRoom()（crypto）でトピック名と鍵
 │         → Signaling（signaling）→ MqttClient × 3（mqtt）で待つ
 │
 ├─ ゲスト：parseInput()・parseHash()（connInfo）→ startGuesting()
 │    → startGuest()（connection）→ 参加要求を送る
 │
 ├─ 両者：オファー・アンサー・ICE 候補を交換（暗号化して MQTT 経由）
 │    → WebRTC で直接接続 → データチャネルが開く → ブローカーから切断
 │
 └─ enterMain()：Session（session）でテキストとファイルを送受信
      → 切断したら履歴を破棄して、待機画面に戻る
```

それぞれの回の「気づいた点」には、今のコードで改善できそうな点も挙げています。コードを直してみたくなったら、まず関係するテストを読み、直した後に `npm test` と `npm run typecheck` で確かめる、という流れで進めると安全です。
