# direct-share コード解説

direct-share のソースコードを1行ずつ理解するための解説です。
TypeScript・MQTT・WebRTC の知識は、それが初めて出てくる回の冒頭で説明します。

## 進め方

- 依存の少ないファイルから順に読みます（後のファイルは前のファイルの部品を使っているため）
- 各回は「前提知識 → ファイルの全体像 → 1行ずつの解説 → 動かして確認 → 理解チェック」の順です
- 理解チェックの答えは、各回の最後に折りたたんであります
- 「気づいた点」として、今のコードで改善できそうな点や、注意が必要な点も挙げています

## 目次

| 回 | 対象 | 主な前提知識 |
|---|---|---|
| [第0回](00-overview.md) | 全体像と土台（`package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`） | TypeScript とは何か、Vite、モジュール |
| [第1回](01-base32.md) | `src/base32.ts`：接続コードの変換 | 基本の型、ビット演算 |
| [第2回](02-conninfo.md) | `src/connInfo.ts`：コードとURLの解釈 | ユニオン型、型の絞り込み、URL |
| [第3回](03-settings.md) | `src/settings.ts`：設定の保存 | `Record`、`readonly`、`unknown`、localStorage |
| [第4回](04-crypto.md) | `src/crypto.ts`：鍵とトピック名の導出、暗号化 | `Promise`、`async`/`await`、ハッシュ・HKDF・AES-GCM |
| [第5回](05-mqtt.md) | `src/mqtt.ts`：MQTT クライアント | MQTT 入門、WebSocket、`class` |
| [第6回](06-signaling.md) | `src/signaling.ts`：複数ブローカーでの暗号化通信 | シグナリング、`Set`、重複の除去 |
| [第7回](07-connection.md) | `src/connection.ts`：WebRTC の接続確立 | WebRTC 入門（SDP、ICE、STUN、DTLS）、クロージャ |
| [第8回](08-session-send.md) | `src/session.ts` 前半：送信 | データチャネル、送信バッファと流量の調整 |
| [第9回](09-session-receive.md) | `src/session.ts` 後半：受信・メモリの管理・終了 | 状態の移り変わり、判別可能なユニオン型 |
| [第10回](10-main.md) | `src/main.ts`：画面と操作 | DOM、イベント、非同期処理の追い越し |
| [第11回](11-qr.md) | `src/qr.ts`：QR コード生成 | QR の構造、リード・ソロモン符号、マスク |
| [第12回](12-tests-deploy-css.md) | テスト、デプロイ、`style.css` の要点 | 自動テスト、モック、GitHub Actions |

## 解説で挙げた「気づいた点」の一覧

| 回 | 内容 | 影響 |
|---|---|---|
| 第0回 | `style.css` を `index.html` と `main.ts` の両方で読み込んでいる | 開発中に CSS が2回読み込まれるだけ |
| 第1回 | 全角の英数字（`ｇ４` など）を半角に直さない | エラーで原因は分かる。`.normalize('NFKC')` で対応できる |
| 第2回 | URL を1文字ずつ手で打つと、先頭が `HTTP-S://` のように崩れる | 見た目だけで、接続には影響しない |
| 第3回 | 設定の保存時に、localStorage の例外を受け止めていない | localStorage が使えない環境で保存できない |
| 第4回 | 復号の前の長さチェックが13バイト（厳密には IV と認証タグの28バイトでよい） | 短いデータは復号で失敗するので、結果は同じ |
| 第5回 | PINGRESP が返ってこなくても気づけない | シグナリングは30秒で打ち切るので、実用上は小さい |
| 第6回 | 途中で切れたブローカーに、つなぎ直さない | 残りのブローカーで足りる想定 |
| 第8回 | テキストの分割のコメント「64KB未満」は、制御文字ばかりの場合は当てはまらない | 上限の 256KB には収まる |
| 第9回 | メモリが足りないとき、解放しても足りずに拒否する場合も、保存済みのファイルを解放してしまう | 保存済みなので困ることは少ない |
| 第10回 | URL の直後に空白なしで日本語が続くと、日本語までリンクになる | 「コピー」で正しい URL は取り出せる |
| 第10回 | 1MB にわずかに足りないサイズが「1024KB」と表示される | 表示だけ |
| 第12回 | CI で型チェックを2回行っている。GitHub Actions に Node.js 20 非推奨の警告 | 動作に影響なし |
| 第12回 | `.qr svg` の `image-rendering: pixelated` は SVG には効かない | 見た目に影響なし |
