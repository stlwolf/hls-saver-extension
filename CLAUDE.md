# HLS Stream Saver - Chrome Extension

## 概要

ブラウザで再生されるHLSストリーミング動画（m3u8 + tsセグメント）を、**再リクエストなしで**ローカルに保存するChrome Extension。

### 背景・動機

- DevToolsのHAR Export方式では、大容量動画（数百セグメント、数GB）の場合にChromeのメモリ制限で古いレスポンスボディが破棄される
- 再リクエストを飛ばすとサーバー側のレート制限や監視に引っかかる可能性がある
- 既にブラウザが取得済みのレスポンスを「そのまま」保存したい

### 解決アプローチ

ページのグローバル`fetch()`をフックし、HLS関連ファイル（.ts, .m3u8）のレスポンスをリアルタイムでIndexedDBに保存。後からまとめてダウンロード。

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                        Web Page                             │
│                                                             │
│  fetch() / XHR ──┬──▶ Original Request ──▶ Server          │
│                  │                                          │
│                  ▼                                          │
│  ┌──────────────────────────────┐                          │
│  │   content-main.js (MAIN)     │  ← fetch/XHRをフック      │
│  │   - Pattern match (.ts等)    │                          │
│  │   - Clone response           │                          │
│  │   - postMessage to ISOLATED  │                          │
│  └──────────────┬───────────────┘                          │
└─────────────────│───────────────────────────────────────────┘
                  │ window.postMessage
                  ▼
┌──────────────────────────────────┐
│  content-isolated.js (ISOLATED)  │  ← Chrome API使用可能
│  - Receive from MAIN             │
│  - chrome.runtime.sendMessage    │
└──────────────┬───────────────────┘
               │ chrome.runtime.sendMessage
               ▼
┌──────────────────────────────────┐
│  background.js (Service Worker)  │
│  - IndexedDB管理                 │
│  - chrome.downloads API          │
│  - 統計管理                       │
└──────────────────────────────────┘
               ▲
               │ chrome.runtime.sendMessage
┌──────────────┴───────────────────┐
│  popup.html / popup.js           │
│  - UI表示                         │
│  - Download / Clear 操作          │
└──────────────────────────────────┘
```

### なぜ2つのContent Scriptが必要か

Manifest V3では、Content Scriptはデフォルトで**ISOLATED world**で実行される。ISOLATEDワールドからはページの`window.fetch`にアクセスできない。

- `content-main.js`: `"world": "MAIN"`指定でページと同じコンテキストで実行。`fetch()`をフック可能。ただしChrome APIは使えない。
- `content-isolated.js`: Chrome APIが使える。MAINからのpostMessageを受け取り、backgroundに転送するブリッジ役。

---

## ファイル構成

```
hls-saver-extension/
├── manifest.json          # Extension設定（Manifest V3）
├── content-main.js        # MAINワールド: fetch/XHRフック
├── content-isolated.js    # ISOLATEDワールド: ブリッジ
├── background.js          # Service Worker: IndexedDB, Downloads
├── popup.html             # ポップアップUI
├── popup.js               # ポップアップロジック
├── icon16.png             # アイコン
└── icon48.png
```

### 各ファイルの責務

| ファイル | 責務 |
|----------|------|
| `manifest.json` | 権限、スクリプト登録、Manifest V3設定 |
| `content-main.js` | `fetch()`と`XMLHttpRequest`のモンキーパッチ。対象URLパターンにマッチしたらレスポンスをクローンしてpostMessage |
| `content-isolated.js` | MAINからのメッセージを受信し、`chrome.runtime.sendMessage`でbackgroundに転送 |
| `background.js` | IndexedDBへの保存/取得/削除、`chrome.downloads`でのファイル保存、統計管理 |
| `popup.js` | 統計表示、ON/OFF切替、ダウンロード/クリア操作のUI |

---

## 技術的な設計判断

### 1. IndexedDBを使う理由

- `chrome.storage.local`は容量制限が厳しい（5MB〜unlimitedでも不安定）
- IndexedDBはより大容量に対応（ブラウザストレージの50%程度まで）
- BlobやArrayBufferを直接保存可能

### 2. DataURLでダウンロードする理由

Manifest V3では`chrome.downloads.download()`に渡せるURLに制限がある。Blob URLは作成したコンテキスト外からアクセスできないため、DataURLに変換してからダウンロード。

**トレードオフ**: DataURL変換はメモリを食う。大量ファイルのダウンロード時は100msのdelayを入れてメモリ解放を待つ。

### 3. 対象パターン

```javascript
const TARGET_PATTERN = /\.(ts|m3u8|m4s)(\?.*)?$/i;
```

- `.ts`: MPEG-TS セグメント（HLS）
- `.m3u8`: HLSプレイリスト
- `.m4s`: fMP4セグメント（DASH/HLS）

必要に応じて拡張可能。

---

## 既知の制限・TODO

### 制限

1. **DRM保護コンテンツ**: Widevine/FairPlay等で暗号化されたセグメントは保存できても復号できない
2. **Service Worker再起動**: 長時間アイドルでService Workerが停止。次のメッセージで復帰するが、稀にIndexedDB接続が切れる可能性
3. **ダウンロード速度**: 数百ファイルを個別にchrome.downloads経由で保存するため時間がかかる

### 改善候補

- [ ] ZIPでまとめてダウンロード（JSZipライブラリ導入）
- [ ] m3u8を書き換えてローカルパスに変換（そのままffmpegで結合可能に）
- [ ] 特定ドメインのみキャプチャするフィルタ機能
- [ ] キャプチャ開始/停止のキーボードショートカット
- [ ] セグメント重複チェック（同じファイル名の上書き防止）
- [ ] ダウンロード進捗のプログレスバー
- [ ] オフスクリーンドキュメントでのバックグラウンド処理強化

---

## 開発時の注意

### Manifest V3の制約

- `background.js`は永続的でない（Service Worker）。状態はIndexedDBか`chrome.storage`に保存
- `eval()`や`new Function()`は使用不可
- リモートコード実行不可

### デバッグ方法

1. `chrome://extensions/` → 該当Extensionの「Service Worker」リンクをクリック → DevToolsが開く
2. Content Scriptのログはページ側のDevTools Consoleに出る（`[HLS Saver]`プレフィックス）

### テスト用サイト

- HLS.js Demo: https://hlsjs.video-dev.org/demo/
- 任意のHLS配信サイト

---

## 使用例

```bash
# ダウンロードされたファイルの結合（ffmpeg）
cd ~/Downloads/hls_segments/
ffmpeg -i playlist.m3u8 -c copy output.mp4

# m3u8がない場合、tsファイルを直接結合
cat *.ts > combined.ts
ffmpeg -i combined.ts -c copy output.mp4
```

---

## 依存関係

- Chrome Extension Manifest V3
- IndexedDB API
- chrome.downloads API
- 外部ライブラリなし（Vanilla JS）
