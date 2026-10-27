# 第10回 `src/main.ts`：画面と操作

`main.ts` は、アプリの**入口**です。`index.html` の最後の `<script>` で読み込まれ、ここまでの部品をすべて組み合わせて画面を動かします。

| 範囲 | 内容 |
|---|---|
| 1〜67行目 | 準備と、画面全体で使う小道具（画面の切り替え、トースト、コピー） |
| 69〜147行目 | ホスト（待機画面） |
| 149〜267行目 | ゲスト（参加・接続中・エラー画面） |
| 269〜522行目 | メイン画面（履歴の表示、送信、ドラッグ＆ドロップ） |
| 524〜569行目 | スリープ防止、ページを閉じるときの確認 |
| 571〜610行目 | 設定ダイアログ |
| 612〜633行目 | 起動 |

633行と長いですが、ほとんどは「部品を呼ぶ」「画面の要素を書き換える」処理です。第1〜9回の内容が分かっていれば、新しく覚えることは主に **DOM の操作**と**イベント**です。

---

## 1. 前提知識

### 1-1. DOM

ブラウザは HTML を読み込むと、要素を木の形のデータ（DOM）として持ちます。JavaScript から DOM を書き換えると、画面が変わります。

| 書き方 | 意味 |
|---|---|
| `document.getElementById('code')` | `id="code"` の要素を1つ取得する。なければ `null` |
| `document.querySelector('セレクター')` | CSS のセレクターに合う最初の要素を取得する |
| `document.querySelectorAll('セレクター')` | 合う要素をすべて取得する |
| `el.textContent = '文字'` | 要素の中身を文字に置き換える（HTML としては解釈しない） |
| `el.hidden = true` | 要素を非表示にする（`hidden` 属性） |
| `el.dataset.state = 'x'` | `data-state="x"` 属性を設定する |
| `document.createElement('li')` | 新しい要素を作る（まだ画面には出ていない） |
| `parent.append(子)` | 子要素を末尾に加える |
| `parent.replaceChildren(子…)` | 中身をすべて、指定した子要素に入れ替える。何も渡さなければ空にする |

**このファイルでは `innerHTML` を一度も使っていません。** `innerHTML` は文字列を HTML として解釈するので、相手から届いたテキストに `<script>` などが含まれていると、それが実行されてしまう危険があります（クロスサイトスクリプティング）。`textContent` と `createElement` だけで画面を作れば、届いた文字列は必ずただの文字として表示されます。

### 1-2. イベント

ユーザーの操作（クリック、キー入力など）や、状態の変化（ページを閉じる、画面が隠れるなど）が起きたときに、関数を呼んでもらう仕組みです。

```ts
button.addEventListener('click', () => { /* クリックされたら */ });
```

| よく使うイベント | 起きるとき |
|---|---|
| `click` | クリック・タップされた |
| `input` | 入力欄の値が変わった（1文字ごと） |
| `keydown` | キーが押された |
| `submit` | フォームが送信された（送信ボタン、または入力欄で Enter） |
| `change` | ファイル選択などで値が確定した |

フォームの `submit` は、何もしないとページの移動（再読み込み）を起こします。`e.preventDefault()` で、ブラウザの標準の動作を止めます。

### 1-3. 非同期処理の「追い越し」と世代番号

`startHost()` などは `async` 関数で、結果が出るまでに時間がかかります。その間にユーザーが別の操作をすると、**古い処理の結果が、後から届いてしまう**ことがあります。

```
待機画面を開く ── startHost() 開始 ─────────── 結果が届く（古い！）
                    ↑
       ユーザーが「参加する」を押す（もう待機画面ではない）
```

そこで、**世代番号**を使います。処理を始めるときに番号を控えておき、結果が届いたときに番号が変わっていたら、その結果は捨てます。

```ts
let gen = 0;
async function start() {
  gen++;
  const myGen = gen;            // 自分の世代を控える
  const result = await 時間のかかる処理();
  if (myGen !== gen) {          // その間に別の start() や stop() が呼ばれた
    result.close();             // 古い結果は捨てる
    return;
  }
  // 使う
}
function stop() { gen++; }      // 進行中の処理を無効にする
```

### 1-4. このファイルで新しく出てくる TypeScript の書き方

| 書き方 | 意味 |
|---|---|
| `<T extends HTMLElement = HTMLElement>` | 型の引数。`T` は `HTMLElement` の一種で、省略したら `HTMLElement` |
| `keyof HTMLElementTagNameMap` | `'div' \| 'button' \| 'li' \| …` のような、HTML のタグ名の一覧の型 |
| `FileItem['status']` | `FileItem` 型の `status` プロパティの型（`FileStatus` と同じ） |
| `querySelectorAll<HTMLElement>(…)` | 取得する要素の型を指定する |
| `e instanceof DOMException` | `e` が `DOMException`（ブラウザの API のエラー）かどうか |

---

## 2. 1行ずつの解説

### 1〜8行目：読み込み

```ts
import './style.css';
import { formatCode, normalizeCode } from './base32.ts';
import { buildUrl, looksLikeUrl, pageUrl, parseHash, parseInput, secretToCode } from './connInfo.ts';
import { startGuest, startHost, type Controller, type GuestFailReason } from './connection.ts';
import { randomId, randomSecret } from './crypto.ts';
import { encodeQr, qrToSvg } from './qr.ts';
import { Session, type FileItem, type Item } from './session.ts';
import { DEFAULTS, isDefaultMqtt, loadSettings, parseLines, resetSettings, saveSettings } from './settings.ts';
```

| 行 | 説明 |
|---|---|
| 1 | CSS を読み込む。Vite が CSS をページに適用してくれる（第0回で触れたとおり、`index.html` の `<link>` と重複している） |
| 2〜8 | すべての部品を読み込む。`main.ts` は、他のどのファイルからも読み込まれない「いちばん上」のファイル |

### 10〜29行目：定数と、画面全体の状態

```ts
const EXPIRY_MS = 10 * 60 * 1000; // F-06

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
```

| 行 | 説明 |
|---|---|
| 10 | 接続情報の有効期限：10分（ミリ秒） |
| 12 | `id` で要素を取得する短い関数 `$`。`$('code')` のように使う |

12行目の型について：`getElementById` の戻り値の型は `HTMLElement | null` です。`as T` で「必ずある、`T` 型の要素」とみなしています。`index.html` に必ずある `id` しか使わないので、`null` の確認を省いています。`$<HTMLInputElement>('join-input')` のように型を指定すれば、入力欄にしかない `.value` などが使えます。

