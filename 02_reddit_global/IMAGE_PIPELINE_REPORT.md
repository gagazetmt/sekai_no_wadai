# 画像取得パイプライン 報告書

作成: 2026-06-02 / 担当: ローカルミア（Claude Code）

---

## 概要

V3ランチャーで使う画像素材の取得・分類・管理パイプラインを構築した。
案件ごとに公式Xから画像を取得し、Gemini Vision で選手・リーグ・クラブを識別して
専用フォルダに自動格納。動画生成で使われた画像はスコア加算で長期保存、
使われない画像は自然に淘汰される仕組み。

---

## アーキテクチャ全体図

```
【案件発生】
  ↓
warehouse_fetch.js
  クラブ公式X 2クエリ
  ① from:{handle} {shortName} filter:images   → 名前直撃 20枚
  ③ from:{handle} filter:images since:30日前  → 直近いいね上位 20枚
  ↓
images/warehouse/pending/{tweetId}.jpg + .json（メタデータ）

  ↓
warehouse_recognize.js
  Gemini 2.5 Flash Vision で認識
  → { category, player/entity, contentType, confidence }
  ↓
  confidence >= 0.75 → 格納
  confidence  < 0.75 → images/warehouse/rejected/（手動確認用）

  ↓（カテゴリ別振り分け）
  player → images_stock/players_official/{player-slug}/{player-slug}_NNN.jpg
  league → images_stock/leagues/{league-slug}/{contentType}_NNN.jpg
  club   → images_stock/clubs/{club-slug}/{contentType}_NNN.jpg

  ↓
各フォルダの score.json に score:0 で登録

【動画生成時】
  /api/v3/generate-video
  → recordImageUsage(usedImages)
  → 使った画像の score +1 / lastUsed 更新

【スコア管理】
  動画採用: +1点
  宝箱ドロップ(UI): そのフォルダの最高スコア+1点
  20枚超過時: 低スコア順（同点は古い順）に自動削除
```

---

## ファイル構成

### 新規スクリプト

