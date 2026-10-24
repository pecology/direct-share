# direct-share

GitHub Pages の静的ページだけで、2台の端末（PC・スマホ）の間でテキストとファイルを直接やり取りするツールです。
自前のサーバーは持たず、WebRTC による端末同士の直接通信（P2P）で送受信します。

詳しい仕様は [requirements.md](requirements.md) を参照してください。

## 使い方

1. 片方の端末でページを開くと、QRコードと接続コードが表示されます（ホスト）
2. もう片方の端末で、次のどれかの方法で参加します（ゲスト）
   - スマホの標準カメラでQRコードを読み取り、表示されたURLを開く
   - ページを開いて「この端末から参加する」を選び、接続コードまたはURLを入力して「接続」
   - 接続用URLを直接開く
3. 接続するとチャット風の画面になり、テキストとファイル（1ファイル100MBまで）を送り合えます

- 接続情報の有効期限は10分で、1回の接続にのみ使えます
- 履歴はどこにも保存されず、切断した時点で消えます
- 異なるネットワーク間では、回線によっては接続できないことがあります（TURN非対応）。その場合は同じWi-Fiで試してください

## 仕組み

| 段階 | 内容 |
|---|---|
| 接続情報 | 80ビットのランダムな秘密値。接続コード（Crockford's Base32、16文字）またはURLの `#` 以降で受け渡す |
| シグナリング | 公開MQTTブローカー（複数）経由でWebRTCの接続情報を交換。秘密値から導出した鍵（HKDF → AES-GCM）で暗号化する |
| データ通信 | WebRTC のデータチャネル（DTLSで暗号化）。ファイルは64KBずつ分割して送る |

STUNサーバーとMQTTブローカーは、画面右上の歯車アイコンから変更できます（設定はブラウザのlocalStorageに保存）。

実行時の外部ライブラリは使っていません。QRコード生成・MQTTクライアント・Base32なども自作です。

## 開発

必要なもの：Node.js 22 以上

```bash
npm install
```

```bash
npm run dev
```

`http://localhost:5173/direct-share/` を開くと動作します。同じブラウザで2つのタブを開けば、1台で接続を試せます。

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバーを起動 |
| `npm run typecheck` | TypeScript の型チェック |
| `npm test` | ユニットテスト（Node.js 標準のテストランナー） |
| `npm run build` | 型チェックのあと `dist/` にビルド |

### ファイル構成

| ファイル | 内容 |
|---|---|
| `src/main.ts` | 画面の切り替えと操作 |
| `src/connection.ts` | ホスト・ゲストの接続処理（シグナリング〜データチャネル確立） |
| `src/signaling.ts` | 複数ブローカーへの同時送信、暗号化、重複除去 |
| `src/mqtt.ts` | MQTT 3.1.1 over WebSocket の最小クライアント |
| `src/session.ts` | 接続後のテキスト・ファイルの送受信 |
| `src/crypto.ts` | 秘密値・鍵・トピック名の導出と暗号化 |
| `src/qr.ts` | QRコード生成 |
| `src/base32.ts` / `src/connInfo.ts` | 接続コード・接続用URLの組み立てと解釈 |
| `src/settings.ts` | 外部サーバー設定の読み書きと検証 |

## デプロイ

`main` ブランチにプッシュすると、GitHub Actions（`.github/workflows/deploy.yml`）が型チェック・テスト・ビルドを行い、GitHub Pages に公開します。

初回のみ、リポジトリの Settings → Pages で Source を「GitHub Actions」にしてください。
公開URLは `https://<ユーザー名>.github.io/direct-share/` です。