```ts
type ScreenName = 'wait' | 'join' | 'connecting' | 'error' | 'main';
type StatusName = 'waiting' | 'connecting' | 'connected' | 'disconnected';

const STATUS_LABEL: Record<StatusName, string> = {
  waiting: '待機中',
  connecting: '接続中',
  connected: '接続済み',
  disconnected: '切断',
};
```

| 行 | 説明 |
|---|---|
| 14 | 画面の名前。`index.html` の `id="screen-○○"` の ○○ |
| 15 | 接続状態の名前（要件 F-22） |
| 17〜22 | 接続状態ごとの表示文字。`Record<StatusName, string>` なので、1つでも書き忘れると型エラーになる |

```ts
const hasKeyboard = matchMedia('(hover: hover) and (pointer: fine)').matches;
const isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
```

| 行 | 説明 |
|---|---|
| 24 | **物理キーボードがありそうか**の推定（要件 8.5）。`matchMedia` は CSS のメディアクエリを JavaScript で調べる関数。`hover: hover`（マウスを重ねられる）かつ `pointer: fine`（細かく指せる）なら、マウスとキーボードがある PC とみなす。スマホは指で操作するので、どちらも当てはまらない |
| 25 | **iPhone・iPad か**の推定。ブラウザの識別文字列に `iPhone` などが含まれるか調べる。最近の iPad は Mac のふりをする（`MacIntel` と名乗る）ので、「Mac なのにタッチの指が2本以上使える」も iPad とみなす |

どちらも、端末の種類を確実に知る方法がないための推定です。

```ts
const selfId = randomId();
let settings = loadSettings();
let currentScreen: ScreenName = 'wait';
```

| 行 | 説明 |
|---|---|
| 27 | この端末のID（シグナリングの送信者ID）。ページを開いている間は同じ。ゲストが再試行しても同じIDなので、ホストは「同じゲストの再試行」と分かる |
| 28 | 外部サーバーの設定 |
| 29 | 今表示している画面 |

### 31〜67行目：画面全体で使う小道具

```ts
function show(name: ScreenName) {
  currentScreen = name;
  for (const el of document.querySelectorAll<HTMLElement>('.screen')) el.hidden = el.id !== `screen-${name}`;
}
```

画面を切り替えます。`class="screen"` の要素をすべて調べ、`id` が `screen-○○` に一致するものだけを表示し、他を非表示にします。

```ts
function setStatus(state: StatusName) {
  for (const el of document.querySelectorAll<HTMLElement>('[data-status]')) {
    el.dataset.state = state;
    el.textContent = STATUS_LABEL[state];
  }
}
```

接続状態の表示を書き換えます。`data-status` 属性を持つ要素（各画面の左上）すべてに、文字と `data-state` 属性を設定します。CSS が `data-state` の値に応じて、点の色（緑・オレンジ・赤）を変えます。

```ts
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}
```

画面下に3.5秒間メッセージを出します（要件 8.5「フィードバック」）。表示中に次のメッセージが来たら、前のタイマーを取り消して、新しいメッセージで3.5秒を数え直します。

```ts
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return toast('コピーできませんでした');
  }
  toast('コピーしました');
}
```

文字列をクリップボードにコピーします（要件 F-04、F-32）。

| 行 | 説明 |
|---|---|
| 54 | 標準の方法でコピーする。HTTPS のページでないと使えないなど、条件によっては失敗する |
| 56〜63 | 失敗したら、古い方法を試す。見えないテキスト欄を作り、文字を入れて選択し、「コピー」の命令を実行して、テキスト欄を消す |
| 64〜66 | 結果をトーストで知らせる |

`document.execCommand('copy')` は古い方法で、非推奨になっていますが、多くのブラウザでまだ動くので、予備として使っています。

### 69〜132行目：ホストの開始と停止

```ts
let hostGen = 0;
let hostCtl: Controller | null = null;
let expiryTimer: ReturnType<typeof setInterval> | undefined;
let expiresAt = 0;
let hostJoining = false;
let hostCode = '';
let hostUrl = '';
```

| 変数 | 意味 |
|---|---|
| `hostGen` | ホストの世代番号（前提知識 1-3） |
| `hostCtl` | 今のホストの `Controller`（やめるときに `close()` する） |
| `expiryTimer` | 残り時間の表示を更新するタイマー |
| `expiresAt` | 期限の時刻 |
| `hostJoining` | ゲストから参加要求が来て、接続を進めているか |
| `hostCode`、`hostUrl` | 今の接続コードと接続用URL（コピーボタン用） |

```ts
function stopHosting() {
  hostGen++;
  hostCtl?.close();
  hostCtl = null;
  clearInterval(expiryTimer);
}
```

ホストをやめます。世代番号を進めるので、まだ結果の届いていない `startHost()` も無効になります。

```ts
async function startHosting() {
  stopHosting();
  const gen = hostGen;
  show('wait');
  setStatus('waiting');
  hostJoining = false;
  $('joining').hidden = true;
  $('broker-error').hidden = true;
```

新しい接続情報で待機を始めます。

| 行 | 説明 |
|---|---|
| 87 | 前のホストをやめる |
| 88 | 自分の世代を控える |
| 89〜93 | 待機画面を表示し、状態を「待機中」にし、「相手と接続中…」とブローカーのエラーを隠す |

```ts
  settings = loadSettings();
  const secret = randomSecret();
  const customBrokers = !isDefaultMqtt(settings.mqtt);
  hostCode = secretToCode(secret);
  hostUrl = buildUrl(pageUrl(), secret, customBrokers ? settings.mqtt : null); // F-75
  $('code').textContent = hostCode;
  $('qr').replaceChildren(qrToSvg(encodeQr(hostUrl)));
  $('broker-note').hidden = !customBrokers; // F-76
```

| 行 | 説明 |
|---|---|
| 95 | 設定を読み直す（設定画面で変えた後に呼ばれることもあるため） |
| 96 | 新しい秘密値を作る（第4回） |
| 97 | ブローカーの設定をデフォルトから変えているか（第3回） |
| 98 | 接続コードを作る（第2回） |
| 99 | 接続用URLを作る。設定を変えていれば、ブローカーの一覧を URL に含める（要件 F-75） |
| 100 | 接続コードを表示する |
| 101 | URL を QR コードにして表示する（第11回）。`replaceChildren` で、前の QR を新しいものに入れ替える |
| 102 | 設定を変えていれば、「相手側も同じ設定が必要」を表示する（要件 F-76） |

```ts
  expiresAt = Date.now() + EXPIRY_MS;
  updateExpiry();
  expiryTimer = setInterval(updateExpiry, 1000);
```

期限を10分後にし、残り時間をすぐに表示して、以後1秒ごとに更新します。