| ファイル | 役割 |
|---|---|
| `scripts/warehouse_fetch.js` | X API 2クエリで画像DL → pending/ |
| `scripts/warehouse_recognize.js` | Gemini Vision 認識 → リネーム → フォルダ格納 → index追記 |
| `scripts/image_score_manager.js` | score.json 管理・加点・20枚上限剪定 |
| `scripts/warehouse_process_vps_images.js` | VPS既存画像（images/*.jpg）を pending/ にコピー |
| `scripts/migrate_stock_to_player_folders.js` | クラブフォルダ→選手フォルダ構造移行（移行済み・再実行不要） |

### ストレージ構造

```
images_stock/
  players_official/
    {player-slug}/              ← 選手名フォルダ（クラブ横断）
      {player-slug}_001.jpg
      {player-slug}_002.jpg
      score.json                ← スコア台帳
    premier-league/             ← 旧ストック（1850枚・既存構造を維持）
      arsenal/{player}.png
      liverpool/{player}.png
      ...

  leagues/                      ← 新設（ロゴ・トロフィー等）
    premier-league/
      logo_001.jpg
      trophy_001.jpg

  clubs/                        ← 新設（ロゴ・スタジアム・集合写真）
    liverpool/
      logo_001.jpg
      stadium_001.jpg
      squad_001.jpg

images/
  warehouse/
    pending/   ← 処理待ち（通常は空）
    rejected/  ← confidence低い・要手動確認

data/
  players_official_index.json   ← warehouse格納分が自動追記される
  leagues_index.json            ← 新設
  clubs_index.json              ← 新設
```

---

## V3 server.js の変更点

| エンドポイント | 変更内容 |
|---|---|
| `/api/v3/generate-narration` | 旧 `resolveImages()` → `fetchAndAssignSlideImages()` に差し替え |
| `/api/v3/fetch-slide-images` | 画像のみリフレッシュ（ナレーション再生成不要）|
| `/api/v3/boost-image-score` | 宝箱ドロップ → 最高スコア+1 |
| `/api/v3/generate-video` | 動画生成時に `recordImageUsage()` を自動呼び出し |

### sharedImagePool

全スライドの画像候補を1つの共有プールに集約。
スライドごとの個別ギャラリーは廃止。
`currentPlan.sharedImagePool` としてクライアントに保持。

### 宝箱 UI

ギャラリー検索ボタン右横の `🪙` アイコンにドラッグ&ドロップ
→ そのフォルダ内最高スコア+1点付与
→ 実質「永続保存マーク」として機能

---

## v3_image_fetcher.js（全面書き直し）

`v3_launcher/v3_image_fetcher.js` は V3ナレーション生成後の画像自動割当モジュール。

### スライドタイプ別戦略

| スライドタイプ | 取得戦略 |
|---|---|
| stats / profile / comparison | ストック優先 → X公式（名前明記） → X公式（リプ欄スコア） → 汎用X |
| それ以外 | X汎用検索 → Wikimedia（Xが少ない時のみ） → ストック |

### スコアリング（改善版）

- キーワードを1語ずつ個別評価（長いキーワードを高ウェイト）
- 本文に選手名あり: +25%
- リプ欄名前頻度ボーナス（`REPLY_SCORE_ENABLED=true` 時）: +20%
- エンゲージメント: +10% / 新しさ: +5% / 配置フィット: +15%

### API コスト削減

- ストックスコア >= 80 → Xスキップ
- 同クラブのツイートはセッション中キャッシュ共有（複数選手でも1回フェッチ）
- `X_CALL_BUDGET=12`（デフォルト）で1動画あたりの上限制御

---

## コスト実績

### X API（twitterAPI.io）

| 処理 | 消費クレジット | USD |
|---|---|---|
| Robertson テスト（REPLY_ON, budget=20） | 2,010 | $0.002 |
| 想定1動画（4エンティティ・REPLY_OFF） | ~800 | $0.0008 |

### Gemini 2.5 Flash Vision

| 処理 | 枚数 | コスト |
|---|---|---|
| ローカル _legacy 処理 | 64枚 | $0.0025（¥0.37） |
| VPS 旧V1/V2画像処理 | 139枚 | ~$0.0054（¥0.81） |
| **1,000枚処理の場合** | 1,000枚 | **~$0.04（¥6）** |

---

## 現在のストック状況（2026-06-02 時点）

- VPS `players_official/` 新warehouse構造: **82選手フォルダ / 計3,544枚**
- ローカル `players_official/` 新warehouse構造: **13選手フォルダ**
- 旧ストック（1850枚・premier-league/等のフォルダ構造）: **VPSのみ・維持**

---

## 透かし問題（未解決・次回判断）

公式Xから取得した画像に PA Images / Getty / Reuters の透かしが混入する。

| 案 | 内容 | 状態 |
|---|---|---|
| A | そのまま使う（人間が目視確認） | **現在採用** |
| B | Wikimediaのみ | — |
| C | Geminiで透かし自動検出 | クラブ公式グラフィックも誤検出するリスクがあり見送り |

`images/warehouse/rejected/` を定期的に目視して判断する運用。

---

## 未実装（次セッション候補）

- warehouse_fetch + warehouse_recognize のワンコマンド統合スクリプト
- V3ギャラリーUI: 選手名・クラブ名タグ表示
- leagues/ clubs/ の初期ストック整備（既存 club_logos_index / stadiums_index との統合）
- stock_match.js に scene / category フィルタ追加（現在はキーワードマッチのみ）

---

## 実行コマンド一覧（VPS上）

```bash
# 案件の選手画像を取得 → pending に入れる
node scripts/warehouse_fetch.js "Andrew Robertson" "Liverpool"

# pending を認識 → 選手/リーグ/クラブフォルダに格納
node scripts/warehouse_recognize.js

# 旧V1/V2画像（images/）を一括処理
node scripts/warehouse_process_vps_images.js
node scripts/warehouse_recognize.js

# score.json 初期化（全フォルダ）
node scripts/image_score_manager.js init
```
