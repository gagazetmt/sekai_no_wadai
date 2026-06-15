# Codex Mia Handover

Last updated: 2026-06-15 JST

---

# V4 ランチャー 設計書（2026-06-15 現在）

## 概要

V4ランチャーは速報サッカー動画の自動生成パイプライン。4部門のニュースソースからトピックを収集し、AIがネタブック（動画構成データ）を生成し、V2/V3スライドエンジンで2〜3分の動画を出力する。

- **VPS**: PM2 `soccer-yt-v4` / port 3020
- **サーバー**: `v4_launcher/v4_server.js`（Express）
- **開発フロー**: ローカル → git push → VPS `git pull` + `pm2 restart soccer-yt-v4`

## アーキテクチャ全体図

```
┌─────────────────────────────────────────────────────────────┐
│ V4 ランチャー (port 3020)                                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Step 1: スカウト (v4_scout.js)                              │
│    4部門並列取得 → 12hフィルタ → 重複排除 → AI選定            │
│         ↓                                                   │
│  Step 2: ネタブック (v4_neta.js)                              │
│    ニュース検索(5件) + コメント倉庫(3ソース)                   │
│    → リネカAI → 構成・ラベル・サムネ・メタデータ生成            │
│         ↓                                                   │
│  Step 2.5: データ・画像取得 (v4_assets.js)                    │
│    assetLabels → SofaScore/FotMob/TM/Wiki + X公式画像         │
│         ↓                                                   │
│  Step 3: 生成前確認 (UI)                                     │
│    スライド編集・並替・TTS設定・画像選択                       │
│         ↓                                                   │
│  Step 4: 動画生成 (v4_video.js → render.js)                  │
│    V2/V3スライドビルダー → TTS → ffmpeg → MP4               │
│                                                             │
│  ＋ サムネ生成 (v4_thumb_gen.js / v4_thumb_render.js)         │
│  ＋ YouTube投稿 (youtube_uploader.js) ※メタデータ自動生成済み  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Step 1: スカウト (`v4_scout.js`)

### 4部門ニュースソース

| 部門 | API/方法 | 取得件数 |
|---|---|---|
| **X** | twitterapi.io advanced_search (JP+EN) + Japan Trends | 〜40件 |
| **Yahoo** | Brave Search `site:news.yahoo.co.jp` | 〜20件 |
| **Reddit** | JSON API `/r/soccer` + `/r/JapanSoccer` (top/hot/rising/new) | 〜200件 |
| **5ch** | `5ch_fetcher.js` (football/eleven/mnewsplus) | 〜50件 |

### フィルタリング

1. **12時間フィルタ** (`_isWithinHours`): 速報特化。12h超えの候補を除外
   - ISO日付、Brave age文字列（"3 hours ago"）、日本語（"3時間前"）対応
   - date が null のもの（Trends等）は通す
2. **ソース内重複排除** (`_dedup`): URL完全一致 + タイトルbigram類似（72%閾値）
3. **48時間使用済み排除** (`used_topics.json`): 過去選定トピックとの重複防止
4. **AI選定** (DeepSeek): 各ソース最大15件 → 各5件選定 + 2chフック文生成

### 重複排除アルゴリズム

- `_normalizeTitle`: 小文字化 + NFKC + 記号除去 + 定型語削除
- `_bigrams`: 文字bigram集合で類似度計算（72%で重複判定）
- `_entityTokens`: 漢字2-6字 / カタカナ3-12字 / ラテン4字+ のトークン抽出
- `EVENT_GROUPS`: 同義語クラスタ（移籍≈加入≈退団、負傷≈離脱≈欠場 等）

### 出力

`data/scout_results.json`: `{ scoutedAt, topicCount, topics[] }`

## Step 2: ネタブック (`v4_neta.js`)

### ニュース検索 (`_fetchLatestNews`)

案件名をキーワードにBrave Searchで最新ニュースを取得（旧`_fetchArticles`を置換）。

- **2クエリ**: EN（漢字除去 + "latest news"）+ JA（案件名 + "最新 ニュース"）各10件
- **信頼メディア優先ソート**: V3の`TRUSTED_DOMAIN_HINTS`を移植・拡張

| 信頼スコア | ドメイン例 |
|---|---|
| 1.0 | fifa.com, bbc.com, espn.com, skysports.com, reuters.com, marca.com, theathletic.com, news.yahoo.co.jp, nikkansports.com, sponichi.co.jp 等 |
| 0.8 | .edu, .gov |
| 0.7 | wikipedia.org |
| 0.4 | その他 |

- **上位5件**を選定。本文取得（最大2000字）、取れなければスニペットで補完
- 出力に `trustScore`, `isTrusted` フラグ付き

### コメント倉庫 (`_buildCommentWarehouse`)

3ソース並列取得 → `_comments_{topicKey}.json` にキャッシュ（v5）

| ソース | 方法 | 上限 |
|---|---|---|
| Reddit | 元スレURL → `.json` API → top comments | 25件 |
| Yahoo | Brave Search → Yahoo News記事 → コメント欄抽出 | 15件 |
| X | `conversation_id:{tweetId}` → 返信のみ | 20件 |

### リネカAI ネタブック生成

AI（DeepSeek or Claude Sonnet）が1 API callで全フィールドを生成。

**リネカのペルソナ**: サッカー専門CD、20代前半。感情軸1本でコンテンツを構築。

#### 主要出力フィールド

| フィールド | 説明 |
|---|---|
| `title` | 2ch風タイトル（〜40字） |
| `overview` | 概要（150〜250字） |
| `supplement1/2` | 補足テキスト（100〜200字、null可） |
| `comments1` | コメントスライド1（3〜4件、40〜80字/件）**必須** |
| `comments2` | コメントスライド2（3〜4件、40〜80字/件）**必須** |
| `mainEntity` | 主役の英語名 |
| `keyPlayer` | 試合MVP等（試合ネタ必須） |
| `keyManager` | 監督名（試合・チームネタ推奨） |
| `otherPlayers` | その他注目選手（1〜2件） |
| `subEntities` | 副役（対戦相手等） |
| `structurePattern` | standard / interleaved / rapid |
| `supplementType` | ルール順判定（下記参照） |
| `supplementData` | 型固有の表示データ |
| `assetLabels` | 画像・データ取得用ラベル（最大5件） |
| `thumbLine1/2` | サムネ用テキスト |
| `thumbComment` | サムネ煽りコメント |
| `ytTitle` | YouTube動画タイトル（〜60字） |
| `ytDescription` | YouTube概要欄（100〜200字） |
| `ytTags` | YouTube検索タグ（5〜10件） |

#### 補足スライド型（ルール順判定）

| 優先順 | 型 | 条件 |
|---|---|---|
| 1 | **matchcard** | 試合結果・スコアが確認できる |
| 2 | **stats/profile** | 選手の活躍・数値が中心 |
| 3 | **comparison** | 2者比較ネタ |
| 4 | **ranking** | 順位・ランキング（根拠あり） |
| 5 | **timeline** | 複数時点の数値推移 |
| 6 | **insight** | 上記以外で補足あり |
| 7 | **picture** | 画像中心・テキスト不要 |

#### コメントスライドのルール

- `comments1` と `comments2` は**両方必須**（null禁止）
- 2スライドを**カテゴリで分ける**:
  - 国内反応(Yahoo/5ch) vs 海外反応(Reddit/X)
  - Aチーム vs Bチーム
  - 賞賛・期待 vs 批判・不安
- 1件あたり **40〜80字** 目安（短文のみは NG）
- 外国語コメント → 意訳OK
- 日本語コメント → 長短調整の意訳OK（感情トーン維持）

#### 動画構成パターン

| パターン | スライド構成 |
|---|---|
| **standard** | OP → 概要 → 補足 → コメント1 → コメント2 → ED |
| **interleaved** | OP → 概要 → コメント1 → 補足 → コメント2 → ED |
| **rapid** | OP → 概要 → コメント1 → コメント2 → ED |

## Step 2.5: データ・画像取得 (`v4_assets.js`)

### ラベル生成

**assetLabels優先**: リネカが提案した最大5件のラベルからデータソースを自動展開。

| ラベルtype | 生成されるデータソース |
|---|---|
| player | SofaScore + FotMob + Transfermarkt + Wikipedia |
| manager | SofaScore + Wikipedia |
| team/nationalTeam | Wikipedia |

assetLabelsが無い場合は従来のフォールバック（mainEntity/keyPlayer/keyManager/otherPlayersから推論）。

### データ取得（並列実行）

| ソース | 取得内容 |
|---|---|
| **SofaScore** | 市場価値、国籍、シーズン成績、評定、代表通算 |
| **FotMob** | キャリア通算出場/ゴール/アシスト、選手画像 |
| **Transfermarkt** | 負傷状況、負傷履歴 |
| **Wikipedia** | 概要、サムネ、記事内画像（最大6枚） |
| **Stock Match** | ローカル画像リポジトリ検索 |

### X画像取得（強化版）

各assetLabelの所属チーム/代表から公式Xハンドルを `team_x_accounts.json` で検索。

| 取得パターン | クエリ | 上限 |
|---|---|---|
| **最新画像** | `from:{handle} has:images -is:retweet` queryType:Latest | 15件/ハンドル |
| **関連度画像** | `from:{handle} {topicKeyword} has:images -is:retweet` queryType:Top | 15件/ハンドル |
| **トピック画像** | `"{topic}" has:images -is:retweet lang:en` queryType:Latest | 10件 |

### 画像スコアリング・選定

- 優先順: official-index → FotMob → X関連 → X公式 → SofaScore → Stock(90+) → Wikipedia → X一般 → その他
- URL重複排除
- 上限: **40枚**
- `v4_image_selector.js` で mood-based スコアリング（funny/cool）→ サムネ1枚 + スライド用6枚を選定

## Step 3: 生成前確認（UI）

- 各スライドの type/title/narration/コメント/画像を編集可能
- スライド並替
- TTS設定（Gemini/MiniMax/Voicevox、voice/speed/style）
- ライブプレビュー（V3スライドHTML）

## Step 4: 動画生成 (`v4_video.js` → `render.js`)

V2/V3スライドビルダーを再利用。

### スライドビルダー（`scripts/v2_video/slides/`）

- opening (v1/v2/v3)
- picture, insight, stats, profile, comparison, timeline, ranking, matchcard
- reaction
- ending (v1/v2/v3)

### レンダリングパイプライン

1. ネタブック → `buildModules()` → モジュールJSON
2. 各モジュール → スライドHTML生成
3. TTS（Gemini/MiniMax/Voicevox）→ 音声ファイル
4. ffmpeg → スライド画像 + 音声 + BGM → MP4連結
5. 出力: `data/v2_videos/*.mp4`（2〜3分、4〜6スライド）

## サムネ生成 (`v4_thumb_gen.js` / `v4_thumb_render.js`)

ネタブックの `thumbLine1`, `thumbLine2`, `thumbComment` をそのまま渡して1280×720px PNGを生成。

- **v4_thumb_gen.js**: uwasathefootball2スタイル。Puppeteerレンダリング
  - パラメータ: bgImage, line1, line2, comment, accentColor, bgPosition, bgBrightness, titleSize
- **v4_thumb_render.js**: Template A (band) / B (photo) の2パターン

## YouTube投稿メタデータ

ネタブックに `ytTitle`, `ytDescription`, `ytTags` が自動生成される。

- `youtube_uploader.js` でそのままアップロード可能
- OAuth2認証済み（`.youtube_tokens.json`）
- カテゴリ: Sports (17)
- サムネ自動設定（2MB以下に自動圧縮）

## コスト構造

| 項目 | コスト目安 |
|---|---|
| スカウト + ネタブック（DeepSeek） | 〜¥0.5/本 |
| ニュース検索（Brave Search） | 無料枠内 |
| X画像取得（twitterapi.io） | $15/月定額 |
| TTS（Gemini/MiniMax） | 未計測 |
| **目標**: 1本あたり | ¥1〜3 |

## API エンドポイント

| Method | Path | 説明 |
|---|---|---|
| POST | `/api/scout` | スカウト実行 |
| GET | `/api/scout/latest` | 最新スカウト結果 |
| POST | `/api/neta` | ネタブック生成 |
| POST | `/api/video` | 動画生成 |
| GET | `/api/video/status/:jobId` | 動画生成状況 |

## ファイル構成

```
v4_launcher/
├── v4_server.js              # Express サーバー
├── scripts/
│   ├── v4_scout.js            # ニューススカウト
│   ├── v4_neta.js             # ネタブック生成
│   ├── v4_assets.js           # データ・画像取得
│   ├── v4_video.js            # 動画モジュール生成
│   ├── v4_thumb_gen.js        # サムネ生成
│   ├── v4_thumb_render.js     # サムネテンプレート
│   └── v4_image_selector.js   # 画像スコアリング
├── data/
│   ├── scout_results.json     # スカウト結果
│   ├── used_topics.json       # 使用済みトピック(48h)
│   └── neta_books/            # ネタブックキャッシュ
│       ├── _index.json
│       ├── neta_*.json
│       └── _comments_*.json   # コメント倉庫(v5)
├── public/                    # フロントエンドUI
├── thumb/                     # サムネHTMLテンプレート
└── thumbs/                    # 生成サムネ出力先
```

## 共有モジュール（V2/V3と共用）

```
scripts/
├── ai_client.js               # Claude/DeepSeek APIラッパー
├── youtube_uploader.js         # YouTube Data API v3
├── modules/
│   ├── stock_match.js          # 選手/チーム/監督名マッチング
│   └── fetchers/
│       ├── brave_search_module.js
│       ├── article_fetcher.js
│       ├── 5ch_fetcher.js
│       ├── sofascore_player.js / sofascore_team.js / sofascore_manager.js
│       ├── fotmob_career.js
│       ├── transfermarkt_player_games.js / transfermarkt_player_injuries.js
│       └── wikipedia.js
└── v2_video/
    ├── render.js              # ffmpegレンダラー
    ├── tts_engine.js          # TTS統合エンジン
    └── slides/                # スライドHTMLビルダー群
```

## 外部サービス依存

| サービス | 用途 | 認証 |
|---|---|---|
| twitterapi.io | X検索・画像取得 | `TWITTER_API_IO_KEY` ($15/月) |
| Brave Search | ニュース検索 | `BRAVE_API_KEY` |
| DeepSeek | スカウト選定・ネタブック生成 | `DEEPSEEK_API_KEY` |
| Anthropic Claude | ネタブック生成（Sonnet選択時） | `ANTHROPIC_API_KEY` |
| SofaScore | 選手・チームデータ | Webshare proxy経由 |
| FotMob | キャリア統計 | 直接API |
| Transfermarkt | 負傷情報 | Webshare proxy経由 |
| Wikipedia | 概要・画像 | curl-cffi経由 |
| YouTube Data API v3 | 動画アップロード | OAuth2 |

---

## V4 更新ログ（新しい順）

### 2026-06-15: 速報特化3課題修正

- スカウト12時間フィルタ追加
- ニュース検索を信頼メディア優先5件に強化（`_fetchLatestNews`）
- assetLabels（リネカ提案5件）導入
- X画像取得を関連度+最新各15件に強化、画像上限24→40
- コメントスライド両方必須+カテゴリ分け+40-80字目安
- 補足スライド型をルール順判定に変更
- サムネテキスト・YouTubeメタデータ自動生成をネタブックに追加

---

## 2026-06-13 JST Update - V4 Label-Driven Data and Image Fetch Repair

### Root Cause

- The V4 `データ取得ラベル` panel was display-only.
- It showed AI-generated `supplementData` fields but was not connected to the V3 SofaScore / Transfermarkt / Wikipedia fetchers.
- Image search still worked through `mainEntity`, but it was not driven by the displayed labels.

### Fixed

- Added `v4_launcher/scripts/v4_assets.js`.
- V4 now creates up to three entity labels and fetches them in parallel:
  - SofaScore player/team/manager data
  - Transfermarkt player identity and injury history
  - Wikipedia summary, source URL, and thumbnail
- Wikipedia direct access returns HTTP 403 from the VPS, so V4 falls back to the existing Webshare/curl-cffi path.
- Label entities are also used to search the shared official/stock image indexes.
- Added `POST /api/neta/assets`.
- Existing cached neta books are backfilled when opened.
- Newly generated neta books save `dataLabels`, `fetchedData`, `assetImages`, and warnings.
- Stats/profile supplements can use fetched rows as `dataSlots`.
- The slide confirmation step now waits for data/image acquisition to finish.

### VPS Verification

- Live test entity: `Wataru Endo`.
- Result:
  - labels: 3
  - fetched rows: 7
  - images: 13
  - sources: SofaScore, Transfermarkt, Wikipedia
  - warnings: 0
- Deployed to V4 port 3020.
- Backup:
  - `/root/sekai_no_wadai/02_reddit_global/backups/20260613_v4_label_assets`
- Restarted only `soccer-yt-v4`; V2 and V3 remained online.

---

## 2026-06-13 JST Update - V4 Pre-Generation Slide and TTS Review

### Implemented

- Expanded the V4 launcher from three steps to four:
  - `ネタ収集`
  - `ネタブック`
  - `生成前確認`
  - `動画生成`
- Added a pre-generation editor that uses the V3 slide modules produced by `buildModules(book)`.
- Users can edit each slide's type, title, narration, reaction comments, and image, then reorder slides before rendering.
- Added live V3 slide HTML previews through `POST /api/confirm/preview`.
- Added shared TTS controls for provider, voice, model, speed, and Gemini style instructions.
- Added Gemini/MiniMax preset loading and an asynchronous TTS preview API.
- Reaction slides use their comments as the preview speech when narration is empty.
- Confirmed modules and TTS settings are passed unchanged into final video generation.
- Custom TTS settings switch the renderer to legacy per-module audio generation so provider and voice selections are honored.
- Full-auto generation continues to skip the manual review step.

### Verification and VPS Deployment

- Local syntax checks passed for `v4_server.js`, `v4_video.js`, and the inline browser script.
- API verification produced six test modules and valid V3 preview HTML.
- Gemini returned 30 voices; MiniMax returned 13 voices.
- Browser verification on the live VPS confirmed:
  - five generated slides for the Endo topic
  - reaction comment editing
  - Gemini/MiniMax provider switching and preset refresh
  - preview iframe loading
  - zero browser console errors
- Deployed to V4 port 3020 with backup:
  - `/root/sekai_no_wadai/02_reddit_global/backups/20260613_v4_confirm_step`
- Restarted only `soccer-yt-v4`; V2 and V3 remained online.
- Paid TTS preview and final video rendering were not triggered during verification.

---

## 2026-06-13 JST Update - V4 Neta Data and Image Panels

### Implemented

- Added three panels directly below the V4 neta book/comment editor and above the video-generation button:
  - `データ取得ラベル`
  - `取得データ`
  - `画像ギャラリー`
- Data labels show up to three labels from `book.dataLabels`, or derive candidates from `supplementData.dataSlots`.
- Acquired data renders structured supplement values from stats/profile/comparison/timeline/ranking/matchcard data.
- Added `GET /api/neta/images?q=...` to search shared V2/V3 stock images for players, managers, clubs, logos, and stadiums.
- The gallery automatically searches with `mainEntity`, supports a manual search, and allows one image to be selected for the video.
- The selected image is stored in `book.selectedImages` and now takes priority over the previous automatic first-match image in `v4_video.js`.

### Verification and VPS Deployment

- Local `node --check` passed for `v4_server.js` and `v4_video.js`.
- Inline browser JavaScript syntax validation passed.
- Browser verification confirmed the three panels are positioned below comments and above the video button.
- Gallery verification with `Ibrahima Konate` returned an image and the selected state worked.
- Deployed to V4 port 3020 with backup:
  - `/root/sekai_no_wadai/02_reddit_global/v4_launcher/backups/20260613_neta_assets`
- Restarted only `soccer-yt-v4`; V2 and V3 were not restarted.
- VPS image API returned stock candidates, all three labels were present in served HTML, and V2/V3/V4 remained online.

---

## 2026-06-13 JST Update - V4 Comment Warehouse v5

### Fixed

- Confirmed the original warehouse was incorrectly treating Yahoo search/article snippets and ordinary X topic posts as comments.
- Yahoo collection now opens matching Yahoo News articles and stores only extracted user comments from each article's comment page.
- X collection now runs only for an X/Twitter status source URL and stores replies in that source post's conversation.
- Added deduplication, broken-character rejection, Yahoo related-headline rejection, and X news-summary/bot-style rejection.
- If real comments cannot be collected, the source remains empty instead of being padded with article text.
- Added `version: 5` to warehouse JSON. Older warehouse caches are automatically rebuilt.
- Exported `buildCommentWarehouse()` for no-AI diagnostics.

### VPS Deployment and Verification

- Deployed the final `v4_neta.js` to V4 on port 3020 and restarted only `soccer-yt-v4`.
- V4 remained online with zero unstable restarts.
- Earlier invalid warehouse files were archived at:
  - `/root/sekai_no_wadai/02_reddit_global/v4_launcher/backups/20260613_023951/comment_warehouse_v1/`
- Final source backup:
  - `/root/sekai_no_wadai/02_reddit_global/v4_launcher/backups/20260613_031800/v4_neta.js`
- Live no-AI rebuild results:
  - Canada match topic: Yahoo real comments 15, Reddit 0, X 0.
  - Endo withdrawal topic: Yahoo real comments 15, direct X replies 12, Reddit 0.
- Verified that the previously observed unrelated Kaka article headline, mojibake comment, and X news-summary reply were absent from the final v5 warehouses.

---

## 2026-06-13 JST Update - V4 Structure Selection and V3 Slide Reuse

### V4 Neta Editor UI Cleanup

- Removed the read-only duplicate text displayed above the editable fields for title, overview, supplement 1, and supplement 2.
- The V4 neta editor now shows only the editable textareas.
- Comment warehouse controls remain unchanged.
- Deployed `v4_launcher/public/index.html` to VPS port 3020.
- Backup created at `v4_launcher/backups/20260613_022415/index.html`.
- The static UI update was served immediately without interrupting the V4 job that was running at deployment time.
- Public root check returned HTTP 200.

### VPS Deployment

- Deployed the updated V4 structure backend to:
  - `/root/sekai_no_wadai/02_reddit_global/v4_launcher/scripts/v4_neta.js`
  - `/root/sekai_no_wadai/02_reddit_global/v4_launcher/scripts/v4_video.js`
- Preserved the existing V4 UI, scout implementation, data, thumbnails, and slide assets.
- Remote backup created at:
  - `/root/sekai_no_wadai/02_reddit_global/v4_launcher/backups/20260613_015122`
- Restarted only PM2 app `soccer-yt-v4`.
- V2 `soccer-yt-v2` and V3 `soccer-yt-v3` remained online and were not restarted.
- Deployment verification:
  - Local/VPS SHA256 hashes matched for both deployed files.
  - Remote `node --check` passed for `v4_server.js`, `v4_neta.js`, and `v4_video.js`.
  - `soccer-yt-v4` remained online with zero unstable restarts.
  - VPS localhost root and API returned HTTP 200.
  - VPS public-IP checks for `http://37.60.224.54:3020/` and `/api/neta/cached` returned HTTP 200.

### Implemented

- Reworked `v4_launcher/scripts/v4_neta.js` so the Rineka AI response now includes:
  - `structurePattern`: `standard`, `interleaved`, or `rapid`
  - `supplementType`: `picture`, `insight`, `stats`, `profile`, `comparison`, `timeline`, `ranking`, or `matchcard`
  - `supplementTitle` and type-specific `supplementData`
  - `commentAngle1`, `commentAngle2`
  - `endingPunch`
- Changed nested JSON extraction to use the first `{` through the last `}` so `supplementData` objects parse correctly.
- Reworked `v4_launcher/scripts/v4_video.js` to stop generating new V4-only slide types.
- V4 now builds modules with the existing V2/V3 slide library:
  - `opening`
  - `picture`
  - one optional best-fit supplement slide
  - `reaction`
  - `ending`
- Supported structures:
  - `standard`: OP -> overview -> supplement -> reaction 1 -> reaction 2 -> ED
  - `interleaved`: OP -> overview -> reaction 1 -> supplement -> reaction 2 -> ED
  - `rapid`: OP -> overview -> reaction 1 -> reaction 2 -> ED
- Output is constrained to 4-6 slides. Sparse input gets a minimal `insight` fallback.
- Structured supplement types are validated before use. Missing required display data automatically demotes the slide to `insight`.
- ED now uses only `endingPunch` as its spoken line. The normal CTA text is blanked.
- Exported `buildModules()` for deterministic, no-cost structure testing.

### Verification

- `node --check` passed for both modified files.
- Structure tests passed:
  - `standard`: 6 slides
  - `interleaved`: 6 slides
  - `rapid`: 5 slides
  - sparse rapid input: 4 slides
- All eight supplement types produced the expected module type with valid sample data.
- Invalid structured `stats` data correctly fell back to `insight`.
- A paid one-video live E2E run was completed after the static verification:
  - Scout -> neta book -> structure selection -> Gemini TTS -> Whisper ASR -> slide render -> MP4 concat all completed.
  - Selected topic: `遠藤航のW杯離脱・代表引退`
  - Generated structure: `standard`, `insight`
  - V4 modules: 5; renderer inserted TOC, producing 6 rendered slides.
  - Final duration: 106.9 seconds.
  - Final size: 16,887,849 bytes.
  - Output: `data/v2_videos/_______1781306812220_202606122326.mp4`
  - Logged DeepSeek scout+neta cost: approximately JPY 0.38. TTS/ASR cost was not logged, so total per-video cost remains unverified.

### E2E Findings

- The technical pipeline is capable of completing a video.
- The result is shorter than the 2-3 minute target.
- Scout acquired X results, but Yahoo and Reddit failed; article retrieval returned zero articles.
- The generated script therefore lacks sufficient multi-source grounding and must not yet be treated as production-safe.
- `Wataru Endo` did not resolve to a stock image, leaving the generated slides without a subject image.
- Opening pronunciation/ASR should be reviewed, especially bracketed labels such as `【悲報】` and English entity names.

### Still Pending

1. Add the comment warehouse selection UI with add, remove, and reorder controls.
2. Add 1-3 grounded data labels from SofaScore, Transfermarkt, and Wikipedia.
3. Add official club/national-team X image acquisition to the V4 flow.
4. Expand FullAuto from one top story to a 5-7 video batch.
5. Add the 00:00 / 12:00 scheduled batch runner.
6. Compare Gemini, MiniMax, and Voicevox quality/cost for V4.
7. Measure the complete per-video cost against the JPY 1-3 target.

---

## 2026-06-08 JST Update - Mobile Step1 Reversion Root Cause Notes

**Canonical handover note:** Going forward, update this file as the latest handover source. Do not rely on `C:\Users\USER\Documents\速報サッカー\handover.md`; that file is older and described the previous Step5 4-slot thumbnail direction.

### User-reported current bugs

1. On mobile, zooming the launcher screen can force the UI back to the initial Step1 screen.
2. On mobile, editing the Step4 insight text can force the UI back to Step1.
3. While FullAuto is running for one case, touching another case can force the UI back to Step1.

### Confirmed code-level findings

- The launcher always calls `goStep(1)` on page boot in `local_v2_launcher.js` inside `DOMContentLoaded`.
  - It restores `v2_selected_id`, but it does not restore the active step.
  - Therefore any mobile Safari/Chrome tab reload, crash recovery, memory-pressure reload, or page reinitialization lands on Step1 even when the selected case exists.
- Step4 still performs a heavy preview load on initialization.
  - `routes/step4_routes.js` `step4Init()` calls `_reloadPreview()` unconditionally.
  - `_reloadPreview()` builds a 1920x1080 preview HTML Blob and assigns it to an iframe.
  - Mobile auto-preview after input was disabled, but the initial Blob iframe still exists on mobile and can contribute to memory pressure during zoom, keyboard open, resize, and editing.
- Step4 text input saves aggressively.
  - `s4OnInput()` debounces at 350ms and calls `_saveAndReload()`.
  - On mobile `_reloadPreview()` is skipped after input, but `_collectInputs()` and `_saveModulesQuiet()` still run.
  - `_saveModulesQuiet()` POSTs the full `window.APP.s4.modules` array to `/api/save-modules` on each debounced edit.
  - This is likely too heavy for mobile when combined with the existing preview iframe and virtual keyboard resize.
- Insight `catchphrases` inputs are inconsistent.
  - The generated `.s4-phrase` input does not have `oninput="s4OnInput()"` in the current Step4 renderer, unlike title/narration/dataSlots.
  - This is probably a separate save/consistency bug, but it can make insight editing behavior feel unreliable.
- FullAuto front-end polling is not case-safe.
  - `runAutopilot()` captures the starting `post` but, when the job finishes, it unconditionally calls `goStep(25)` or `goStep(4)`.
  - It does not check whether `window.APP.selected.id` still equals the job's original `post.id`.
  - If the user switches to another case during FullAuto, the old job can hijack the current screen.
- FullAuto does not use the existing `runJob` / `resumeStoredJobs` localStorage recovery mechanism.
  - If the mobile browser reloads during FullAuto, the normal boot path runs and lands on Step1.
  - Other routes have resumable job helpers, but this FullAuto path is manually polling via `fetchJson`.

### Most likely root causes by symptom

1. **Mobile zoom -> Step1**
   - Not caused by an explicit zoom handler.
   - Most likely: zoom causes heavy mobile relayout / Safari memory pressure while Step4 preview iframe is present -> page reload/crash recovery -> launcher boot calls `goStep(1)`.

2. **Mobile insight edit -> Step1**
   - Most likely: input opens keyboard and fires `s4OnInput()` -> full modules collection/save runs while large preview iframe is still in memory -> mobile tab reload/crash recovery -> boot calls `goStep(1)`.
   - If the edited field is `catchphrases`, also note the missing `oninput` handler on `.s4-phrase`, which should be fixed separately.

3. **FullAuto running while another case is touched -> Step1**
   - Two likely contributors:
     - Old FullAuto job completion can call `goStep(4)`/`goStep(25)` without checking the active case, hijacking the UI.
     - If mobile reloads during the long-running job, the boot path lands on Step1 because active step is not restored and FullAuto has no resumable localStorage job record.

### Recommended fix plan, no code applied yet

1. **Persist and restore active step**
   - Store `v2_active_step` whenever `goStep(n)` runs.
   - On boot, after restoring `v2_selected_id`, navigate to the saved active step if a selected case exists.
   - Fall back to Step1 only when there is no selected case or the saved step is invalid.
   - This is the main safety net: even if mobile reloads, the user does not get dumped to Step1.

2. **Mobile Step4 preview should be manual-only**
   - In `step4Init()`, skip `_reloadPreview()` when `_isMobile` is true.
   - Show an empty/lightweight preview placeholder and let the existing `更新` button generate the preview manually.
   - Also consider clearing/revoking the previous Blob URL when leaving Step4 or when mobile preview is disabled.

3. **Throttle mobile Step4 editing**
   - On mobile, change `s4OnInput()` debounce from 350ms to roughly 1500ms, or save on `blur` for large textareas.
   - Prefer saving only the active module/slide if an endpoint can be added safely; otherwise keep full save but reduce frequency.
   - Keep `_collectInputs()` guarded and avoid re-rendering editor during normal typing.

4. **Fix insight catchphrase input consistency**
   - Add `oninput="s4OnInput()"` or an equivalent event listener to `.s4-phrase` inputs.
   - Confirm whether user means narration, dataSlots, or catchphrases when saying "insight text" during QA.

5. **Make FullAuto case-safe**
   - Capture `const startedPostId = post.id` in `runAutopilot()`.
   - Before any completion navigation, check `window.APP.selected?.id === startedPostId`.
   - If the user is now editing another case, do not call `goStep`; only show a notification/status such as "別案件のFullAutoが完了".

6. **Make FullAuto resumable**
   - Either convert the FullAuto client path to `runJob`, or store `{ jobId, postId, mode }` in localStorage and resume polling on reload.
   - On resume, do not auto-navigate unless the currently selected case matches the job's `postId`.

### Suggested implementation order

1. Active step persistence/restore.
2. Mobile Step4 initial preview skip/manual preview only.
3. FullAuto startedPostId guard.
4. Mobile Step4 input debounce/blur strategy.
5. FullAuto localStorage recovery.
6. `.s4-phrase` input save consistency.

---
## 🚨 URGENT: Step4 Mobile Crash — Insight Textbox Editing Forces Navigate to Step1

**Status:** Unresolved as of 2026-06-08. Handed over to Codex for investigation.

### Symptom
- On mobile (iPhone/Safari or Chrome), editing the **insight textbox** in Step4 slide editor
  triggers an immediate navigation back to Step1.
- Also reported: "問題が繰り返し起きました" (browser tab crash) during Step4 editing.

### What was already tried (did NOT fix it)
1. **Preview HTML base64 removal** (`_common.js`: `imgDataUri` now returns URL for `/`-prefixed paths;
   `mapImagesToModulePreview` added; `_buildSlideForPreview` uses it) — reduces blob size but crash persists.
2. **Mobile auto-preview disabled** (`step4_routes.js`: `_isMobile` flag added;
   `_saveAndReload` skips `_reloadPreview()` on mobile) — still crashes on textbox edit.
3. **Autopilot concurrency lock** (`local_v2_launcher.js`: `_apRunning` flag) — unrelated.

### Most likely root cause (not yet confirmed)
When the user types in a textbox in Step4, `oninput="s4OnInput()"` fires, which debounces and calls
`_saveAndReload()`. On mobile this only calls `_saveModulesQuiet()` (POST `/api/save-modules`).
**Hypothesis:** The POST fails (server error, timeout, or body-parser OOM), an unhandled rejection
propagates, and some error handler navigates to Step1.

Alternatively: a **JavaScript exception** in the Step4 editor itself (possibly from `_collectInputs()`
reading a DOM element that no longer exists, or from `_renderEditor()` being called during a state
inconsistency) crashes the step, and the global error handler resets to Step1.

### Where to look

1. **`routes/step4_routes.js`** — search for `goStep(1)` or any navigation-on-error logic in the
   Step4 client-side JS (near the bottom of the file, ~line 1870–3990).
2. **`routes/step4_routes.js` — `_collectInputs()`** — may throw if a DOM element is missing on
   mobile layout.
3. **`local_v2_launcher.js`** — global error handler or `goStep` logic that might trigger on
   uncaught exceptions.
4. **`routes/step3_routes.js` — `save-modules` endpoint** (line ~180) — check if it can fail in a
   way that causes navigation.

### Suggested investigation steps
1. Add `window.onerror = function(msg, src, line) { alert('ERR: '+msg+' '+line); }` temporarily
   to catch the JS exception location on mobile.
2. Check if `_collectInputs()` in step4 has any code that could throw on mobile layout
   (missing DOM elements, null references).
3. Check if there's a `catch` block anywhere in Step4 that calls `goStep(1)`.
4. Check if `fetchJson` failure in `_saveModulesQuiet` propagates up despite the try/catch.

### Related commits (today 2026-06-08)
- `430e3a1` fix(step4): preview base64 → URL (browser memory fix)
- `de11410` fix(step4): base tag for Blob URL image resolution
- `70b93a8` fix(mobile): autopilot lock + mobile preview auto-update disabled

---



## 2026-06-07 JST Update - Step5 Gemini 3.1 Thumbnail Pipeline

### Product Decision

- Step5 now generates two selectable, text-included finished thumbnail candidates.
- Image generation uses OpenRouter model `google/gemini-3.1-flash-image-preview`.
- Do not switch this flow back to Vertex Imagen without a new quality comparison.
  - Vertex Imagen was usable for scene generation but scored much lower than Gemini Flash for Japanese soccer thumbnails.
  - Direct Google AI Studio image calls often returned `OTHER` or an empty image response for the same real-person request.
  - OpenRouter routing to Gemini 3.1 Flash Image produced the best tested balance of face reference, Japanese typography, and thumbnail composition.
- Current approximate generation cost is about USD 0.136 for two images, roughly JPY 20-21 at JPY 150/USD.

### Current Step5 Flow

1. When Step5 opens, Gemini 2.5 Flash reads the case context and auto-fills the thumbnail brief.
   - Source data includes `data/{postId}_modules.json`.
   - It also reads V2.5 plan entities and retrieved article titles/snippets from `data/v25_plans/{postId}.json`.
   - It returns four scene candidates plus:
     - context line
     - badge
     - main text
     - punch line
     - short editorial reason
   - UI button `AI再提案` regenerates the brief.
2. Face scoring checks acquired case images and stock images.
   - Official league/player stock must remain included.
   - Official sources are prioritized, followed by other stock and acquired X/case images.
   - The selected face plus up to three top reference images are sent to image generation.
3. `POST /api/v5/gen-bg-from-face` generates candidates sequentially.
   - Sequential generation is intentional. Parallel A/B calls produced more empty OpenRouter responses.
   - Each variant retries up to three times when Gemini returns HTTP 200 without image data.
4. Gemini creates two 16:9 finished thumbnails with Japanese text.
   - A: main person large on the right, text emphasis on the left.
   - B: diagonal/opposition layout using club colors, stadium, supporters, or crest-like elements.
   - Both use the entered context, badge, main text, and punch line.
5. Clicking A or B selects it as the finished thumbnail.
   - The selected filename is saved through `/api/v5/select-thumb`.
   - Step6 reads the same selected thumbnail metadata.
6. The legacy SVG compositor remains available as a fallback for correcting generated Japanese text.

### Prompt Guardrails

- The case-information model may choose the editorial conflict and visual emphasis, but it must not invent actions.
- For unconfirmed transfers, do not depict:
  - signing a contract
  - airport travel
  - an unveiling or press conference
  - wearing the destination club shirt
  - meeting a manager or president
- Use an editorial collage instead:
  - current player image
  - current club and interested club colors/stadium/crest
  - strong lighting and a clean text zone
- Avoid phones, newspapers, screens, signs, and documents that cause unreadable generated text.

### Main Implementation

- `routes/step5_routes.js`
  - `_collectThumbnailStoryContext()`: modules, V2.5 entities/articles, briefing
  - `/v5/suggest-bg-prompts`: Gemini 2.5 Flash JSON thumbnail brief
  - `_generateGemini31Thumb()`: OpenRouter Gemini 3.1 Flash Image call and retry
  - `/v5/gen-bg-from-face`: A/B finished-thumbnail generation
  - Step5 UI: auto-fill, AI regeneration, A/B selection
- Relevant commits:
  - `13a1ae0` selectable Gemini 3.1 A/B backgrounds
  - `f95ffa9` Japanese text included in A/B outputs
  - `6aa2ccc` automatic brief generation from case context

### Verification

- Tested with the Alexis Mac Allister / Real Madrid case.
- Auto brief successfully produced case-specific Japanese text and four grounded visual candidates.
- A/B image generation successfully returned two 16:9 PNG files with Japanese text.
- `soccer-yt-v2` is online on VPS port 3004.
- Permanent launcher architecture is recorded in `memory/launcher_architecture.md`.

## 2026-06-03 JST Update - V2.5 Pivot Implementation

### Direction Locked

- User and Mia decided not to keep forcing V3 as the main launcher.
- New architecture: V2 is the mothership, with only the stronger V3 assets grafted in.
- Step ownership:
  - Step1 case selection: V2
  - Step2-1 through Step2-4 search query / labels / data acquisition: V2
  - Step3 proposal A/B/C: V3 AI, using data acquired by V2 Step2
  - Script structure: V2-compatible structure generated from the selected V3 proposal, then validated against V2 SI data
  - Script generation: V2
  - Editing: V2
  - Image acquisition: V3 image fetcher, including named/official-X logic and improved image selection
  - Video generation: V2
- Known continuing issue: subtitle bar timing can drift from narration timing. Keep this as an open follow-up for Step6/video generation.

### Implemented

- Added V2.5 autopilot route: routes/v25_autopilot_routes.js
- Added header button in local_v2_launcher.js: V2.5 AUTO
- Exported V2 Step2 internals for reuse: _runSuggestLabels and _runFetchAll
- Exported V2 Step3 internals for future reuse: _runProposeModules and _runScenarioJob
- V2.5 job flow:
  - Runs V2 label suggestion
  - Filters sentence fragments and contextual Alonso noise
  - Runs V2 fetch-all
  - Builds V3 proposal A/B/C with generateAIPlan
  - Converts the selected V3 proposal into V2-compatible modules
  - Guards stats/profile/comparison against real V2 SI bindings
  - Demotes invalid comparison to insight instead of allowing hallucinated comparisons
  - Attaches V3 image fetcher results to modules
  - Saves proposal details to data/v25_plans/{postId}.json
  - Saves final modules to data/{postId}_modules.json

### Verification

- Local syntax checks passed for local_v2_launcher.js, routes/step2_routes.js, routes/step3_routes.js, routes/v25_autopilot_routes.js
- Local require checks passed for routes/v25_autopilot_routes.js and local_v2_launcher.js
- Deployed to VPS /root/sekai_no_wadai/02_reddit_global
- Restarted PM2 app soccer-yt-v2
- VPS checks:
  - GET http://127.0.0.1:3004/ returned 200 and contains V2.5 AUTO
  - GET /api/v25/plan?postId=__missing__ returned 200 with plan not found JSON

### Next Review Points

- Confirm a real case run from the V2 UI.
- Confirm A/B/C proposals are saved in data/v25_plans and that the selected proposal feels better than V3's old end-to-end output.
- If user wants visible A/B/C selection inside V2, add a compact proposal review panel before Step3 modules.
- Continue tracking subtitle bar / narration drift as a separate video-generation issue.

## 2026-06-02 JST Update - V3 Launcher Recipe / Step2 / Step5 Fix Log

### Completed

- V3 recipe list was rebuilt as the current working master.
  - Sec1 Player: 21 recipes
  - Sec2 Manager: 11 recipes
  - Sec3 Team, including national teams: 11 recipes
  - Sec4 Tournament: 7 recipes
  - Total: 50 recipes
- Recipe Launcher entry in the V3 launcher header was removed.
  - `/recipes` page/API still exist for maintenance, but the normal user-facing entry is hidden.
- Step2-3 was reframed from keyword extraction to story-cast extraction.
  - It now asks AI to read the retrieved articles and return only story-key proper nouns: players, managers, teams, tournaments, national teams, stadiums.
  - Labels can include `role`, `reason`, and `dataNeeded`.
  - Ordinary Reddit comment fragments and vague words such as `Jesus` are filtered out.
- Step2-4 now fetches data only for labels marked `dataNeeded: true`.
  - Extra guard added before SofaScore/Transfermarkt prefetch to reject ordinary sentence fragments, source names, and vague one-word labels.
- Step4 -> Step5 script transition was fixed.
  - `confirmBriefingAndGoScript()` now calls `generateScriptFromStructure()`.
  - Before the fix, it only moved to Step5 with an empty `scriptDraft`, so the user saw no generated script.
- Deployed to VPS and restarted only `soccer-yt-v3`.

### Verification

- Local: `node --check v3_launcher/server.js`, `node --check v3_launcher/v3_research.js`
- VPS: `node --check v3_launcher/server.js`, `node --check v3_launcher/v3_research.js`, `pm2 restart soccer-yt-v3 --update-env`
- Latest health result: `{"ok":true,"name":"v3-launcher-prototype","port":3010}`

### Product Direction

The user rates the launcher around 65/100 and wants Mia to move it closer to 100 by understanding the intended workflow, not just patching bugs.

Core intent to preserve:

- V3 should complete the flow without handing the user back to V2: case selection -> article/data retrieval -> proposal generation -> planning brief/script structure -> V2-grade slide editing inside V3 -> video generation.
- Step2 should feel like an editorial research desk: search articles, read them, identify story-cast labels, fetch only useful structured data, then build proposals.
- Step3/4 should feel like the user is approving a production spec, not fighting raw AI output.
- Step5 should start from a usable V2-grade editor state, with text/data/image preview already available.
- Do not touch V2 unless explicitly requested.
- Be careful while Claude is working on image acquisition logic; avoid duplicating or overwriting image-fetch changes.

### Next High-Impact Improvements

- Run a live end-to-end check on the Arne Slot case after the latest fix.
- Improve Step2-3 display so users can clearly see label name, type, story role, data-fetch status, and reason.
- Improve Step5 first-load state so embedded V2-grade editing loads cleanly when `scriptDraft` exists, and shows a recovery button when it does not.
- Add a lightweight production-readiness check before video generation: slides, narration, key data, images.

---
## 2026-06-02 JST Update - 画像取得強化 + Warehouse システム構築

### 背景と設計経緯

V3 の画像取得を強化する議論の中で以下の問題が判明:
- 旧設計: キーワードを1文字列に結合して `stock_match` のみ → 精度が低い
- `from:LFC filter:images` で取得した画像が実際には別選手を映している問題
- X API のトークン消費が 1 動画あたり最大 $0.10 になる恐れ

### 最終設計方針

**取得クエリ（2クエリ構成）**
- ① `from:{handle} {shortName} filter:images -filter:retweets` — 名前直撃 20 枚
- ③ `from:{handle} filter:images -filter:retweets since:30日前` queryType:Top — 直近いいね上位 20 枚
- ② Latest 30 は③に吸収されるため削除
- コスト: 1 動画 (選手 3 + クラブ 1) × 約 2 クエリ/エンティティ ≒ **$0.04/本**

**Warehouse システム（画像格納庫）**
1. `warehouse_fetch.js` で `images/warehouse/pending/` にDL（メタデータ JSON を同名で保存）
2. `warehouse_recognize.js` で Gemini 2.5 Flash Vision が認識 → 選手名でリネーム
3. 信頼度 0.75 以上 → `images_stock/players_official/{club-slug}/` に格納 + index 追記
4. 信頼度未満 → `images/warehouse/rejected/` に隔離（手動確認用）
5. `players_official_index.json` に自動追記 → `stock_match.js` が即座に拾える

### 新規ファイル

| ファイル | 役割 |
|---|---|
| `scripts/warehouse_fetch.js` | X API 2クエリで画像DL → pending/ |
| `scripts/warehouse_recognize.js` | Gemini Vision 認識 → リネーム → stock格納 |
| `v3_launcher/v3_image_fetcher.js` | V3スライド画像取得・自動割当（全面書き直し） |

### V3 server.js の変更

| 変更 | 内容 |
|---|---|
| `/api/v3/generate-narration` | 旧 `resolveImages()` → `fetchAndAssignSlideImages()` に差し替え |
| `/api/v3/fetch-slide-images` | 画像のみリフレッシュ用エンドポイント追加 |
| `sharedImagePool` | 全スライドの画像候補を1プールに集約（スライド個別ギャラリー廃止） |
| `renderV3StockGallery` | source バッジ (W=Wikimedia, X=公式X) 表示対応 |

### 動作確認済み（ローカル）

Robertson × Liverpool で実行:
- `warehouse_fetch.js` → 43 枚 DL
- `warehouse_recognize.js` → 採用 23 枚 / 却下 7 枚
- 認識結果例: Andrew Robertson (×7), Mohamed Salah (×3), Virgil van Dijk, Alexis Mac Allister 等
- `players_official_index.json` に自動追記済み

### 画像保存先

```
images_stock/players_official/liverpool/
  andrew-robertson_001.jpg 〜 _007.jpg
  mohamed-salah_001.jpg 〜 _003.jpg
  virgil-van-dijk_001.jpg
  ... (計 23 枚)

images/warehouse/
  pending/   ← 処理待ち（通常は空）
  rejected/  ← 信頼度不足（手動確認用）
```

**ローカル Web URL（V3 launcher 起動時）**:
`http://localhost:3005/images_stock/players_official/liverpool/andrew-robertson_001.jpg`

**VPS URL（デプロイ後）**:
`http://37.60.224.54:3010/images_stock/players_official/liverpool/andrew-robertson_001.jpg`

### ⚠️ 透かし問題メモ（次セッション判断用）

クラブ公式X（@LFC等）から取得した画像にも PA Images / Getty / Reuters のライセンス写真が混入する。
最初のテスト画像で「Peter Byrne - PA Images」透かしを確認済み。

**対策3案:**

| 案 | 内容 | メリット | デメリット |
|---|---|---|---|
| A | **そのまま使う** | 工数ゼロ・高品質画像が使える | グレーゾーン（Getty等は自動検出強化中） |
| B | **Wikimediaのみに戻す** | 完全フリー・法的リスクなし | 画像が古い・試合写真が少ない |
| C | **Gemini透かし判定追加** | 自動フィルタ | クラブ公式の加工グラフィックも弾く恐れあり |

**相棒の判断（2026-06-02）: 案A採用検討中**
- Getty/AFP程度なら人間の目で透かし判定できる
- Gemini（案C）は良質なクラブ公式グラフィックまで弾くリスクがある
- warehouse/rejected/ に隔離してから人間が確認する運用で対応可能

### 未実装（次セッション候補）

- `warehouse_fetch.js` + `warehouse_recognize.js` のワンコマンド統合スクリプト
- V3 ギャラリー UI: 選手名・クラブ名タグ付き表示
- ドラッグ&ドロップ → stock 格納 UI
- V3 generate-narration 実行時に warehouse フローを自動トリガー

### X API トークン実績（参考）

Robertson テスト実行（REPLY_SCORE_ENABLED=true, budget=20）:
- 実消費: 2,010 クレジット ($0.002/回)
- 見積もり 1 動画 (4 エンティティ): 約 $0.064

---

## Today Summary - 2026-05-30

V3 launcher Step2 was rebuilt around the user's goal: proposals and slides should reflect the planning brief and pass the right data forward.

Main work completed today:

- Added the Recipe Launcher page and then improved its mobile editor flow.
- Reworked Step2 into visible stages: Step2-1 query labels, Step2-2 article hits, Step2-3 story labels, Step2-4 free data fetch, Step2-5 proposal generation.
- Added clear progress while running research: `1/5 検索クエリを作成` through `5/5 企画書A/B/Cを作成`.
- Cleared stale research/fetched/proposal data when starting a new case, selecting a new case, editing title/memo/source, or rerunning Step2.
- Improved query generation so it uses compact exact-topic queries instead of long repeated phrases.
- Forced proper nouns from the title/memo to become mandatory labels before AI planning.
- Reworked query/label generation around a generic rule: proper nouns in the title/memo become mandatory labels before AI planning.
- This avoids dropping named players/teams in cases like the England squad example, without hardcoding a case-specific exception.
- Japanese article titles/material bullets are generated for the UI; original titles are not needed in the display.
- Added type badges for labels such as player, manager, team, match, and wiki.
- Removed the duplicated top SofaScore data block and kept fetched data inside Step2-4.
- Step2-4 now shows richer data cards/slots from SofaScore, Transfermarkt, and Wiki.
- Proposal A/B/C now supports short / standard / long video options and variable slide counts.
- Selected proposal slide outlines are passed into the Step3 briefing path.
- Added Step2-6 insufficient-data check before moving to Step3.
- Added an `追加指示` textarea under Step2-6; its text is appended to the memo before re-research.
- Added AI/Serper/cost/model/webshare-bandwidth notes for each Step2 stage.
- Updated and deployed V3 to VPS multiple times, restarting only `soccer-yt-v3`.

Verification performed today:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_research.js`
- `node --check v3_launcher/v3_planner.js`
- Local HTML checks for progress display, Step2-6, cost display, and additional-instruction textarea.
- VPS health checks on `http://127.0.0.1:3010/api/v3/health`.

Not done today:

- Full live Step2 research was intentionally not run unless necessary, to avoid spending Serper/AI credits.

## Latest Update - 2026-05-30 Step2 rebuild

User approved the Step2 fix plan and asked to implement while showing, for each stage, AI/Serper usage, model, cost, AI-change recommendation, and webshare bandwidth impact.

Implemented in `v3_launcher/`:

- Step2-1 now creates short query labels and deduplicated compact search queries instead of repeating long phrases.
- Step2-2 displays Japanese article titles only; original titles are kept only internally as fallback.
- Step2-3 label candidates now carry type badges such as player / manager / team / wiki.
- Removed the old top-level SofaScore fetched-data block; Step2-4 is the single place for fetched free data.
- Step2-4 cards now show richer fetched slots per label from SofaScore / Transfermarkt / Wiki results.
- Step2-5 uses Japanese material bullets for proposal material, and proposal candidates now carry `videoLengthType`, `targetMinutes`, and `recommendedSlideCount`.
- A/B/C proposals are normalized as short / standard / long and slide outlines are variable, 4-8 slides depending on material.
- The selected proposal's `slideOutline` is passed into the briefing/STEP3 path so slide creation has the actual adopted structure.
- Added a Step2-6 "不足データ確認" gate before moving to STEP3, with missing data, publish gates, fetched data, and a re-research button.
- Added Step2 cost/AI/bandwidth meta in the research material panel.

Verification so far:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_research.js`
- `node --check v3_launcher/v3_planner.js`

Not run yet in this round:

- Full live Step2 research, to avoid spending Serper/AI credits during code verification.

Follow-up UX fix:

- The Step2 research button now shows explicit progress such as `1/5 検索クエリを作成`, `2/5 ニュース記事を取得`, through `5/5 企画書A/B/Cを作成`.
- Starting a Step2 run clears stale previous research/fetched/proposal data before the new job starts.
- Creating or selecting a new case clears prior working data so old acquired data is not prefilled into a different case.
- Manual edits to the case title/memo/source also clear stale Step2 state.

Search/label precision follow-up:

- Added deterministic title-label extraction before Gemini query planning.
- Names/proper nouns in the title and memo are now mandatory labels.
- Search now forces an exact-topic query built from mandatory proper-noun labels before AI-generated queries, instead of relying on case-specific rules.
- Entity expansion keeps mandatory proper-noun labels as data candidates even if Gemini omits them.
- The Step2-6 insufficient-data area now has an "追加指示" textarea. Its content is appended to the memo as `追加指示:` when the user clicks re-research.

## First Read

This file is the active handover for the V3 launcher work. At the start of the next session, read this file before making changes.

Keep V2 preserved. Do not edit or restart V2 unless the user explicitly asks.

## Project Paths

Local project:

`/mnt/c/Users/USER/Documents/side_biz/02_reddit_global`

V3 launcher:

`v3_launcher/`

VPS URL:

`http://37.60.224.54:3010`

VPS project path:

`/root/sekai_no_wadai/02_reddit_global`

PM2:

- V2: `soccer-yt-v2` on port 3004. Preserve it.
- V3: `soccer-yt-v3` on port 3010. Restart only this for V3 deploys.

## Current V3 Goal

Build a V3 "editorial director" layer before the existing V2 video pipeline.

Target flow:

`topic / Reddit / memo -> brief -> arguments -> beats -> slide plan -> research plan -> verified data -> script/TTS`

The user wants V3 to reduce manual work currently spent on:

- slide-by-slide script direction
- data consistency checks
- adding side stories
- increasing script heat and narrative clarity

## Current UI

The V3 launcher is a simple smartphone-friendly prototype.

Current result tabs:

- `1 案件`
- `2 企画提案`
- `3 企画書`
- `4 脚本構成`
- `5 脚本`
- `6 V2`

Recent UX changes:

- Old `リサーチ` / `AI分析` / `テーマ` are combined into `Step2 企画提案`.
- `Step3 企画書` now renders an editable briefing textarea and has `企画書の内容で脚本構成`.
- `Step4 脚本構成` is now a V2-like editor surface with slide type, title, narration, data/source rows, image upload/gallery, and an inline slide preview using `/api/v2/preview-slide-inline`.
- `Step1 案件` can load story candidates by date, select and save them into V2 `saved_projects.json`, then set the selected project into V3 inputs.
- V3 mounts selected V2 API routers for editor reuse: Step3 save modules, Step3.5 image upload/selection, Step4 slide preview.
- 2026-05-27: UI was restyled closer to V2: left sidebar is saved projects, top step nav is sticky, main work area uses V2-style step containers. Colors remain V3 dark/gold.
- 2026-05-27: Step tabs were hardened. V3 now renders only the active step body instead of keeping all step panels in the page and hiding them with CSS. Step1 contains only case selection/input.
- 2026-05-27: Step1 case picker was restyled closer to V2 Step1: date toolbar, selected count, time-group accordions, source badges, checkbox rows.
- 2026-05-27: Saved projects remain in the left sidebar for normal desktop/tablet widths. The responsive breakpoint was lowered so saved projects no longer jump to the top except on narrow mobile.

Important UX preference from the user:

- Keep it simple.
- Avoid long vertical pages.
- Use transitions/tabs for each thinking layer.
- The UI should be human-facing, not JSON-facing.

## Key Files

`v3_launcher/server.js`

- Express standalone launcher.
- Renders the V3 UI.
- Has no-cache headers.
- Shows tabbed result UI.
- Shows slide type, existing/new candidate status, needed data values, and source hints.

`v3_launcher/v3_story_architect.js`

- Builds `argumentPlan`.
- Parses editable brief.
- Converts brief points into grouped chapters, then beats.
- Converts beats into slide plan.
- Adds slide template choice and data requirements.

`v3_launcher/v3_research.js`

- Uses existing V2 fetchers without modifying V2.
- Runs 3 Serper query style topic research.
- Selects 3-5 good URLs per query.
- Fetches article body.
- Fetches capped Wiki side-story candidates.

## Latest Commits

Recent V3 commits:

- `c035f3f feat(v3): show slide templates and data sources`
- `a188a45 feat(v3): add step tabs for design result`
- `bd879fc feat(v3): add slide outline from beats`
- `4850b40 fix(v3): reduce repeated beat details`
- `06f52fb fix(v3): simplify design result view`
- `a0753f6 feat(v3): build beats from editable brief`

GitHub push previously failed because HTTPS credentials were not available. Deploys have been done by `tar` + `scp` directly to VPS.

## Current V3 Behavior

The default sample topic is:

`スペイン代表、レアル・マドリー所属選手0人`

On `設計する`:

1. Reads editable brief.
2. Builds human brief:
   - core
   - answer
   - arguments
   - cautions
3. Builds beats.
4. Builds slide plan.
5. For each slide, shows:
   - slide type
   - existing V2 type or V3 candidate
   - needed data value
   - source hint

Current V2 slide types recognized in V3:

- `opening`
- `history`
- `comparison`
- `stats`
- `profile`
- `insight`

If no existing type fits, V3 can mark it as:

- `argument_map` with `templateStatus: "v3_candidate"`

## Current Research Assessment

The V3 launcher can currently design research direction, but it does not yet fully bind actual values into each slide.

Current working pieces:

- 3-query Serper topic research
- URL selection
- article body fetch
- Wiki side-story fetch
- source hints per slide data requirement

Missing next layer:

`slide.dataSlots[] -> researchTask -> valueCandidate -> sourceUrl -> confidence -> verified/binding`

## User's Important Clarification

The user asked whether the V3 launcher can include an AI like "Codex Mia" that thinks through the solution and research method.

Answer: yes. This should become the core of V3.

The next addition should be a `調査設計` layer/tab.

It should not just search broadly. It should reason:

- What has to be proven?
- What data would prove it?
- What is the most reliable source?
- What query should be used?
- How should extracted values be verified?
- What unsafe claims must be avoided?

Example for the Madrid/Spain topic:

- `2010年スペイン代表メンバー`
  - Source: Wikipedia / FIFA / worldfootball.net.
  - Need: player name + club at tournament.
  - Method: parse squad table and count Barcelona / Real Madrid players.

- `2026年または最新スペイン代表メンバー`
  - Source: RFEF official list or latest reliable news.
  - Need: player name + current club.
  - Method: fetch latest squad, then resolve each player's current club.

- `2010年のバルサ・レアル所属人数`
  - Source: squad table club column.
  - Do not research whole club rosters. Count clubs inside the national squad list.

- `現在のバルサ・レアル所属人数`
  - Source: latest squad list + current club data from SofaScore/FotMob/Transfermarkt/Wiki.
  - Need: count Barcelona and Real Madrid players in that specific squad.

Risk checks:

- Specify the exact squad/list date.
- Do not say "2010 was exactly half Barca and half Madrid" unless data supports it.
- Do not treat Pedri as a Barca academy product.
- Do not treat Raul as a bought gem.
- Do not conclude "Madrid failed at development" too strongly.

## Next Implementation Step

Add a new tab:

- `調査設計`

Suggested tabs after change:

- `ブリーフ`
- `論点`
- `beat`
- `スライド`
- `調査設計`

Suggested research design object:

```json
{
  "need": "2010年スペイン代表メンバーと所属クラブ",
  "method": "Wikipedia/FIFAの2010 squad表からclub列を抽出",
  "query": "2010 FIFA World Cup Spain squad club",
  "expectedOutput": "選手名、所属クラブ、バルサ人数、マドリー人数",
  "sourcePriority": ["Wikipedia", "FIFA", "worldfootball.net"],
  "risk": "2010年を半々と雑に言わない"
}
```

Implementation idea:

- In `v3_story_architect.js`, generate `researchDesign` from `slidePlan.dataSlots`.
- Add source-specific method rules:
  - historical squad table
  - latest squad news
  - current club resolver
  - cross-check task
- In `server.js`, add a `調査設計` tab rendering the plan in human-readable cards.

## Deploy Notes

Avoid broad git operations on VPS because the VPS worktree is dirty.

Safe deploy pattern:

```bash
tar -C /mnt/c/Users/USER/Documents/side_biz -cf /tmp/v3_launcher.tar \
  02_reddit_global/v3_launcher/README.md \
  02_reddit_global/v3_launcher/server.js \
  02_reddit_global/v3_launcher/v3_story_architect.js \
  02_reddit_global/v3_launcher/v3_research.js

scp -i /tmp/web_claude_vps -o BatchMode=yes /tmp/v3_launcher.tar root@37.60.224.54:/tmp/v3_launcher.tar

ssh -i /tmp/web_claude_vps -o BatchMode=yes root@37.60.224.54 \
'cd /root/sekai_no_wadai &&
 tar -xf /tmp/v3_launcher.tar &&
 cd 02_reddit_global &&
 node --check v3_launcher/server.js &&
 node --check v3_launcher/v3_story_architect.js &&
 pm2 restart soccer-yt-v3 --update-env &&
 sleep 1 &&
 curl -s http://127.0.0.1:3010/api/v3/health &&
 echo &&
 pm2 list | grep soccer-yt'
```

Do not restart `soccer-yt-v2` for V3 work.

---

## 2026-05-27 JST Update - V3 Human Pipeline UI

Today V3 was moved from a raw "show all thinking layers" prototype toward a human-facing production workflow.

Deployed URL:

`http://37.60.224.54:3010`

Deployed PM2 target:

- Restarted only `soccer-yt-v3`.
- Did not restart or edit `soccer-yt-v2`.

Changed local/VPS files:

- `v3_launcher/server.js`
- `v3_launcher/v3_story_architect.js`

Current V3 UI flow:

1. `案件`
2. `リサーチ`
3. `テーマ提案`
4. `ブリーフ`
5. `脚本構成`
6. `脚本`

Important UX clarification from user:

- The starting "案件" has only one of these source shapes:
  - Reddit thread title + comments
  - 5ch thread title + comments
  - custom free-text event/memo from the user
- At the案件 stage, do not assume structured research data already exists.
- The user wants the system to read a lot of news/data first, then show the trial result.

Current conceptual separation:

- `テーマ提案`
  - Choose the video angle/cut.
  - Show the hook question, tentative answer, and data expected for that cut.
  - This is not the full briefing.
- `ブリーフ`
  - After choosing the theme, summarize the whole video flow.
  - It should become the production instruction before script structure.
- `脚本構成`
  - Slide/order level outline.
- `脚本`
  - Draft narration generated from the current structure.

Current data objects added by `v3_story_architect.js`:

- `researchDesign`
  - Generated from `slidePlan.dataSlots`.
  - Contains task-level research methods, queries, expected output, source priority, verification, risk.
- `autopilotPlan`
  - Contains:
    - `themeProposal`
    - `briefing`
    - `scriptStructure`
    - `scriptDraft`
    - `mustCheck`
    - `publishGates`

Current research button behavior:

- `runResearch()` now attempts to run both:
  - `/api/v3/research/topic`
  - `/api/v3/research/wiki-side-stories`
- The UI can show read material counts:
  - selected Web article count
  - full text count
  - Wiki candidate count
  - article sample snippets

Important caveat:

- The UI file currently has some legacy duplicated render functions from iterative patching. Later definitions override earlier ones, so the page works, but a cleanup pass should remove old duplicate functions and mojibake text.
- The current implementation is still mostly heuristic. It does not yet truly bind extracted values into `valueCandidate/sourceUrl/confidence`.

## 2026-05-27 JST Second Update - AI Analysis Layer

Commit: `4d1c97e feat(v3): add AI analysis layer via DeepSeek`

New file: `v3_launcher/v3_planner.js`

- `generateAIPlan(topic, memo, researchCorpus, wikiStories)`
- Calls DeepSeek with the full research corpus (up to 6 articles × 1200 chars + 3 Wiki)
- Returns: themeProposal (2-3 candidates), briefing, scriptStructure, scriptDraft, missingData, publishGates

New endpoint: `POST /api/v3/analyze`

UI changes in `server.js`:
- `runResearch()` now auto-triggers `runAnalysis()` after Serper + Wiki fetch
- `runAnalysis()` calls `/api/v3/analyze`, merges result into `currentPlan.autopilotPlan`
- `buildMergedAutopilotPlan()` maps AI response shape to existing render function shape
- `renderThemeProposalView()` now shows 2-3 AI candidate cards with selected (green border) + reason + rejected reasons
- `renderResearchWorkflowView()` shows AI-identified missing data gaps
- Sidebar button row: 案件を整理 / リサーチ / AIで分析 / 保存

Current flow when user clicks "リサーチ":
1. Fetch Serper (3 queries)
2. Fetch Wiki side stories
3. Auto-call `/api/v3/analyze` with corpus
4. DeepSeek reads articles → generates theme candidates + briefing + script draft
5. テーマ提案 tab shows candidates

Next recommended implementation step:

1. Make案件 input explicit with a source type selector:
   - Reddit
   - 5ch
   - カスタム
2. Bind research values into data slots properly:
   - `slide.dataSlots[] -> valueCandidate -> sourceUrl -> confidence`
   - Currently AI generates narration with placeholder data markers; need a second pass to fill real values
3. "AIで再分析" button after editing topic/memo should re-run without re-fetching Serper (cache research)
4. Export the generated script draft to V2 pipeline (Step2 or new V3 handoff endpoint)

## 2026-05-27 JST Third Update - V3 Autopilot Handoff Start

Local change made in:

- `v3_launcher/server.js`

Added:

- 案件タイプ selector:
  - Reddit
  - 5ch
  - カスタム
- Direct `AIで分析` now reuses cached research if available; if no research exists, it starts the research flow first.
- After research, V3 now performs a first-pass candidate binding:
  - `researchDesign.tasks[] -> valueCandidate/sourceUrl/sourceTitle/confidence/status`
  - This is heuristic matching against fetched article corpus, not final verification.
  - UI shows up to 6 `仮バインド済みの確認候補` cards in theリサーチ tab.
- New endpoint:
  - `POST /api/v3/export-v2`
  - Converts V3 `autopilotPlan.scriptDraft` or fallback `slidePlan` into V2-shaped `modules.json`.
  - Appends a saved V2 project to `data/saved_projects.json`.
  - Writes minimal `data/si_data/{postId}.json`.
  - UI button: `V2へ渡す`.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_story_architect.js`
- `node --check v3_launcher/v3_planner.js`
- Temporary local V3 server health check passed on port 3005.

Deploy note:

- VPS deploy was not performed from this environment because `/tmp/web_claude_vps` was not present.
- When deploying, copy at least `v3_launcher/server.js` and restart only `soccer-yt-v3`.

## 2026-05-27 JST Fourth Update - V2 Video Quality First Pass

Local change made in:

- `scripts/v2_video/slides/_common.js`
- `scripts/v2_video/slides/universal.js`

Purpose:

- Start improving V2 video-generation quality while keeping V3/V2 pipeline contracts intact.

Added/fixed:

- Fixed a subtitle timing bug in `buildSubtitleBar()`:
  - `startSec` was documented and used downstream, but the item normalization step dropped it.
  - It is now preserved and used when timing chunked subtitles.
- Added optional global subtitle timing offset:
  - `SUBTITLE_SYNC_OFFSET_SEC`
  - Default remains `0`.
  - Use this for small global subtitle nudge tests without code edits.
- Improved subtitle entrance/exit:
  - Slight vertical movement + blur fade for chunk transitions.
  - More polished subtitle background gradient and shadow.
- Added global visual texture via `wrapHTML()`:
  - subtle vignette/light focus
  - very light scanline/ambient color movement
  - affects all V2 slide templates because every slide uses `wrapHTML()`.
- Improved fallback `universal` slide:
  - Ken Burns background movement.
  - badge/title/card staged entrances.

Verification:

- `node --check scripts/v2_video/slides/_common.js`
- `node --check scripts/v2_video/slides/universal.js`
- `node --check scripts/v2_video/render.js`

Next visual-quality steps:

1. Generate one short V2 video and check subtitle timing and whether ambient overlay is too visible.
2. If subtitles are consistently early/late, test `SUBTITLE_SYNC_OFFSET_SEC` in small increments such as `0.10`, `-0.10`, `0.20`.
3. Add or upgrade slide types after timing/design baseline is stable.

## 2026-05-27 JST Fifth Update - V2 Launcher Preview UX

Local change made in:

- `routes/step4_routes.js`

Added:

- Step4 slide preview controls:
  - `更新`
  - `別タブ`
- Step4 generated-video preview:
  - Latest generated video is embedded as a `<video controls>` player inside the launcher.
  - Existing file links remain below it.

Verification:

- `node --check routes/step4_routes.js`

## 2026-05-27 JST Sixth Update - V3 Step Workflow Split

Local change made in:

- `v3_launcher/server.js`

Reason:

- User reported `AI分析失敗`.
- The old UI mixed `案件整理 / リサーチ / AI分析` controls in one sidebar and auto-ran AI analysis after research.
- This made failures hard to understand because Step2 and Step3 were coupled.

Changed:

- V3 UI now has a V2-like step workflow:
  1. 案件
  2. リサーチ
  3. AI分析
  4. テーマ
  5. ブリーフ
  6. 構成
  7. 脚本
  8. V2
- Sidebar now renders a workflow step nav.
- Old mixed action row is hidden.
- Each result tab has its own task action.
- `runResearch()` no longer auto-triggers `runAnalysis()`.
- `runAnalysis()` now requires completed research and sends the user back to Step2 if missing.
- `/api/v3/analyze` now logs server-side errors to help debug actual AI failures.

Verification:

- `node --check v3_launcher/server.js`

## 2026-05-27 JST Seventh Update - V3 Proposal Step Consolidation

Local change made in:

- `v3_launcher/server.js`

Changed:

- Reduced visible V3 workflow from 8 steps to 6:
  1. 案件
  2. 企画提案
  3. 企画書
  4. 構成
  5. 脚本
  6. V2
- Combined old `リサーチ / AI分析 / テーマ` into new Step2 `企画提案`.
- Step2 button `企画提案を作る` now runs:
  - topic research
  - wiki side-story fetch
  - AI analysis
  - multi-theme proposal rendering
- Step2 theme cards now have `この案を採用` buttons.
- Step3 `企画書` is the briefing view based on the selected proposal.
- Top tabs are now the only visible workflow tabs.

Verification:

- `node --check v3_launcher/server.js`

## 2026-05-27 JST Eighth Update - V3 Launcher UI / Editing Workflow

Local changes made in:

- `v3_launcher/server.js`
- `handover.md`

Deployed to VPS:

- `soccer-yt-v3` on `http://37.60.224.54:3010`
- Current UI marker: `v3-ui-left-saved-sidebar`

Changed:

- Step tabs are now hard-separated:
  - The launcher renders only the active step body.
  - It no longer keeps all step panels on the page and hides them with CSS.
  - This was done because the user said case selection, thinking, and other work were visually crammed into one vertical page.
- Step1 `案件` was cleaned up:
  - It now focuses on case selection/input only.
  - The analysis/status cards were removed from Step1.
  - Case selection UI was restyled closer to V2 Step1:
    - date toolbar
    - `案件読込`
    - selected count
    - time-group accordions
    - Reddit / 5ch / custom source badges
    - checkbox rows
- Saved projects were moved into the left sidebar:
  - Desktop/tablet widths keep saved projects in the left sidebar.
  - Only narrow mobile widths allow the sidebar to stack above the main area.
  - Selected saved project is highlighted in the sidebar.
- Step3 `企画書` became editable:
  - The briefing is shown in a large textarea.
  - Added `企画書の内容で脚本構成`.
  - Edited briefing text is parsed back into the plan before moving to structure.
- Step4 `脚本構成` became a V2-like editor:
  - slide type selector
  - title editor
  - narration editor
  - data/source rows
  - image upload/gallery
  - inline slide preview using `/api/v2/preview-slide-inline`
- V3 mounts selected V2 routers so Step4 preview and image upload can reuse existing V2 behavior without editing V2.

Verification:

- `node --check v3_launcher/server.js`
- VPS `pm2 restart soccer-yt-v3 --update-env`
- VPS health check: `curl -s http://127.0.0.1:3010/api/v3/health`
- HTML marker checks for:
  - `v3-ui-left-saved-sidebar`
  - `saved-lead-item`
  - `time-group`
  - `src-badge`

Notes / next likely work:

- The user confirmed PC view now has saved projects in the left sidebar and the look is good.
- Keep V2 preserved unless explicitly asked.
- Next UI work should continue using strict tab separation: one step, one task surface.

## 2026-05-28 JST Update - V3 Step1/Step2 Research UX

Local changes made in:

- `v3_launcher/server.js`
- `v3_launcher/v3_research.js`
- `scripts/modules/fetchers/article_fetcher.js`
- `handover.md`

Deployed to VPS:

- `soccer-yt-v3` on `http://37.60.224.54:3010`
- Restarted only `soccer-yt-v3`.
- Did not edit or restart `soccer-yt-v2`.

Changed:

- Top workflow tabs now span the full screen width above the work area.
- Step1 is now only for case selection/saving:
  - Scheduled fetched candidates are grouped by time accordion.
  - Selected cases are saved into the left sidebar.
  - Left sidebar is visible only in Step1.
  - Step2 and later hide the sidebar and use full width.
- Step1 sidebar now has a `カスタム案件` form:
  - custom case title
  - short memo/overview
  - save into the saved-project sidebar
- Step2 now starts with:
  - selected case title/source/memo box
  - centered `調査` button
  - small flow text: `検索クエリ作成 → Webリサーチ → データ取得 → 企画書A/B/C生成`
- Step2 research results are now grouped as:
  1. `検索クエリ作成`
  2. `Webリサーチ`
  3. `関連人物・チーム候補 / 追加データ候補`
  4. `記事要約`
  5. `企画書A/B/C生成`
- Related-person/team candidates remain as compact chips because they can later become data-fetch labels.
- Removed misleading task cards such as `直近ニュース` / `関係者コメント`.
  - Those are now folded into `記事要約`.
- `記事要約` is not forced into one conclusion. It shows multiple lenses:
  - `出来事の概要`
  - `主な論点`
  - `裏話・人物`
  - `企画化の材料`
- `企画書A/B/C` is combined with theme proposals:
  - each paper shows angle, hook question, tentative answer, promise, structure, data needs, and cautions
  - if AI returns empty/malformed proposal candidates, display-side fallback candidates fill A/B/C so the cards are not blank
- Research progress now updates mid-run:
  - after Web research finishes, queries/articles/data candidates render before AI analysis completes
  - if AI analysis fails, research results remain visible and fallback proposal papers are shown
- Browser-side temporary state persistence was added:
  - `currentPlan`
  - `currentResearch`
  - `currentWikiStories`
  - `currentAIPlan`
  - `currentAcquiredData`
  - selected project and active step
  - This prevents small UI changes/reloads from immediately wiping the visible research result in the same browser.

Full-text retrieval improvements:

- `scripts/modules/fetchers/article_fetcher.js`
  - fetch timeout increased from 5s to 9s
  - max article text increased from 1500 chars to 4000 chars
  - direct fetch now normalizes article text more aggressively
  - Jina Reader fallback was added for direct-fetch failures
- `v3_launcher/v3_research.js`
  - per-article V3 corpus limit increased from 1800 chars to 3200 chars
  - pick max increased from 5 to 6
  - if too few full-text articles are obtained, V3 tries extra search candidates and appends useful full-text results
  - `full_text_reader` is treated as full text
- Query compaction was added in `server.js` before V3 research:
  - for the Curacao case, long Japanese case titles are converted to shorter English research phrases such as:
    - `Curacao national football team World Cup qualification`
    - `CONCACAF World Cup qualifying Curacao`
    - `Curacao population football World Cup smallest country`

Important caveats:

- Step2 still does not yet call the existing V2/V3 structured data fetch jobs for SofaScore / Transfermarkt / Wiki entity fetch.
- Current `関連人物・チーム候補 / 追加データ候補` is still candidate extraction from article text/Wiki side-story pass.
- The next real data-quality step should connect Step2 labels to existing `/api/v3/fetch-all` or related Step2 fetcher routes so selected people/teams can actually retrieve SofaScore, Transfermarkt, and Wiki structured data.
- Existing saved browser state can show old research output until the user reruns `調査`; this is intentional to prevent accidental data loss during UI tweaks.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_research.js`
- `node --check scripts/modules/fetchers/article_fetcher.js`
- VPS `pm2 restart soccer-yt-v3 --update-env`
- VPS health check: `curl -s http://127.0.0.1:3010/api/v3/health`

## 2026-05-29 JST Update - V3 Autopilot Reliability Pass

Local changes made in:

- `v3_launcher/server.js`
- `v3_launcher/v3_research.js`
- `v3_launcher/v3_planner.js`

Focus requested by user for the next V3 work:

1. Are search queries appropriate, or too long to hit well?
2. Are SofaScore / Transfermarkt / Wiki fetches stable?
3. Are fetched data points being used enough in proposal papers?
4. When turning proposal paper into script structure, are slide type selection and data slot selection optimal?
5. Are there likely error points in the workflow?

Changed:

- Search query compaction was hardened.
  - V3 now strips URLs/brackets/noise, cuts long clauses, caps Latin queries to about 10 words, and caps Japanese fallback queries to 72 chars.
  - Duplicate queries after compaction are removed.
  - Known Madrid/Spain case still uses explicit English high-intent queries.
- Browser-side `compactSearchTopic()` was also strengthened before Step2 research.
  - If a mixed Japanese/English title contains Latin player/team names, those are preferred over a long Japanese sentence.
- `runResearch()` no longer crashes if the legacy `researchBtn` is absent from the current hard-separated UI.
- `/api/v3/auto-prefetch` now uses `Promise.allSettled`.
  - SofaScore and Transfermarkt run in parallel, but one side failing no longer kills the whole prefetch response.
  - Response includes warnings when either side fails.
- Step2 AI analysis memo enrichment was improved.
  - Successful structured data is passed as `[取得済みデータ（企画書・脚本構成で優先使用）]`.
  - Failed entity fetches are passed as `[取得失敗・未確認データ（断定禁止）]`.
- `v3_planner.js` prompt now explicitly tells DeepSeek:
  - Use acquired stats/profile/injury data in `dataNeeds` and `scriptDraft`.
  - Put failed/unconfirmed targets into `missingData` or `publishGates`.
  - Include at least one slide that uses acquired numeric data when available.
- Step4 script-structure conversion now chooses V2 slide type by role/headline/claim/data wording instead of defaulting to `stats` whenever data exists.
  - history/context -> `history`
  - contrast/comparison -> `comparison`
  - profile/person/player/club facts -> `profile`
  - stats/evidence/numbers/list -> `stats`
  - otherwise -> `insight`
- Resolved SofaScore/TM slots now include source entity name in the slot label, e.g. `João Pedro ゴール`, reducing ambiguity when multiple players are fetched.
- After VPS log review, JSON parsing and entity-noise guards were tightened:
  - `v3_research.js` now uses loose JSON extraction for DeepSeek query/entity expansion instead of failing on fenced or prefixed JSON.
  - V3 auto-prefetch filters obvious non-entity noise such as `Last`, `Injured`, `Official`, `Report`, `God`, `SNS`, `MVP`, `VAR`, `TV`.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_research.js`
- `node --check v3_launcher/v3_planner.js`
- Local query-selection smoke test for the Madrid/Spain case and a João Pedro mixed Japanese/English title.

Caveats / next recommended checks:

- This was a local reliability pass; VPS deploy was not performed.
- Network-backed real fetch stability still needs one live Step2 run on VPS or local with valid env.
- Next high-value check:
  - Run Step2 on 2 cases:
    1. Madrid/Spain squad-count case.
    2. A player-transfer/stats case such as João Pedro.
  - Confirm the proposal cards actually mention acquired stats and that Step4 creates appropriate `stats/profile/comparison/history` slides.

### 2026-05-29 JST Hotfix - V3 Blank UI / Browser Console

User reported the V3 site became unusable / "nothing can be grabbed".

Cause found:

- Browser-side inline JS had a syntax error generated from `compactSearchTopic()`.
- In `server.js`, client JS is embedded inside a template literal. Regex backslashes such as `\S` and `\s` must be double-escaped in the server source.
- The emitted HTML contained invalid JS:
  - `/https?://S+/g`
- This caused the whole client script to fail parsing.

Fix:

- Escaped the client-side regex correctly:
  - `https?:\\/\\/\\S+`
  - `\\s+`
- Redeployed `v3_launcher/server.js` to VPS.
- Restarted only `soccer-yt-v3`.

Verification:

- VPS `node --check v3_launcher/server.js`
- VPS `node --check v3_launcher/v3_research.js`
- VPS `node --check v3_launcher/v3_planner.js`
- VPS health check OK on port 3010.
- Fetched generated HTML from `http://127.0.0.1:3010/`, extracted inline `<script>`, and ran:
  - `node --check /tmp/v3_after_fix_0.js`
- Result: inline script syntax check passed.

## 2026-05-29 JST Update - V3 Background Proposal Jobs / Data Handoff Hardening

Local changes made in:

- `v3_launcher/server.js`
- `v3_launcher/v3_research.js`
- `v3_launcher/v3_planner.js`

User request:

- Reduce `企画提案失敗` and `データ取得失敗`.
- Make Step2 continue even if the browser is backgrounded.
- Improve selection of acquired data and handoff into slides.
- Do not damage non-data-related code.
- Use three review roles and repeat until reevaluation passes, max 5 loops.

Changed:

- Step2 `runProposal()` now starts a server-side job:
  - `POST /api/v3/proposal-job/start`
  - `GET /api/v3/proposal-job/:jobId`
- The browser now only starts and polls the job.
  - Web research, Wiki, SofaScore/TM, AI analysis, data selection, and saved-project progress updates run on the VPS Node process.
  - If the browser is backgrounded, the server job should continue.
- Server job saves progress to the selected saved project:
  - `researchData.plan`
  - `researchData.research`
  - `researchData.wikiStories`
  - `researchData.aiPlan`
  - `researchData.acquiredData`
  - `researchData.fetchedData`
  - `researchData.jobStatus`
- Wiki side-story fetch now catches `fetchWikipediaSafe()` per entity, so one Wiki miss no longer kills the full proposal flow.
- Auto-prefetch logic was extracted into `runAutoPrefetchCore()` and reused by both the old endpoint and the new background job.
- Entity safety fixes:
  - `守田` now maps to `Hidemasa Morita` instead of `Daichi Kamada`.
  - Managers are no longer treated as player stat targets.
  - Auto-prefetch only sends `player` / `team` entities to SofaScore/TM.
- Acquired data now has selection metadata:
  - `relevanceScore`
  - `selected`
  - `sourceTitle`
  - `sourceUrl`
  - `fetchedAt`
  - `confidence`
- `selectFetchedDataForPlan()` is stricter:
  - data must be `ok`
  - entity name must appear in the plan/research needs
  - score must pass threshold
- `v3_planner.js` prompt/schema now supports:
  - `scriptDraft[].selectedData`
- Server attaches selected data to script slides via `attachSelectedDataToPlan()`.
  - Final rule after reevaluation: no entity-name match, no automatic slide injection.
  - Generic stats/data wording alone is not enough.
- `makeModulesFromCurrentPlan()` now prioritizes `scriptDraft[].selectedData` for `dataSlots`.
  - Removed broad fallback injection of all successful fetched data.
  - Removed single-player unconditional fallback.

Three-role review loop:

1. 改善提案ミア:
   - Recommended server-side jobs, progress saving, and explicit `selectedData`.
2. エラーチェックミア:
   - Flagged Wiki per-entity failure, browser fetch chain, bad entity mapping, manager-as-player, and weak data assignment.
3. 再評価ミア:
   - Loop 1: failed because selected data was too broad.
   - Loop 2: failed because unselected ok data still had injection paths.
   - Loop 3: failed because semantic matching could still inject without name match.
   - Loop 4: failed because generic stats slide still accepted data.
   - Loop 5: passed after requiring entity-name match and removing broad fallback paths.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_research.js`
- `node --check v3_launcher/v3_planner.js`

Deploy note:

- Deploy only these V3 files and restart only `soccer-yt-v3`.

## 2026-05-29 JST Update - Separate Proposal / Structure / Script

Local changes made in:

- `v3_launcher/server.js`
- `v3_launcher/v3_planner.js`
- `handover.md`

User clarified the intended V3 flow:

`企画書 -> 脚本構成 -> 脚本生成`

Problem:

- Step2 proposal job was already asking the AI for `scriptStructure` and `scriptDraft`.
- That made the three-step workflow less meaningful because Step2 had already drafted the full script and data handoff.

Changed:

- `v3_planner.js`
  - Step2 prompt now stops at:
    - `themeProposal`
    - `briefing`
    - `missingData`
    - `publishGates`
  - It explicitly tells AI not to write script structure or narration at the proposal stage.
  - Returned `scriptStructure` and `scriptDraft` are forced to `[]` for Step2.
- `server.js`
  - `mergeAutopilotPlanServer()` and browser `buildMergedAutopilotPlan()` no longer import AI `scriptStructure` / `scriptDraft` from Step2.
- Step4 `企画書の内容で脚本生成` now builds V3 modules internally from the editable briefing.
- Visible standalone `構成` tab was removed.
  - The structure editor code remains as an internal/backward-compatible helper, but normal flow does not expose it.
- Step5 now has `脚本生成`.
  - It generates narration from the finalized Step4企画書 slide outline and selected data.
  - `autopilotPlan.scriptDraft` is created only here.
- Step5 also supports regeneration after Step4企画書 edits.

Current intended flow:

1. Step3 `企画提案`
   - research and proposal papers only.
2. Step4 `企画書`
   - human-editable production brief with theme, flow, core message, slide outline, slide type, and data plan.
3. Step5 `脚本生成`
   - narration draft generation.
4. Step6 `V2`
   - handoff to V2 modules.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_planner.js`
- `node --check v3_launcher/v3_research.js`

### Follow-up - Move Preview to Step5 Script

User clarified that preview belongs with the script stage, not the structure stage.

Changed:

- Step4 `構成`
  - Removed inline slide preview iframe.
  - Removed preview auto-refresh from structure edits.
  - This step now focuses on slide type, title, point/script direction, data slots, source, and images.
- Step5 `脚本`
  - Added slide tabs and inline slide preview next to generated narration.
  - Preview refresh runs when Step5 is active.
  - Structure edits can still generate/re-generate script, then Step5 shows narration + actual slide view together.

Verification:

- `node --check v3_launcher/server.js`

### Follow-up - Make Briefing Paper Explicit

User clarified that the difference between `企画書` and `脚本構成` was becoming unclear.

Changed:

- Step3 `企画書` textarea now explicitly includes:
  - `動画のテーマ`
  - `動画の約束`
  - `中心メッセージ`
  - `全体の流れ`
  - `スライド構成`
    - headline
    - summary/point
    - slide type
    - data type / needed data
  - `使うデータ`
  - `脚本指示`
  - `注意点`
- `脚本指示` is editable by the user.
  - Default instruction preserves consistency with the adopted proposal and warns against unsupported claims.
- Step5 `脚本生成` now prioritizes `briefing.slideOutline` parsed from the Step4 paper.
  - This keeps script generation aligned with the adopted Step2 proposal while still letting the user add production instructions.
- Purpose:
  - Step3 is now the production paper with a proposed slide outline.
  - The former visible structure step is now internal; the user-facing path goes from企画書 directly to脚本生成.

### Follow-up - Remove Visible Structure Step

User asked whether Step5 `構成` can be removed now that `企画書` includes the slide outline.

Changed:

- Top tabs are now:
  - `1 案件取得`
  - `2 保存済み`
  - `3 企画提案`
  - `4 企画書`
  - `5 脚本生成`
  - `6 V2`
- `企画書の内容で脚本生成` now:
  - parses the editable企画書
  - builds internal V3 modules from `スライド構成`
  - creates `scriptStructure` internally
  - immediately generates `scriptDraft`
- Step5 script view returns to `企画書`, not `構成`.
- `collectV3SlideInputs()` now no-ops when the hidden/internal structure editor is not mounted, preventing title/data loss during direct企画書 -> 脚本生成.

### Follow-up - Backfill Existing Briefing Text

User found existing Neymar / João Pedro saved cases did not show `スライド構成案` in the企画書.

Cause:

- Existing saved cases can have old `briefing.rawText`.
- `formatBriefingText()` returned that raw text as-is, so new sections added later were not visible unless the case was re-researched.

Changed:

- Existing raw企画書 text is preserved.
- If old raw text is missing new sections, V3 appends generated sections for:
  - `動画のテーマ`
  - `スライド構成`
  - `脚本指示`
- This lets existing saved cases show the new企画書 structure after page reload/open, without pressing再調査.

## 2026-05-30 JST Update - V3 Recipe Launcher Added

User and Mia pivoted from free-form AI slide composition to fixed editable slide recipes.

User-provided initial player recipe ideas:

- 今期成績
- 前期成績
- キャリアハイ成績
- 市場価格推移
- 代表通算成績
- クラブ通算成績
- 全クラブ通算成績
- 比較-今季VS前期
- 比較-今季VSキャリアハイ

Implemented:

- New standalone V3 recipe page:
  - `http://37.60.224.54:3010/recipes`
  - Local route: `GET /recipes`
- New APIs:
  - `GET /api/v3/recipe-slot-options`
  - `GET /api/v3/recipes`
  - `POST /api/v3/recipes`
- New local/VPS save target:
  - `v3_launcher/data/slide_recipes.json`
  - This file is generated by the UI when the user clicks save. It is not required to exist in git.
- V3 header now has a `Recipe Launcher` link.
- Recipe table fields:
  - category
  - recipe id
  - title
  - slide type
  - data slot 1-8
  - note
  - priority
  - status
- Data slot dropdown options are restricted to fields that should be obtainable from:
  - SofaScore
  - Transfermarkt
  - Wiki
- Initial default recipes are seeded from the user's 9 player recipe ideas.

Deploy:

- Commit: `af57dc3 Add V3 recipe launcher page`
- Pushed to GitHub `main`.
- VPS pull/restart completed.
- Restarted only `soccer-yt-v3`.

Verification:

- `node --check v3_launcher/server.js`
- Local HTTP checks:
  - `/recipes` rendered
  - `/api/v3/recipes` returned 9 defaults
  - `/api/v3/recipe-slot-options` returned 49 options
  - save API can write a test JSON when filesystem permission allows
- VPS checks:
  - `curl http://127.0.0.1:3010/api/v3/health`
  - `/api/v3/recipes` includes `PLAYER_SEASON_CURRENT`
  - `/recipes` includes Recipe page markup
  - `pm2 list` shows `soccer-yt-v3` online

Important next-session instruction:

- The user is going to edit recipes in the recipe launcher.
- Do not continue recipe integration until the user says they are done editing the recipe launcher.
- When the user says they are done, resume from:
  1. Read `v3_launcher/data/slide_recipes.json` from the VPS or local if available.
  2. Validate/normalize recipes and data slots.
  3. Integrate recipes into the V3 Step4/Step5 flow so slide building chooses from the user's recipe definitions instead of broad AI free composition.
  4. Make sure generated slides follow the recipe title/slide type/data slots exactly.
  5. Re-test with a real case and verify data is flowing only into appropriate slide types.

### Follow-up - Mobile Recipe Launcher UX

User said the first table version was hard to use on mobile and did not want horizontal scrolling.

Changed locally after the first recipe launcher deploy:

- `/recipes` no longer uses a wide table.
- The page now has:
  - `新規作成`
  - saved recipe card list
  - single-recipe vertical editor
  - category buttons at the top (`選手`, `チーム`, `監督`, `試合`, `移籍`)
  - title field under category
  - slide type field
  - data slots 1-8 as vertical dropdown rows
  - recipe id / priority / status / note below
- Initial default saved recipes were expanded from 9 player-only recipes to 33 starter recipes:
  - player
  - team
  - manager
  - match
  - transfer
- The page still saves all recipes through `POST /api/v3/recipes`.
- If `v3_launcher/data/slide_recipes.json` exists on VPS, it takes priority over the built-in defaults.

## 2026-05-30 JST Update - Step2 Research Flow Clarified

User requested Step2 to become an explicit five-stage pipeline:

1. Step2-1:
   - Pressing `調査` first creates search query labels from the case title.
   - Example: `ジョアン・ペドロ、負傷したネイマールに変わりブラジル代表選出か`
   - Desired labels: `ジョアン・ペドロ`, `ネイマール`, `ブラジル代表`
   - The UI should show these labels as chips.
2. Step2-2:
   - Show hit article title, URL, site name, and whether it was full text or snippet.
3. Step2-3:
   - After reading articles, propose labels/entities that seem central to the story.
   - Example: Neymar, Joao Pedro, Ancelotti, Brazil, Santos FC, Chelsea FC, Estevao, Endrick.
4. Step2-4:
   - For those labels, fetch data from sources that do not consume Serper tokens:
     - SofaScore
     - Transfermarkt
     - Wikipedia
5. Step2-5:
   - Generate proposal papers A/B/C from the article and data results.

Implemented locally:

- `v3_research.js`
  - Added `generateSearchPlan(topic, memo)`.
  - It returns:
    - `queryLabels`
    - targeted `queries`
  - `runTopicResearch()` now includes `queryLabels` in the research result.
- `server.js`
  - Proposal job stages now use:
    - `Step2-1 検索クエリ作成中...`
    - `Step2-2 ニュース記事取得中...`
    - `Step2-3 本筋ラベル作成中...`
    - `Step2-4 SofaScore / Transfermarkt / Wiki データ取得中...`
    - `Step2-5 取得結果から企画書A/B/C作成中...`
  - `research.labelCandidates` is saved from AI entity expansion.
  - Step2 display now has explicit sections:
    - Step2-1 query labels and search queries
    - Step2-2 article hits
    - Step2-3 central label candidates
    - Step2-4 free data results
    - Step2-5 proposal source material
  - Proposal job no longer runs extra follow-up Serper queries after Step2-2; Step2-4 is kept to non-Serper data fetching.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_research.js`
- Local V3 health check on temporary port passed.
- Local HTML contains Step2-1 through Step2-5 labels.

## 2026-06-01 JST Handover - V2 Scenario Pattern Analysis For V3 Structure

User asked whether prior V2 case JSON can be inspected to understand scenario structure/statistical direction before reorganizing V3.

Data inspected:

- `temp/v2_scenario_*.json`
  - 42 V2 scenario files
  - 334 slides total
- `data/*_modules.json`
  - 4 module projects
  - 23 slides total
- `scripts/v2_story/recipes_curated.js`
  - V2 curated recipe definitions for player/team/manager/match/transfer/comparison data slot selection.

Key finding:

- V2 quality came from two different layers:
  1. A stable scenario sequence template.
  2. Recipe/walker/binding logic for filling data-heavy slides.
- Recipes alone did not decide the whole story arc. They mainly stabilized the middle data slides.

V2 scenario stats from `temp/v2_scenario_*.json`:

- Project count: 42
- Slide count: 334
- Slide length distribution:
  - 6 slides: 1
  - 7 slides: 8
  - 8 slides: 25
  - 9 slides: 8
- Every sampled V2 scenario starts with `opening`.
- Every sampled V2 scenario ends with `ending`.
- Most common length is 8 slides.

V2 slide type counts:

- `opening`: 42
- `ending`: 42
- `reaction`: 42
- `insight`: 65
- `simple`: 49
- `type2`: 38
- `type1`: 30
- `stats`: 18
- `story`: 7
- `type4`: 1

Strong positional pattern:

- Slide 1: always `opening`.
- Slide 2: usually `simple`.
- Middle slides: mix of `insight`, `stats`, `type1`, `type2`.
- Near the end: `reaction` appears very consistently.
- Final slide: always `ending`.

Representative V2 sequence:

```text
opening
simple
insight
stats / type1 / type2
insight / type1 / type2
reaction
stats / simple / insight
ending
```

Practical interpretation:

```text
1. Opening hook
2. News overview
3. Background / person / club context
4. Data, comparison, career, history, or stats
5. Deeper interpretation
6. Reddit / overseas reaction
7. Final supporting data or summary argument
8. Ending
```

Old V2 type meaning inferred from JSON:

- `simple`: news overview / plain explanation.
- `insight`: background, meaning, context, implication.
- `stats`: numeric evidence / records / table-like factual slide.
- `type1` and `type2`: old template buckets, often data/comparison/argument-style middle slides.
- `reaction`: viewer-facing Reddit/overseas reaction slide.
- `opening` and `ending`: fixed bookends.

V2 recipes:

- Recipe definitions exist in `scripts/v2_story/recipes_curated.js`.
- Recipes are keyed by domains such as:
  - `player.profile_basic`
  - `player.fw_match_stats`
  - `player.season_trend5`
  - `team.season_overall`
  - `team.titles_summary`
  - `manager.career_overall`
  - `comparison.player_season`
  - `comparison.team_season`
  - `comparison.manager_career`
- Recipe role:
  - Given `subject`, `aspect`, `primary`, and optional `secondary`, walker/binding produces available slots.
  - Recipe chooses appropriate slot keys and fills `dataSlots`.
  - This is what made V2 data slides feel coherent and less random.

Important implication for V3:

- V3 should not only generate a free-form proposal/script.
- V3 should first choose a V2-style scenario skeleton, then attach binding/recipe intent to middle slides.

Recommended V3 structure rule:

```text
opening
simple
insight
stats/comparison/history/profile
insight
reaction
stats/summary
ending
```

Recommended V3 implementation direction for next session:

1. Add a V2 scenario-pattern prior to V3 structure generation.
   - Prefer 8 slides by default.
   - Allow 7 or 9 only when story complexity requires it.
2. Map old V2 types into current V3 types:
   - `simple` -> `insight` or `profile` depending on content.
   - `type1/type2` -> `stats`, `comparison`, `history`, or `profile`.
   - `reaction` -> `reaction`.
3. During V3 script/structure generation, require each data slide to include:
   - `type`
   - `binding.subject`
   - `binding.aspect`
   - `binding.primary`
   - `binding.secondary` when comparison
   - candidate `recipeKey` when obvious.
4. After V3 data acquisition, run a binding/recipe pass:
   - Convert V3 fetched data into V2-compatible `si_data`.
   - Use V2 walker/binding to create available slots.
   - Apply recipe or fallback custom slot keys.
   - Fill `dataSlots`.
5. If recipe binding fails, still show fetched data as fallback candidates in the V3 embedded editor.

Current state to remember:

- V3 now embeds V2-grade editing inside Step5 rather than redirecting the whole page.
- Per-slide TTS panel and slide all-in AI are hidden in the embedded V2 editor.
- Recent UI fixes:
  - Top V3 embedded editor explanation panel removed.
  - Slide tabs made taller in embedded editor.
  - Data binding categories are intended to expand fully in embedded editor.

Open concern:

- If data bind does not appear, likely causes are:
  - The case was not run through Step2 article/data acquisition.
  - V3 fetched data is not yet fully converted into V2 `si_data`/binding shape.
  - Slides lack `binding.subject/aspect/primary/secondary`.

Next best task:

- Implement "V2 scenario prior + binding/recipe post-pass" in V3, using the above stats as the default structure policy.

## 2026-06-01 JST Update - V3 Proposal With Slide-Type Rough Outline

User clarified an important product direction:

- V3 cannot operate like V2 by forcing a fixed scenario template first, because V3's core flow is `企画書 -> 脚本構成 -> 脚本生成`.
- The main migration goal is to reduce about 80% of manual correction work.
- Therefore, the right design is to make Step2/Step3 proposals include a rough slide-type outline, then keep the later structure step as a production-spec confirmation step rather than a fresh re-planning step.

Implemented locally:

- `v3_launcher/v3_planner.js`
  - Changed the one-plan AI prompt so each proposal must include `storyPattern`, `recommendedSlideCount`, and `slideOutline[].slideType`.
  - Removed the old instruction saying slide types are unnecessary at proposal stage.
  - Added proposal outline normalization/fallback so slide outlines still carry `slideType`, `dataNeeds`, and `productionCheck` even when model output is thin.
  - Script-structure prompt now treats Step4 as "制作設計 / 検査・補正" and tells AI to preserve the proposal's slide order/headline/point unless data makes a slide type impossible.
- `v3_launcher/server.js`
  - Carries `storyPattern` through selected proposal, briefing, and editable briefing text.
  - Proposal A/B/C cards now show `構成タイプ`.
  - Fallback proposals now include rough slide outlines.
  - Briefing text now includes `【構成タイプ】` and `【スライド構成】` lines can include ` / 確認:`.
  - `simple` is kept as a conceptual proposal type but mapped to `insight` for production/rendering because V2 has no `simple.js` slide renderer.
  - Step labels now describe Step3 as slide-type proposal and Step4 as slide-type rough briefing/spec confirmation.

Verification:

- `node --check 02_reddit_global/v3_launcher/v3_planner.js`
- `node --check 02_reddit_global/v3_launcher/server.js`

Important product decision:

- Do not delete the "脚本構成 / production spec" step.
- Its role should be changed from "ask AI to think again" to "confirm the chosen proposal is producible: slideType, title, dataSlots, sources, image needs, and continuity".

## 2026-06-01 JST Update - Direct Fetched Data To Proposal AI

User asked whether Step2 proposal generation reads articles and SofaScore/TM data before suggesting plans.

Confirmed:

- Articles and Wiki were already passed directly into `generateAIPlan`.
- SofaScore / Transfermarkt data was fetched before proposal generation, but it mostly reached the proposal AI through `enrichedMemo` after synthesis.

Implemented improvement:

- `v3_launcher/v3_planner.js`
  - Added `buildFetchedDataSummary(fetchedData)`.
  - `generateAIPlan(topic, memo, researchCorpus, wikiStories, fetchedData = [])` now accepts fetched structured data directly.
  - One-plan prompts now include a dedicated `取得済み構造化データ（SofaScore / Transfermarkt等）` block.
  - Prompt rules now require stats/profile/comparison slides to use entity names and labels from fetched structured data, and to put unavailable numbers into `missingData`.
- `v3_launcher/server.js`
  - Step2 job now calls `generateAIPlan(input.title, enrichedMemo, research, wikiStories, fetchedData || [])`.
  - `/api/v3/analyze` also accepts optional `fetchedData`.

Verification:

- `node --check 02_reddit_global/v3_launcher/v3_planner.js`
- `node --check 02_reddit_global/v3_launcher/server.js`

Not run:

- Live Step2 proposal generation, to avoid AI/Serper cost unless the user asks.

## 2026-06-01 JST Update - Mobile Recipe Launcher

User asked to make the Recipe Launcher easier to use from a phone, especially for:

1. Labeling
   - The recipe should tell AI what the slide is meant to say at a glance.
2. Data selection
   - Common data sets should be easy to preselect, e.g. current-season stats with apps/rating/goals/assists plus position-specific metrics such as tackles, interceptions, dribbles, pass accuracy.

Implemented:

- `v3_launcher/server.js`
  - Extended recipe normalization with:
    - `aiLabel`
    - `useWhen`
    - `claim`
    - `positionFit`
  - Existing recipes auto-fill `aiLabel` / `useWhen` from `note` when missing, preserving backwards compatibility.
  - Added extra slot options:
    - `sofascore.player.totalShots`
    - `sofascore.player.xG`
    - `sofascore.player.passAcc`
    - `sofascore.player.clearances`
    - `sofascore.player.duelsWon`
    - `sofascore.player.saves`
    - `sofascore.player.cleanSheets`
  - Reworked `/recipes` UI for mobile:
    - AI label textarea
    - use-case textarea
    - claim textarea
    - position-fit input
    - preset buttons: current season, FW, MF, winger, DF, GK, profile, team season, match card, transfer/value
    - selected metrics list with remove and move-up controls
    - source/category filter chips
    - detailed 8-slot dropdown editor kept under a collapsible details block
    - sticky mobile save/action bar

Verification:

- `node --check 02_reddit_global/v3_launcher/server.js`
- `node --check 02_reddit_global/v3_launcher/v3_planner.js`
- Local `GET /recipes` returned HTML.
- Local `GET /api/v3/recipe-slot-options` returned the expanded slot list.
- Local `GET /api/v3/recipes` returned recipes with the new labeling fields.