```ts
  const ctl = await startHost({
    secret,
    brokers: settings.mqtt,
    stun: settings.stun,
    selfId,
    onBrokerChange: (s) => {
      $('broker-error').hidden = !(s.ready === 0 && s.failed === s.total);
    },
    onJoin: () => {
      hostJoining = true;
      setStatus('connecting');
      $('joining').hidden = false;
    },
    onConnected: (pc, dc) => {
      stopHosting();
      enterMain(pc, dc);
    },
    onFail: () => {
      toast('接続できませんでした。新しい接続情報で待機します');
      void startHosting();
    },
  });
```

ホストとして待ちます（第7回）。渡す関数：

| 関数 | すること |
|---|---|
| `onBrokerChange` | 全ブローカーに失敗したら、エラーを表示する |
| `onJoin` | 参加要求が来たら、状態を「接続中」にし、「相手と接続中…」を表示する |
| `onConnected` | 接続できたら、ホストをやめて（タイマーを止めるため）、メイン画面に移る |
| `onFail` | ゲストが来たのに接続できなかったら、知らせて、新しい接続情報で待ち直す |

```ts
  if (gen !== hostGen) ctl.close();
  else hostCtl = ctl;
}
```

`startHost()` の結果が届くまでの間に、別の画面に移っていたら（世代番号が変わっていたら）、届いたホストをすぐにやめます。そうでなければ、今のホストとして記録します。

### 134〜147行目：残り時間とボタン

```ts
function updateExpiry() {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0 && !hostJoining) {
    void startHosting(); // 期限切れで自動更新
    return;
  }
  const sec = Math.max(0, Math.ceil(remaining / 1000));
  $('expiry').textContent = `残り ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
```

| 行 | 説明 |
|---|---|
| 135 | 残りのミリ秒 |
| 136〜139 | 期限が切れたら、新しい接続情報に切り替える（要件 F-06）。ただし、ゲストと接続している途中なら切り替えない（切り替えると、つながりかけている接続が切れてしまう） |
| 140 | 残りの秒数。切り上げなので、残り0.5秒は「0:01」と表示される |
| 141 | 「残り 9:32」の形で表示する。秒は `padStart` で2桁にそろえる |

```ts
$('copy-code').addEventListener('click', () => void copyText(hostCode));
$('copy-url').addEventListener('click', () => void copyText(hostUrl));
$('refresh').addEventListener('click', () => void startHosting());
$('go-join').addEventListener('click', () => showJoin());
```

待機画面のボタンに処理を付けます。この4行は、ページを読み込んだときに1回だけ実行されます（関数の中ではなく、ファイルの一番外側に書いてあるため）。

| ボタン | 処理 |
|---|---|
| コードをコピー | 接続コードをコピー（要件 F-04） |
| URLをコピー | 接続用URLをコピー（要件 F-04） |
| 更新 | 接続情報を作り直す（要件 F-07） |
| この端末から参加する | 参加画面に移る（要件 F-12） |

### 149〜198行目：ゲストの開始と停止

```ts
interface GuestInfo {
  secret: Uint8Array<ArrayBuffer>;
  brokers: string[] | null;
}

let guestGen = 0;
let guestCtl: Controller | null = null;
let lastGuest: GuestInfo | null = null;
```

| 名前 | 意味 |
|---|---|
| `GuestInfo` | ゲストとして接続するための情報。`connInfo.ts` の解釈の成功の結果と同じ形 |
| `guestGen`、`guestCtl` | ゲストの世代番号と `Controller`（ホストと同じ考え方） |
| `lastGuest` | 最後に接続しようとした情報（「再試行」ボタン用） |

```ts
function stopGuesting() {
  guestGen++;
  guestCtl?.close();
  guestCtl = null;
}

function showJoin() {
  stopHosting();
  stopGuesting();
  show('join');
  $('join-error').textContent = '';
  if (hasKeyboard) $('join-input').focus();
}
```

`showJoin()` は参加画面を表示します。ホストもゲストもやめて、エラー表示を消し、PC なら入力欄にカーソルを置きます（スマホでは、勝手にキーボードが出ると邪魔なので置かない）。

**参加画面に移るとホストをやめる理由**：この端末は「参加する側」になるので、待機しておく必要がなくなります。「戻る」を押したときは、新しい接続情報で待機し直します。

```ts
async function startGuesting(info: GuestInfo) {
  stopHosting();
  stopGuesting();
  const gen = guestGen;
  lastGuest = info;
  show('connecting');
  setStatus('connecting');
  // URLにブローカー設定があればこの接続に限りそれを使う（F-75）
  const ctl = await startGuest({
    secret: info.secret,
    brokers: info.brokers ?? settings.mqtt,
    stun: settings.stun,
    selfId,
    onConnected: (pc, dc) => {
      guestCtl = null;
      enterMain(pc, dc);
    },
    onFail: (reason) => {
      guestCtl = null;
      showError(reason, info.brokers !== null);
    },
  });
  if (gen !== guestGen) ctl.close();
  else guestCtl = ctl;
}
```

| 行 | 説明 |
|---|---|
| 175〜177 | ホストと前のゲストをやめて、自分の世代を控える |
| 178 | 再試行用に情報を覚えておく |
| 179〜180 | 接続中画面にする |
| 184 | URL にブローカーの設定が入っていればそれを、なければ自分の設定を使う（要件 F-75、F-76）。自分の設定（localStorage）は変えない |
| 185 | STUN サーバーは、自分の設定を使う（要件 F-77） |
| 187〜190 | 接続できたら、メイン画面に移る |
| 191〜194 | 失敗したら、エラー画面を表示する |
| 196〜197 | ホストと同じ、世代番号による確認 |

### 200〜236行目：エラー画面

```ts
const ERRORS: Record<GuestFailReason, { reason: string; hints: string[] }> = {
  broker: { … },
  nohost: { … },
  p2p: { … },
};
```

失敗の理由（第7回）ごとに、原因の説明と対処法の一覧を持っています（要件 U-02）。`Record<GuestFailReason, …>` なので、理由が増えたのに説明を書き忘れると型エラーになります。

```ts
function showError(reason: GuestFailReason, fromUrl: boolean) {
  show('error');
  setStatus('disconnected');
  const info = ERRORS[reason];
  $('error-reason').textContent = info.reason;
  const hints = reason === 'nohost' && fromUrl ? info.hints.filter((h) => !h.startsWith('コード入力')) : info.hints;
  $('error-hints').replaceChildren(
    ...hints.map((h) => {
      const li = document.createElement('li');
      li.textContent = h;
      return li;
    }),
  );
}
```

| 行 | 説明 |
|---|---|
| 224〜225 | エラー画面にし、状態を「切断」にする |
| 226〜227 | 理由に応じた説明を表示する |
| 228 | 対処法を選ぶ。ブローカーの設定入りの URL で接続した場合は、「コード入力の場合、相手と設定を揃える」は当てはまらないので外す |
| 229〜235 | 対処法を1つずつ `<li>` にして、一覧に入れる |

### 238〜267行目：参加画面とエラー画面の操作

```ts
const joinInput = $<HTMLInputElement>('join-input');

