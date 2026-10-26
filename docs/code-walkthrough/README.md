# direct-share コード解説

direct-share のソースコードを1行ずつ理解するための解説です。
TypeScript・MQTT・WebRTC の知識は、それが初めて出てくる回の冒頭で説明します。

## 進め方

- 依存の少ないファイルから順に読みます（後のファイルは前のファイルの部品を使っているため）
- 各回は「前提知識 → ファイルの全体像 → 1行ずつの解説 → 動かして確認 → 理解チェック」の順です
- 理解チェックの答えは、各回の最後に折りたたんであります

## 目次

| 回 | 対象 | 主な前提知識 |
|---|---|---|
| [第0回](00-overview.md) | 全体像と土台（`package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`） | TypeScript とは何か、Vite、モジュール |
| 第1回 | `src/base32.ts`：接続コードの変換 | 基本の型、ビット演算 |
| 第2回 | `src/connInfo.ts`：コードとURLの解釈 | ユニオン型、型の絞り込み |
| 第3回 | `src/settings.ts`：設定の保存 | `Record`、`readonly`、`unknown`、localStorage |
| 第4回 | `src/crypto.ts`：鍵とトピック名の導出、暗号化 | `Promise`、`async`/`await`、ハッシュ・HKDF・AES-GCM |
| 第5回 | `src/mqtt.ts`：MQTT クライアント | MQTT 入門、WebSocket、`class` |
| 第6回 | `src/signaling.ts`：複数ブローカーでの暗号化通信 | `interface`、`Set` と `Map` |
| 第7回 | `src/connection.ts`：WebRTC の接続確立 | WebRTC 入門、クロージャ、タイマー |
| 第8回 | `src/session.ts` 前半：送信 | データチャネル、送信バッファと流量制御 |
| 第9回 | `src/session.ts` 後半：受信・キャンセル・メモリ管理 | 状態の移り変わり |
| 第10回 | `src/main.ts`：画面と操作 | DOM、イベント |
| 第11回 | `src/qr.ts`：QRコード生成 | QR の構造、誤り訂正 |
| 第12回 | テストとデプロイ、`style.css` の要点 | テスト、モック、GitHub Actions |