// 入力中に自動でハイフン区切りに整形する
joinInput.addEventListener('input', () => {
  const v = joinInput.value;
  $('join-error').textContent = '';
  if (looksLikeUrl(v) || joinInput.selectionStart !== v.length) return;
  const formatted = formatCode(normalizeCode(v));
  if (formatted !== v) joinInput.value = formatted;
});
```

入力欄に1文字入るたびに、接続コードの形（大文字、4文字ごとのハイフン）に整えます（要件 8.3）。

| 行 | 説明 |
|---|---|
| 243 | 前のエラー表示を消す |
| 244 | 整えない場合：URL らしい文字（`:` `/` `#`）が入っている、または**カーソルが末尾にない**（途中を編集している） |
| 245〜246 | 整えた結果が今と違えば、書き換える |

**カーソルが末尾にないときに整えない理由**：入力欄の値を書き換えると、カーソルが末尾に飛んでしまいます。途中の文字を直している最中にカーソルが飛ぶと、とても使いにくいためです。

（第2回で触れたとおり、URL を1文字ずつ手で打つと、最初の `https` までは接続コードとして整えられてしまいます。接続には影響しません。）

```ts
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const result = parseInput(joinInput.value);
  if (result.error !== undefined) {
    $('join-error').textContent = result.error;
    return;
  }
  void startGuesting(result);
});
```

「接続」ボタン（または入力欄で Enter）で、入力を解釈します（第2回）。エラーなら表示し、正しければ接続を始めます。250行目でページの再読み込みを止めています。

```ts
$('join-back').addEventListener('click', () => void startHosting());
$('connecting-cancel').addEventListener('click', () => {
  stopGuesting();
  showJoin();
});
$('retry').addEventListener('click', () => {
  if (lastGuest) void startGuesting(lastGuest);
});
$('reinput').addEventListener('click', () => showJoin());
```

| ボタン | 処理 |
|---|---|
| 戻る（参加画面） | 新しい接続情報で待機画面に戻る（要件 F-17） |
| やめる（接続中画面） | 接続をやめて、参加画面に戻る |
| 再試行（エラー画面） | 同じ情報でもう一度接続する。`startGuest()` の中で新しい試行IDが作られる |
| 入力し直す（エラー画面） | 参加画面に戻る。入力欄の文字は残っている |

### 269〜308行目：メイン画面に入る

```ts
let session: Session | null = null;
const historyEl = $<HTMLOListElement>('history');
const textInput = $<HTMLTextAreaElement>('text-input');
const fileInput = $<HTMLInputElement>('file-input');
```

| 変数 | 意味 |
|---|---|
| `session` | 今の `Session`（第8〜9回）。接続していなければ `null` |
| `historyEl` | 履歴の一覧（`<ol>`） |
| `textInput` | テキストの入力欄 |
| `fileInput` | ファイル選択（非表示） |

```ts
function enterMain(pc: RTCPeerConnection, dc: RTCDataChannel) {
  show('main');
  setStatus('connected');
  historyEl.replaceChildren();
  textInput.value = '';
  resizeTextInput();
```

メイン画面を表示し、状態を「接続済み」にして、履歴と入力欄を空にします。

```ts
  session = new Session(pc, dc, {
    onItem: renderItem,
    onNotice: toast,
    onBusyChange: setBusy,
    onClose: (reason) => {
      session = null;
      historyEl.replaceChildren(); // F-64
      toast(reason === 'local' ? '切断しました' : '相手が切断しました');
      void startHosting(); // F-62
    },
  });
```

`Session` を作り、画面に知らせてもらう関数を渡します。

| 関数 | すること |
|---|---|
| `onItem` | 吹き出しを追加・更新する（`renderItem`） |
| `onNotice` | トーストを表示する |
| `onBusyChange` | スリープ防止をオン・オフする（`setBusy`） |
| `onClose` | 履歴を消し（要件 F-64）、「切断しました」または「相手が切断しました」と知らせ（要件 F-61、8.6）、新しい接続情報で待機画面に戻る（要件 F-62） |

```ts
  addSystem('接続しました');
  if (!hasKeyboard) addSystem('別のアプリに切り替えたり画面を消したりすると、切断されることがあります');
  if (hasKeyboard) textInput.focus();
}
```

「接続しました」のお知らせを履歴に出します。スマホなら、バックグラウンドにすると切れやすいことを注意します（要件 R-03）。PC なら入力欄にカーソルを置きます。

```ts
function addSystem(text: string) {
  const li = document.createElement('li');
  li.className = 'system';
  li.textContent = text;
  historyEl.append(li);
  scrollToBottom();
}

function scrollToBottom() {
  historyEl.scrollTop = historyEl.scrollHeight;
}
```

| 関数 | 説明 |
|---|---|
| `addSystem` | 中央に小さく出るお知らせ（「接続しました」など）を履歴に追加する |
| `scrollToBottom` | 履歴を一番下までスクロールする。`scrollTop`（今のスクロール位置）を `scrollHeight`（中身全体の高さ）にすると、一番下になる |

### 310〜358行目：表示のための小道具

```ts
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
```

要素を作る短い関数です。`el('div', 'bubble', 'こんにちは')` で、`<div class="bubble">こんにちは</div>` ができます。

型の引数 `K` はタグ名です。`el('button')` と書くと、戻り値の型が自動で `HTMLButtonElement` になり、`.type` などボタン専用のプロパティが使えます。`HTMLElementTagNameMap` は、タグ名と要素の型の対応表です。

```ts
function button(label: string, onClick: () => void, className?: string) {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
```

クリックで処理を行うボタンを作ります。

```ts
function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}
```

時刻を「14:05」の形にします。

```ts
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}
```

バイト数を「2.3MB」のような読みやすい形にします。

| 行 | 説明 |
|---|---|
| 329 | 1024 未満はバイトのまま（`512B`） |
| 331 | まず KB にする |
| 333〜336 | 1024 以上なら、次の単位にする（KB → MB → GB） |
| 337 | 10 未満なら小数第1位まで（`2.3MB`）、10 以上なら整数（`45MB`） |

**気づいた点**：1MB にわずかに足りないサイズ（1,048,575 バイトなど）は、KB のまま 1023.99… になり、四捨五入で「1024KB」と表示されます。表示がやや不自然になるだけで、実害はありません。

```ts
/** URLをリンクにしたテキストノード列（F-33） */
function linkify(text: string): Node[] {
  const nodes: Node[] = [];
  const re = /https?:\/\/[^\s<>"'「」（）]+/g;
  let last = 0;
```

テキストの中の URL をリンクにします（要件 F-33）。結果は、文字の部分（テキストノード）とリンク（`<a>` 要素）を並べた配列です。

343行目の正規表現：`http://` か `https://` で始まり、空白や `<>"'「」（）` 以外の文字が続く部分。日本語の文章では、URL の直後に「」や（）が続くことが多いので、それらで URL を区切るようにしています。

```ts
  for (const m of text.matchAll(re)) {
    const url = m[0].replace(/[.,;:!?)\]}、。]+$/, '');
    const start = m.index;
    if (start > last) nodes.push(document.createTextNode(text.slice(last, start)));
```

| 行 | 説明 |
|---|---|
| 345 | `matchAll` で、当てはまる部分を順に取り出す。`m[0]` は当てはまった文字列、`m.index` はその位置 |
| 346 | 末尾の句読点や閉じかっこを取り除く。「見て https://example.com/a。」の `。` を URL に含めないため |
| 348 | URL より前の普通の文字を、テキストノードにして加える |

```ts
    const a = el('a', undefined, url);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    nodes.push(a);
    last = start + url.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}
```

| 行 | 説明 |
|---|---|
| 349〜350 | リンクを作る。表示する文字もリンク先も URL |
| 351 | 新しいタブで開く |
| 352 | 開いたページから、このページを操作されないようにする（`noopener`）。また、このページの URL を伝えない（`noreferrer`） |
| 354 | 次の普通の文字は、URL の直後から（取り除いた句読点は普通の文字として残る） |
| 356 | 最後の URL より後の文字を加える |

`http` か `https` で始まるものだけをリンクにするので、`javascript:` のような危険なリンクは作られません。

**気づいた点**：URL の直後に、空白を入れずに日本語が続くと、その日本語までリンクに含まれます。

| テキスト | リンクになる部分 |
|---|---|
| `見て https://example.com/a。` | `https://example.com/a`（末尾の `。` は取り除かれる） |
| `（https://example.com/b）` | `https://example.com/b`（全角かっこで区切られる） |
| `https://example.com/cを見て` | `https://example.com/cを見て`（**「を見て」まで含まれる**） |

URL には日本語が入ることもある（Wikipedia の日本語のページなど）ので、日本語を一律に区切りにすると、そうした URL が途中で切れてしまいます。どちらを優先するかの判断になります。リンク先が少し違っても、吹き出しの「コピー」で正しい URL を取り出せるので、実害は小さいです。

### 360〜441行目：履歴の表示

```ts
function renderItem(item: Item) {
  let li = historyEl.querySelector<HTMLLIElement>(`li[data-id="${item.id}"]`);
  const isNew = !li;
  const nearBottom = historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight < 80;
```

`Session` から項目の追加・更新を知らされたときに呼ばれます。

| 行 | 説明 |
|---|---|
| 361 | この項目の吹き出しがすでにあるか、`data-id` 属性で探す。ID は16進数の文字なので、セレクターの中に入れても問題ない |
| 362 | 新しい項目か |
| 363 | 今、一番下の近く（80ピクセル以内）を見ているか。`clientHeight` は見えている部分の高さ |

```ts
  if (li && item.kind === 'file' && li.dataset.status === item.status) {
    // 進捗だけの更新
    updateProgress(li, item);
    return;
  }
```

ファイルの状態が変わっていなければ、進捗の表示だけを更新します。進捗は100ミリ秒ごとに届くので、そのたびに吹き出し全体を作り直すと重くなり、ボタンを押そうとした瞬間にボタンが作り直されて押せない、ということも起きるためです。

```ts
  if (!li) {
    li = el('li', `msg${item.mine ? ' mine' : ''}`);
    li.dataset.id = item.id;
    historyEl.append(li);
  }
```

新しい項目なら、`<li>` を作って末尾に加えます。自分が送ったものには `mine` クラスを付け、CSS で右寄せ・アクセントカラーにします（要件 8.5）。

```ts
  if (item.kind === 'text') {
    const bubble = el('div', 'bubble');
    bubble.append(...linkify(item.body));
    const meta = el('div', 'meta');
    meta.append(el('span', undefined, formatTime(item.ts)), button('コピー', () => void copyText(item.body)));
    li.replaceChildren(bubble, meta);
  } else {
    li.dataset.status = item.status;
    li.replaceChildren(...renderFile(item));
    updateProgress(li, item);
  }
  if (isNew || nearBottom) scrollToBottom();
}
```

| 行 | 説明 |
|---|---|
| 376〜381 | テキストなら：吹き出し（URL はリンク）と、時刻と「コピー」ボタンを作る |
| 382〜386 | ファイルなら：状態を記録し、吹き出しを作り、進捗を表示する |
| 387 | 新しい項目か、一番下近くを見ていたなら、一番下までスクロールする（要件 8.5：新着時は最下部へ）。上の方を読み返しているときに、進捗の更新で勝手にスクロールされないようにしている |

```ts
const FILE_STATUS_LABEL: Record<FileItem['status'], string> = {
  queued: '送信待ち',
  sending: '送信中',
  …
};
```

ファイルの状態ごとの表示文字です。

```ts
function renderFile(item: FileItem): HTMLElement[] {
  const bubble = el('div', 'bubble file');
  const sub = el('div', 'file-sub');
  sub.dataset.role = 'sub';
  bubble.append(el('div', 'file-name', item.name), sub);
  if (item.status === 'queued' || item.status === 'sending' || item.status === 'receiving') {
    const bar = el('div', 'progress');
    bar.append(el('span'));
    bubble.append(bar);
  }
```

ファイルの吹き出しを作ります。ファイル名、サイズと状態の行（`sub`）、転送中なら進捗バーを入れます。進捗バーは、外側の `div` の中の `span` の幅で表します。

```ts
  const meta = el('div', 'meta');
  meta.append(el('span', undefined, formatTime(item.ts)));
  switch (item.status) {
    case 'queued':
    case 'sending':
    case 'receiving':
      meta.append(button('キャンセル', () => session?.cancel(item.id), 'danger'));
      break;
    case 'received':
      if (item.saved) meta.append(el('span', undefined, '保存済み'));
      meta.append(
        button('保存', () => void saveFile(item)),
        button('破棄', () => session?.release(item.id), 'danger'),
      );
      break;
  }
  return [bubble, meta];
}
```

吹き出しの下に、時刻と、状態に応じたボタンを置きます（要件 8.5「履歴の各項目」）。

| 状態 | ボタン |
|---|---|
| 送信待ち、送信中、受信中 | キャンセル |
| 受信済み | 保存、破棄（保存済みなら「保存済み」も表示） |
| それ以外 | なし |

`case` を3つ続けて書くと、どれに当てはまっても同じ処理になります。

```ts
function updateProgress(li: HTMLElement, item: FileItem) {
  const sub = li.querySelector<HTMLElement>('[data-role="sub"]');
  const active = item.status === 'sending' || item.status === 'receiving';
  const pct = item.size ? Math.floor((item.transferred / item.size) * 100) : active ? 0 : 100;
  if (sub) {
    sub.textContent = `${formatSize(item.size)}・${FILE_STATUS_LABEL[item.status]}${active ? ` ${pct}%` : ''}`;
  }
  const bar = li.querySelector<HTMLElement>('.progress > span');
  if (bar) bar.style.width = `${active ? pct : 0}%`;
}
```

進捗の表示を更新します（要件 F-45）。

| 行 | 説明 |
|---|---|
| 434 | 転送中か |
| 435 | 進捗の%。サイズが0のファイルは割り算できないので、転送中なら0%、それ以外なら100% |
| 436〜438 | 「2.3MB・送信中 45%」のように表示する |
| 439〜440 | 進捗バーの幅を%で設定する |

### 443〜465行目：受信したファイルの保存

```ts
async function saveFile(item: FileItem) {
  if (!item.blob) return;
  const file = new File([item.blob], item.name, { type: item.blob.type });
```

「保存」ボタンで呼ばれます（要件 F-47）。受け取った中身（`Blob`）に、ファイル名を付けた `File` を作ります。

```ts
  // iOS は共有シート経由の方が保存しやすい（R-08）
  if (isIos && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      session?.markSaved(item.id);
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }
```

iPhone・iPad では、共有シート（「写真に保存」「ファイルに保存」などを選べる画面）を使います（要件 R-08）。

| 行 | 説明 |
|---|---|
| 447 | iOS で、ファイルの共有ができるなら |
| 449〜451 | 共有シートを開き、終わったら保存済みにする |
| 453 | ユーザーが共有シートを閉じた（`AbortError`）なら、何もしない。それ以外のエラーなら、下のダウンロードの方法を試す |

```ts
  const url = URL.createObjectURL(file);
  const a = el('a');
  a.href = url;
  a.download = item.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  session?.markSaved(item.id);
}
```

それ以外では、ダウンロードとして保存します。

| 行 | 説明 |
|---|---|
| 456 | ファイルを指す一時的な URL（`blob:…`）を作る |
| 457〜462 | リンクを作り、`download` 属性にファイル名を設定して、プログラムからクリックする。ダウンロードが始まったら、リンクを消す |
| 463 | 1分後に一時的な URL を無効にする。すぐに無効にすると、ダウンロードの開始が間に合わないことがあるため |
| 464 | 保存済みにする |

ダウンロードを実際に完了したかどうかは、ブラウザからは分かりません。「保存」ボタンを押した時点で保存済みとみなしています。

### 467〜499行目：テキストとファイルの送信

```ts
function resizeTextInput() {
  textInput.style.height = 'auto';
  textInput.style.height = `${textInput.scrollHeight + 2}px`;
}
```

入力欄の高さを、中身に合わせます（要件 8.5：自動で高さ調整）。いったん高さを `auto` にして中身の高さ（`scrollHeight`）を測り直し、その高さにします。`+ 2` は上下の枠線の分です。CSS で最大の高さ（画面の40%）を決めているので、それ以上は伸びずにスクロールになります。

```ts
function sendTextInput() {
  if (!session) return;
  const text = textInput.value;
  if (!text.trim()) return;
  const error = session.sendText(text);
  if (error) return toast(error);
  textInput.value = '';
  resizeTextInput();
}
```

| 行 | 説明 |
|---|---|
| 475 | 空白や改行だけなら送らない |
| 476〜477 | 送る。10万文字を超えていたら、エラーをトーストで知らせ、入力欄の文字は残す（要件 F-36） |
| 478〜479 | 送れたら、入力欄を空にして高さを戻す |

送るときは `trim()` していない元の文字列を送るので、前後の空白や改行もそのまま相手に届きます。

```ts
textInput.addEventListener('input', resizeTextInput);
textInput.addEventListener('keydown', (e) => {
  // 物理キーボードがあれば Enter で送信、Shift+Enter で改行
  if (hasKeyboard && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendTextInput();
  }
});
```

| 行 | 説明 |
|---|---|
| 482 | 1文字入るたびに高さを合わせる |
| 485 | PC で、Enter を、Shift なしで、**日本語の変換中でなく**押したら送信する（要件 8.5） |
| 486 | Enter による改行を止める |

`e.isComposing` は、日本語入力で変換を確定する前（下線が付いている状態）かどうかです。これを確かめないと、変換を確定するための Enter で送信されてしまいます。

```ts
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendTextInput();
  if (hasKeyboard) textInput.focus();
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) session?.sendFiles([...fileInput.files]);
  fileInput.value = '';
});
$('disconnect').addEventListener('click', () => session?.close());
```

| 行 | 説明 |
|---|---|
| 490〜494 | 送信ボタンで送る。PC なら入力欄にカーソルを戻す |
| 495〜498 | ファイルが選ばれたら送る（要件 F-41、F-43）。`fileInput.files` は `FileList` という配列に似たものなので、`[...]` で配列にしている。最後に選択を空にするのは、次に同じファイルを選んでも `change` が起きるようにするため |
| 499 | 切断ボタン（要件 F-66） |

### 501〜522行目：ドラッグ＆ドロップ

```ts
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!session && !!e.dataTransfer?.types.includes('Files');
```

| 行 | 説明 |
|---|---|
| 502 | ドラッグがページのどれだけ内側に入っているかの数（下で説明） |
| 503 | 接続中で、ドラッグしているのがファイルか。`!!` は値を真偽値（`true` / `false`）に変換する書き方 |

```ts
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  if (dragDepth > 0 && --dragDepth === 0) $('drop-overlay').hidden = true;
});
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer?.files.length) session?.sendFiles([...e.dataTransfer.files]);
});
```

ページ全体をドロップ先にします（要件 F-42、8.5）。

| イベント | 起きるとき | すること |
|---|---|---|
| `dragenter` | ドラッグが要素に入った | 数を1増やし、「ドロップして送信」を表示する |
| `dragover` | ドラッグが要素の上にある間（くり返し） | `preventDefault()` で「ここにドロップしてよい」と伝える。これがないとドロップできない |
| `dragleave` | ドラッグが要素から出た | 数を1減らし、0 になったら表示を消す |
| `drop` | ドロップされた | 表示を消し、ファイルを送る。`preventDefault()` しないと、ブラウザがファイルを開いてしまう |

**数を数える理由**：`dragenter` と `dragleave` は、ページの中の**要素ごと**に起きます。ドラッグしたまま吹き出しの上を通ると、「吹き出しに入った」「（外側の要素から）出た」が両方起きます。出たときにすぐ表示を消すと、ページの上にいるのに表示がちらつきます。入った数と出た数を数えて、0 になったとき（＝ページの外に出たとき）だけ消しています。

513行目の `--dragDepth` は「1減らしてから、その値を使う」です。

### 524〜560行目：スリープ防止

```ts
let busy = false;
let wakeLock: WakeLockSentinel | null = null;
let wakeLockWarned = false;

function warnWakeLock() {
  if (wakeLockWarned) return;
  wakeLockWarned = true;
  toast('この端末では画面のスリープ防止が使えません。転送中は画面を消さないでください');
}
```

ファイルの転送中に画面が消えると、通信が切れてしまうことがあります（要件 R-09）。Screen Wake Lock API で、転送中は画面が消えないようにします（要件 U-06）。

| 名前 | 意味 |
|---|---|
| `busy` | 転送中か |
| `wakeLock` | 取得したスリープ防止の「ロック」。解除するときに使う |
| `warnWakeLock()` | 使えない場合の注意を、1回だけ表示する |

```ts
async function setBusy(value: boolean) {
  busy = value;
  if (!busy) {
    const lock = wakeLock;
    wakeLock = null;
    await lock?.release().catch(() => {});
    return;
  }
```

転送中でなくなったら、ロックを解除します。

```ts
  if (wakeLock) return;
  if (!('wakeLock' in navigator)) return warnWakeLock();
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!busy) return void lock.release();
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    warnWakeLock();
  }
}
```

| 行 | 説明 |
|---|---|
| 544 | すでにロックを持っていれば何もしない |
| 545 | この機能のないブラウザなら、注意を表示する |
| 547 | 画面のスリープ防止を頼む。許可されるまで待つ |
| 548 | 待っている間に転送が終わっていたら、すぐに解除する（追い越し対策） |
| 549 | ロックを覚える |
| 550〜552 | ロックが解除されたら（ブラウザが自動で解除した場合も含む）、覚えていたロックを消す |
| 553〜555 | 断られたら（省電力モードなど）、注意を表示する |

```ts
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && busy && !wakeLock) void setBusy(true);
});
```

**ページが隠れると（別のタブやアプリに切り替えると）、ブラウザはロックを自動で解除します。** ページが再び表示されたときに、まだ転送中なら、もう一度ロックを取ります。

### 562〜569行目：ページを閉じるとき

```ts
window.addEventListener('beforeunload', (e) => {
  if (!session) return;
  e.preventDefault();
  e.returnValue = '';
});
window.addEventListener('pagehide', () => session?.close());
```

| イベント | 説明 |
|---|---|
| `beforeunload` | ページを閉じる・再読み込みする直前に起きる。接続中なら `preventDefault()` して、ブラウザの「このページを離れますか？」の確認を出す（要件 F-65）。`returnValue = ''` は、古いブラウザで確認を出すための書き方 |
| `pagehide` | ページが実際に閉じられるときに起きる。接続中なら、相手に `bye` を送って切断する。相手はすぐに「相手が切断しました」と表示できる |

### 571〜610行目：設定ダイアログ

```ts
const settingsDialog = $<HTMLDialogElement>('settings');
const setStun = $<HTMLTextAreaElement>('set-stun');
const setMqtt = $<HTMLTextAreaElement>('set-mqtt');

function fillSettings(s: { stun: readonly string[]; mqtt: readonly string[] }) {
  setStun.value = s.stun.join('\n');
  setMqtt.value = s.mqtt.join('\n');
  $('settings-errors').replaceChildren();
}
```

`fillSettings()` は、設定を入力欄に1行1URLで入れ、エラー表示を消します。

```ts
function applySettingsChange() {
  settings = loadSettings();
  settingsDialog.close();
  if (currentScreen === 'wait' && !hostJoining) void startHosting();
}
```

設定を変えた後の処理です。設定を読み直し、ダイアログを閉じます。待機画面なら、新しい設定（ブローカー）で待機し直します。接続の途中なら、つながりかけた接続を切らないよう、待機し直しません。

```ts
for (const b of document.querySelectorAll('[data-open-settings]')) {
  b.addEventListener('click', () => {
    fillSettings(loadSettings());
    settingsDialog.showModal();
  });
}
```

歯車ボタン（待機画面と参加画面の2つ）を押したら、今の設定を入力欄に入れて、ダイアログを開きます（要件 8.7）。

```ts
$('settings-save').addEventListener('click', () => {
  const errors = saveSettings({ stun: parseLines(setStun.value), mqtt: parseLines(setMqtt.value) });
  if (errors.length) {
    $('settings-errors').replaceChildren(...errors.map((msg) => el('li', undefined, msg)));
    return;
  }
  toast('設定を保存しました');
  applySettingsChange();
});
```

「保存」：入力欄を1行ずつの一覧にして、検証して保存します（第3回）。エラーがあれば、ダイアログを閉じずにエラーを表示します（要件 F-78）。

```ts
$('settings-reset').addEventListener('click', () => {
  resetSettings();
  fillSettings(DEFAULTS);
  toast('デフォルトの設定に戻しました');
  applySettingsChange();
});
$('settings-close').addEventListener('click', () => settingsDialog.close());
```

| ボタン | 処理 |
|---|---|
| デフォルトに戻す | 保存した設定を消し（要件 F-74）、入力欄をデフォルト値にして、変更を反映する |
| 閉じる | 入力の変更を捨てて閉じる。次に開くときは `fillSettings(loadSettings())` で保存済みの値が入るので、入力途中の内容は残らない |

### 612〜633行目：起動

```ts
/** URLの # 以降に接続情報があればゲストとして接続する（F-11） */
function handleHash() {
  const hash = location.hash.slice(1);
  if (!hash) return false;
  history.replaceState(null, '', location.pathname + location.search); // S-07
```

| 行 | 説明 |
|---|---|
| 616 | URL の `#` 以降を取り出す（先頭の `#` は除く） |
| 617 | なければ何もしない（`false` を返す） |
| 618 | **すぐに、アドレスバーの URL から `#` 以降を消す**（要件 S-07）。`replaceState` は、ページを移動せずに、今の履歴の URL を書き換える。これで、ブラウザの履歴に秘密値が残らない |

```ts
  if (session) {
    toast('接続中のため、新しい接続情報は無視しました');
    return true;
  }
  const result = parseHash(hash);
  if (result.error !== undefined) {
    toast(result.error);
    return false;
  }
  void startGuesting(result);
  return true;
}
```

| 行 | 説明 |
|---|---|
| 619〜622 | すでに接続中なら、新しい接続情報は無視する |
| 623〜627 | 解釈する。エラーならトーストで知らせ、`false` を返す |
| 628〜629 | 正しければ、ゲストとして接続を始め、`true` を返す |

戻り値は「ゲストとして接続を始めた（または接続中だった）か」です。

```ts
window.addEventListener('hashchange', () => void handleHash());
if (!handleHash()) void startHosting();
```

| 行 | 説明 |
|---|---|
| 632 | ページを開いたまま、アドレスバーの `#` 以降だけが変わったとき（接続用URLを、同じタブのアドレスバーに貼り付けたときなど）にも、接続を始める。`#` 以降だけが変わる場合、ページは再読み込みされないため |
| 633 | **起動時の処理**。URL に接続情報があればゲストとして接続し（要件 F-11）、なければホストとして待機を始める（要件 F-01、3.2） |

この633行目が、ページを開いたときに最初に動き出す処理です。ここから `startHosting()` → `startHost()` → `Signaling` → `MqttClient` と、これまで読んできた部品が順に動いていきます。

---

## 3. 動かして確認

### 3-1. ブレークポイントで流れを追う

1. 開発サーバーでページを開き、開発者ツールの「Sources」タブで `src/main.ts` を開きます。
2. `startHosting`、`startGuesting`、`enterMain` の各関数の最初の行の行番号をクリックして、ブレークポイントを置きます。
3. ページを再読み込みすると、`startHosting` で止まります。F10（ステップオーバー）で1行ずつ進めながら、画面が変わる様子を見てください。
4. 別のタブで接続コードを入力して接続し、`startGuesting` → `enterMain` の順に止まることを確かめます。

### 3-2. 期限切れの自動更新を見る

10分待つのは長いので、10行目を一時的に書き換えます。

```ts
const EXPIRY_MS = 15 * 1000; // 確認用に15秒
```

保存すると、Vite がページを再読み込みします。15秒たつと、接続コードと QR が自動で新しいものに変わることを確かめてください。確認したら元に戻します。

### 3-3. 画面を移ると、ブローカーとの接続が閉じられる

1. 開発者ツールの Network タブで「WS」に絞り込み、待機画面を開きます。ブローカーへの WebSocket の接続が並びます。
2. 「この端末から参加する」を押します。`showJoin()` → `stopHosting()` → `hostCtl.close()` と呼ばれ、それらの接続が閉じられることを確かめてください（一覧で、接続が終了した表示になります）。

**世代番号の確認（130行目）が働くのは、もっと短い間の追い越しです。** `startHost()` の結果は、秘密値から鍵を作るだけなので数ミリ秒で届き、人の手でその間に別のボタンを押すことはできません。ただ、プログラムの中では、たとえば期限切れの自動更新と `hashchange` がほぼ同時に起きる、といったことがありえます。そうした場合でも、古いホストが残って動き続けないようにするための備えです。

### 3-4. リンクと安全な表示

2つのタブで接続し、次のテキストを送ってみてください。

```
見て https://example.com/a。
（https://example.com/b）
https://example.com/cを見て
<b>太字にならない</b><script>alert(1)</script>
```

- 1〜2行目：URL がリンクになり、`。` や `）` はリンクに含まれないことを確かめます。
- 3行目：「を見て」までリンクに含まれることを確かめます（「気づいた点」の内容）。
- 4行目：タグが文字のまま表示され、太字にも、アラートにもならないことを確かめます（`textContent` で表示しているため）。

---

## 4. 理解チェック

1. `$` 関数で `null` の確認をしていないのはなぜですか。どんな場合に問題になりますか。
2. `startHosting()` の最後で `if (gen !== hostGen) ctl.close();` としているのはなぜですか。
3. 期限が切れても、`hostJoining` が `true` なら新しい接続情報に切り替えないのはなぜですか。
4. 参加画面の入力欄で、カーソルが末尾にないときは整形しないのはなぜですか。
5. PC で Enter を押したとき、日本語の変換中なら送信しないようにしているのは、どの部分ですか。
6. ドラッグ＆ドロップで、`dragDepth` という数を数えているのはなぜですか。
7. 別のタブに切り替えてから戻ってきたとき、転送中ならスリープ防止をもう一度取り直すのはなぜですか。
8. URL の `#` 以降を、解釈する前に `history.replaceState` で消しているのはなぜですか。
9. 相手から `<script>` を含むテキストが届いても、実行されないのはなぜですか。

<details>
<summary>答え</summary>

1. `index.html` に必ずある `id` しか使わないため。HTML を変更して `id` を消したり書き間違えたりすると、`null` に対してプロパティを読もうとして、実行時にエラーになる（型チェックでは気づけない）。
2. `startHost()` の結果が届くまでの間に、別の画面に移ったり、待機し直したりしている可能性があるため。その場合、届いたホストはもう使わないので、すぐにやめる。
3. ゲストと接続している途中に接続情報を切り替えると、つながりかけている接続が切れてしまうため。
4. 値を書き換えるとカーソルが末尾に飛んでしまい、途中の文字を直している最中だと、とても使いにくくなるため。
5. `keydown` の処理の `!e.isComposing` の部分。変換中（確定前）は `isComposing` が `true` になる。
6. `dragenter` と `dragleave` はページの中の要素ごとに起きるので、ドラッグ中に要素の上を通るたびに両方が起きる。入った数と出た数を数えて、0 になったとき（ページの外に出たとき）だけ表示を消すことで、表示のちらつきを防いでいる。
7. ページが隠れると、ブラウザがスリープ防止のロックを自動で解除するため。戻ってきたときに取り直さないと、転送の途中で画面が消えてしまう。
8. ブラウザの履歴やアドレスバーに秘密値（接続コード）が残らないようにするため（要件 S-07）。解釈に失敗した場合も含め、すぐに消している。
9. 届いたテキストは `textContent` と `createTextNode` で表示していて、HTML として解釈しない（`innerHTML` を使っていない）ため。タグは文字としてそのまま表示される。

</details>

---

次回（第11回）は `src/qr.ts` を読みます。101行目で使った、接続用URLを QR コードにする部分です。
