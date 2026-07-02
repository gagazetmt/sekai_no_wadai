# V5 Launcher Architecture

## 概要

サッカーYouTube動画の自動生成パイプライン。
話題のスカウトから動画レンダリングまでを5ステップで実行する。
ダッシュボード（Web UI）から操作でき、Step 3で人間が企画を編集できる。

---

## 5ステップ構成

```
Step 1: 案件取得（Scout）
  ↓ 自動
Step 2: 情報収集（Research）— 記事・コメント・データ・画像取得
  ↓ ユーザーが「企画書へ」押す
Step 3: 企画書 ← ★ ここで一時停止。DeepSeekが叩き台 → ユーザー編集
  ↓ ユーザーが「この企画書で脚本生成」押す
Step 4: 脚本・編集 — 脚本生成 → スライドエディタ → レンダリング
  ↓ 自動
Step 5: レンダリング完了 — サムネ＋投稿メタデータ
```

> **廃止**: 旧 Step 3「企画ピース（viewpoints.js / phasePlan）」は 2026-07-02 に削除。  
> `pipeline.js` の `phasePlan` import / `viewpoints.js` は未使用のまま残置（破壊的削除は見送り）。

---

## ファイル構成

```
launcher/
├── pipeline.js          # オーケストレーター（フェーズ関数 + CLI全自動モード）
├── dashboard.js         # Web UI サーバー（HTTP + WebSocket / port 3456）
├── web/
│   └── index.html       # 5ステップ対話式ダッシュボード
│
├── scout.js             # Step 1: Brave Search + X でトピック収集
├── research.js          # Step 2: FotMob + SofaScore + Brave + コメント収集
├── viewpoints.js        # Step 3: AI で論点抽出（4-6件）
├── script_gen.js        # Step 4-1: パターン選択 + mod 生成（AI）
├── narration.js         # Step 4-3: ナレーション文生成 + TTS
├── whisper.js           # Step 4-4: Whisper API → 字幕チャンク
├── render.js            # Step 4-5: Puppeteer CDP + FFmpeg でスライド→動画
├── concat.js            # Step 4-6: FFmpeg で全スライド結合
├── slide_patterns.js    # パターン定義（20+種: match_result, player_performance 等）
│
├── slides/              # スライドHTMLテンプレート
│   ├── opening.js       # オープニング（badge付きタイトル）
│   ├── insight.js       # 論点カード（catchphrases箇条書き）
│   ├── stats.js         # データスロット（6項目 + 選手画像）
│   ├── history.js       # 年表・経歴（historyHero + dataSlots）
│   ├── matchcard.js     # 試合結果カード（スコア・スタッツ・ラインナップ）
│   ├── comparison.js    # 2者比較（左右画像 + dataSlots）
│   ├── ending.js        # エンディング
│   ├── comments.js      # コメントオーバーレイ（パステルカード, X/Reddit/Yahoo アイコン）
│   └── subtitles.js     # 字幕バー（V4ビジュアル: ダークグラデ + アンバーボーダー）
│
└── fetchers/            # 外部データ取得
    ├── _curl_cffi_caller.js   # curl-cffi 経由の HTTP クライアント
    ├── fotmob_match.js        # FotMob 試合データ
    ├── fotmob_player.js       # FotMob 選手データ
    ├── fotmob_career.js       # FotMob 選手検索（チーム特定用）
    ├── sofascore_match.js     # SofaScore 試合（フォールバック）
    ├── sofascore_player.js    # SofaScore 選手
    ├── sofascore_team.js      # SofaScore チーム
    ├── _sofa_common.js        # SofaScore 共通
    ├── _sofa_via_curlcffi.js  # SofaScore curl-cffi 経由
    ├── comments.js            # Reddit + Yahoo + X コメント収集
    └── images.js              # 選手/チーム画像（X API → data URI）
```

---

## データフロー

### Step 1: Scout
- **入力**: なし（or ユーザー指定トピック）
- **処理**: Brave Search（W杯/移籍/日本代表クエリ）+ X トレンド
- **出力**: `topics[]` — `{title, source, url}`

### Step 2: Research
- **入力**: `topic` (string)
- **自動処理**:
  1. `analyzeTopic()` — DeepSeek でトピック→**3〜4語の英語キーワード**（searchQuery）生成
  2. `braveDeepSearch()` — searchQuery で Brave 検索（**freshness:pw = 過去1週間**）、最大5件スクレイプ
  3. `deepseekExtractInfo()` — 記事からラベル抽出（**記事0件でもトピック名だけで実行**）
  4. `collectComments()` — **X のみ**（JP+EN、`fromXReplies`）。Reddit/Yahoo は品質問題で無効化（2026-07-02 固定）
- **手動（ユーザートリガー）**:
  - 「📊 データ取得」→ `fetch_data` → ラベルのmatch/playerからFotMob/SofaScore取得
  - 「🖼 画像取得」→ `fetch_x_images` → team_x_accounts.json でハンドル解決 → TwitterAPI.io（**25秒タイムアウト**）
- **出力**: `facts` — `{articles[], comments{reddit:[], yahoo:[], x, all}, extracted, labels}`
  - reddit/yahoo は常に空配列（無効化済み）。コメント実体は `comments.x` / `comments.all`
- **matchData / playerData は「データ取得」ボタン後に付加される**

#### Step 2 UI ブロック構成（上から順）
1. 記事（タイトル + URL + 文字数）
2. コメント（ソース別件数のみ：Reddit / Yahoo / X）
3. ラベル（AIチップ + 手動追加）
4. データ（取得ボタン → match scoreline / player name+team）
5. 画像（取得ボタン → 枚数表示）

### Step 3: 企画書（Brief）

- **入力**: `topic`, `facts`
- **処理**: `generateBrief(topic, facts)` — DeepSeekが4スライド分の叩き台を生成
- **出力**: `brief` オブジェクト

```json
{
  "op_title":      "動画タイトル（20〜35文字）",
  "slide_a_type":  "insight|stats|history|matchcard|comparison",
  "slide_a_desc":  "スライドAの方向性・内容指示",
  "slide_b_type":  "insight|stats|...",
  "slide_b_desc":  "スライドBの方向性",
  "ed_comment":    "EDオチの方向性",
  "needs_search":  "追加でBraveSearchが必要なクエリ（不要ならnull）"
}
```

- **ダッシュボード**: briefEditorフォームに展開。ユーザーが自由編集後「この企画書で脚本生成→」。
- **再生成**: 「↻ 再生成」ボタンでDeepSeekに叩き台を再作成させられる。
- **needs_search**: briefに設定があれば `generateModsAuto` 内でBraveSearchを追加実行してfacts.articlesに補充。

### Step 4: Render（6サブステップ）
- **入力**: `brief`（企画書・省略可） + `facts`
- **サブステップ**:
  1. **脚本生成**: `generateModsAuto(topic, facts, brief?)` → `mods[4]`（ワンショット4スライド）
  2. **画像取得**: `resolveAllImages(mods, facts)` → X API で選手/チーム画像（insight スライドにも siBinding 設定）
  3. **ナレーション**: AI テキスト生成 → TTS → `.wav`（下記TTS仕様参照）
  4. **字幕生成**: Whisper API → word timestamps → `subtitleChunks[]`
  5. **レンダリング**: Puppeteer CDP JPEG → FFmpeg image2pipe → `.mp4`（1280x720, 24fps）
  6. **動画結合**: FFmpeg concat + BGM amix → `final.mp4`
- **出力**: `{finalVideo, outputDir, mods, totalDuration}`

### Step 5: Meta
- **サムネイル生成**: Puppeteer 1280x720 JPEG（badge + タイトル + bgImage）
- **投稿メタ生成**: DeepSeek → title / description / tags
- **ダッシュボード Sub タブ**: 動画プレビュー / 投稿メタ編集 / サムネ編集（再生成ボタンあり）

---

## script_gen.js — 主要関数

| 関数 | 役割 |
|------|------|
| `generateBrief(topic, facts)` | Step3: DeepSeekで企画書叩き台を生成 |
| `generateModsAuto(topic, facts, brief?)` | Step4: ワンショットで4スライドmods生成。briefがあれば遵守。needs_search時はBraveSearch追加。`max_tokens:8000` |
| `generateMods(patternKey, topic, facts)` | 旧パターン指定型（企画ピース用。現在は未使用） |
| `generateModsForPieces(viewpoints, facts)` | 旧企画ピース連携型（未使用） |
| `_sonnetFactCheck(mods, facts)` | 脚本生成後: `claude-haiku-4-5-20251001` でナレーション内の選手名・数値・日付の誤りを検出＆修正。ANTHROPIC_API_KEYなしは自動スキップ |
| `injectRealMatchData(mods, pattern, facts)` | matchcardに実trials.matchData（ロゴ・フォメ・選手写真）を再注入 |
| `injectRealComments(mods, pattern, facts, topic)` | facts.comments.allから実コメントを注入。英語コメントはDeepSeekで一括翻訳 |

### matchcard 選定ルール（プロンプト制約）
記事に複数試合が出てきた場合、**トピックが直接言及している最重要試合（最新またはこれから）を選ぶ**。予選・関係のない試合は選ばない。例：「クロップ監督就任」ならW杯本番戦を選ぶ（予選のエクアドル戦ではない）。

---

## 画像ギャラリー（Step 4右カラム）

- `collectGalleryImages(facts)` で X公式/選手/ロゴ/記事サムネを `{url, label, group}` で集約
- Step4 右カラムの「取得」ボタン → `get_gallery_images` WSアクション → ギャラリー更新
- **外部URL直接追加**: ギャラリー下部のURL入力欄から `add_external_image` WSアクション → `facts.xImages` にマージしてギャラリー即時更新（`manual:true` フラグ付き）

---

## レンダリング仕様

| 項目 | 値 |
|------|-----|
| 解像度 | 1280x720（スライドHTML は 1920px で作成 → scale(0.667)） |
| FPS | 24 |
| エンコード | libx264 / yuv420p / crf 23 / ultrafast |
| アニメーション | CSS animation → `document.getAnimations()` でフレーム単位制御 |
| キャプチャ | CDP `Page.captureScreenshot`（JPEG quality 95） |

### タイミング構成（1スライドあたり）
```
|← LEAD_PAD(0.5s) →|← ナレーション →|← TAIL_PAD(0.3s) →|← コメント音声 →|
                     ↑ 字幕表示        ↑ 字幕消失          ↑ コメントオーバーレイ
```
- opening / ending はコメント音声なし
- コメント音声の尺は実測値を使用（固定 COMMENT_PAD 廃止）。`commentDurations[]` として pipeline.js に返す

---

## 字幕バー（V4ビジュアル）

- 背景: `linear-gradient(180deg, rgba(5,8,14,0.88), rgba(0,0,0,0.96))`
- ボーダー: `border-top: 3px solid rgba(245,158,11,0.5)`（アンバー）
- フォント: 50px / weight 800 / 自動スケーリング（32px下限）
- アニメーション: `translateY(12px→0→-8px)` + `blur(2px→0→1px)`
- 日本語2行分割: `splitSubtitle()` — 句読点・動詞末尾で自然分割
- **重要**: 表示テキストはナレーション原文。Whisper ASR出力は使わない（誤認識あり）

---

## コメントオーバーレイ

- ナレーション終了後（`narrationEndSec`）にフェードイン
- パステルカード風（source別アイコン: X / Reddit / Yahoo）
- 4-6個、ランダム配置、staggered animation

---

## TTS 仕様

### メインナレーション
- **ボイス**: MiniMax `Japanese_GenerousIzakayaOwner`（5ch系おっさんノリ）
- **速度**: speedScale 1.1
- **opening スライドはAI生成なし**: `mod.title` をそのまま読む

### コメント音声
- **男性4：女性1** のサイクルで各コメントに異なるボイスを割り当て
- 男性: `male-qn-jingying` / `audiobook_male_1` / `audiobook_male_2`
- 女性: `female-shaonv` / `audiobook_female_1`
- ナレーション終了後に連結（0.3s pause 挟みながら各コメントを順再生）

### TTS フォールバック順
1. **VoiceVox** (`localhost:50021`) — ローカル起動中のみ
2. **MiniMax** (`api.minimax.io` / `speech-01-hd`) — メイン
3. **Gemini TTS** — 最終フォールバック

### ナレーション文スタイル
- **5ch実況ノリ**: 「マジか」「えぐい」「だよな」「草」等OK
- 短文・畳みかけスタイル。各スライド60〜130文字

---

## BGM

- `launcher/assets/bgm.mp3`（V4資産）
- FFmpeg `amix`: volume=0.18 / stream_loop -1 / dropout_transition=2
- concat 後に amix → `final.mp4`

---

## AI プロバイダー

| 優先度 | プロバイダー | 用途 |
|--------|-------------|------|
| 1 | DeepSeek (`deepseek-chat`) | viewpoints / script_gen / narration テキスト / meta |
| 2 | OpenAI (`gpt-4o-mini`) | フォールバック |

---

## ラベル設計

`buildLabels(facts)` の優先順位（`dashboard.js`）:
1. `facts.extracted.labels`（DeepSeek が返した配列）
2. `extracted.homeTeam/awayTeam/playerName` からフォールバック
3. `facts.matchData`（データ取得済みなら補完）
4. 最終フォールバック：トピック文字列から vs パターン or 選手名

ラベル型:
- `{ type:'match', homeTeam, awayTeam, matchDate, competition }`
- `{ type:'team', name }`
- `{ type:'player', name, team, nationalTeam }`

---

## チーム名・選手名の正規化

- `fotmob_match.js` — `TEAM_NAME_MAP` で20+エントリ正規化（"America"→"United States", "Bosnia"→"Bosnia and Herzegovina" など）
- `fotmob_career.js` — `stripDiacritics()` でアクセント除去（Džeko→Dzeko, Vinícius→Vinicius）
- X画像のチームハンドル解決 — `team_x_accounts.json`（Inter Miami, Argentina など収録）

---

## 外部API

| API | 用途 | 課金 |
|-----|------|------|
| Brave Search | トピック/記事検索 | 無料枠 |
| TwitterAPI.io | X コメント/画像検索 | API key |
| FotMob | 試合/選手データ | 無料（curl-cffi経由） |
| SofaScore | フォールバック | 無料（curl-cffi経由） |
| OpenAI Whisper | 音声→字幕タイムスタンプ | $0.006/min |
| DeepSeek | テキスト生成 | 従量 |
| Anthropic | テキスト生成（フォールバック） | 従量 |
| MiniMax T2A (`speech-01-hd`) | 音声合成メイン | $60/M chars |
| VoiceVox | 音声合成（ローカル優先） | 無料 |
| Gemini TTS | 音声合成フォールバック | 従量 |

---

## ダッシュボード

- **URL**: `http://localhost:3456`
- **技術**: Node.js HTTP + WebSocket（ws ライブラリ）
- **状態遷移**: `idle → running → plan_ready（一時停止）→ rendering → done`

### WebSocket プロトコル

**Client → Server:**
```json
{"action": "start", "topic": "optional topic"}
{"action": "render", "viewpointIndex": 0, "edits": {"title": "...", "suggestedPattern": "..."}}
{"action": "reset"}
```

**Server → Client:**
```json
{"type": "hello", "steps": [...], "phase": "idle"}
{"type": "step", "step": "scout", "status": "running|done|error", "detail": "..."}
{"type": "sub_step", "step": "script", "status": "running|done", "detail": "..."}
{"type": "plan_ready", "viewpoints": [...], "patterns": [...]}
{"type": "done", "topic": "...", "videoUrl": "/output/.../final.mp4"}
{"type": "log", "level": "info|warn|error", "text": "..."}
```

---

## CLI 実行（全自動モード）

```bash
# 自動トピック選択
node launcher/pipeline.js

# トピック指定
node launcher/pipeline.js --topic "日本vsスペイン W杯2026"

# オプション
node launcher/pipeline.js --topic "..." --home "Japan" --away "Spain" --player "Kubo"
```

---

## 環境変数（.env）

```
DEEPSEEK_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=          # Whisper用
BRAVE_API_KEY=
TWITTER_API_IO_KEY=
MINIMAX_API_KEY=
MINIMAX_GROUP_ID=
GEMINI_API_KEY=
LEAD_PAD_SEC=0.5
TAIL_PAD_SEC=0.3
```

---

## 改修ログ（2026-06-27：表示系4点修正）

1. **背景画像が出ないバグ修正** — `slides/insight.js` の `imgDataUri()` が `http(s)` URL を `fs.existsSync` に通して null を返していた。`http(s)` はそのまま渡すよう修正（puppeteer が networkidle0 で読込）。ギャラリーで選んだリモート画像が背景に反映されるように。
2. **Step2 ラベル別画像一覧 + チェック選択** — `dashboard.js` に `collectGalleryImages(facts)` を新設（X公式/選手/ロゴ/記事を `{url,label,group}` で集約）。`fetch_x_images`/`get_gallery_images` 両方がこれを使う。`web/index.html` に取得元(`group`)別のチェック式サムネ一覧を追加。チェックした画像のみ Step4 ギャラリーへ（`uncheckedImageUrls` Set で管理・デフォルト全チェック）。
3. **マッチカードの選手顔/名前/フォメ/ロゴ** — AIが `matchData` を作り直す過程で sofascore の選手写真(`p.photo`)・フォメ・ロゴが欠落していた。`script_gen.js` に `injectRealMatchData(mods, pattern, facts)` を追加し生成後に実 `facts.matchData` を再注入。`compressFacts` は AI へ渡す前に `_stripMatchMedia` で重いdataURIを除去（トークン節約）。
4. **コメントの読み上げ同期ポップ** — `narration.js` の `generateCommentAudio` が per-comment 尺を返し `mods[i].commentTiming`（narrationDurSec/pause/gap/perComment）に保存。`slides/comments.js` を全面改稿：各コメントが読まれる瞬間に上から1個ずつ slideDown ポップ＋読了中 active 強調、画面いっぱいに縦積み（スカスカ解消）。`render.js` が `injectCommentOverlay(html, comments, narrationEndSec, commentTiming, dur)` を呼ぶ。

※ 反映には `node dashboard.js` の再起動が必要。

## 改修ログ（2026-06-27 その2：プレビュー/TTS/字幕）

1. **プレビュー＝本番一致** — `dashboard.js` に `buildPreviewHTML(mod)` と WS `preview_slide` を追加。実スライドビルダー（slides/*.js）でHTMLを生成して返す。クライアントは `s4ShowPreview` で iframe(srcdoc) にスケール表示。手書き再現の `s4BuildSlideContent` は廃止（実ビルダーと差異が出ていたため）。
2. **MiniMax TTSテスター** — `launcher/minimax_tester.js`（別ポート3457・スタンドアロン）。テキスト+ボイス選択→合成→ブラウザ試聴、★採用メモ(localStorage)。起動: `node launcher/minimax_tester.js`。
3. **字幕はコメントに出さない + V3二段字幕** — `slides/subtitles.js` を全面改稿。ASR認識結果ではなく**原文ナレーション**を「、。！？」で自然分割→2行化し、Whisper word timestamp で同期。`narrationDurSec` でナレーション区間の word のみ使用（コメント読み上げ区間は字幕なし）。`render.js` は `injectSubtitles(html, mod.narration, mod.subtitleWords, dur, {leadPad, narrationDurSec})` を呼ぶ。`pipeline.js` が `mod.subtitleWords`/`mod.narrationDurOnly` を保存。

## 改修ログ（2026-07-01：コメント収集刷新 / TTS並列化 / VPSレンダリング）

### コメント収集（fetchers/comments.js）

#### fromXReplies — 設計思想
- `fromX`（キーワード広域検索）は廃止。`fromXReplies` + Yahoo + Reddit の3本柱に統一
- **なぜ `fromX` を廃止したか**: W杯期間中は「日本vsブラジル」などがトレンドを占拠し、エムバペ記録のトピックでも無関係コメントが混入。`fromXReplies` はソースツイートを起点にするため構造的に絞り込める

#### fromXReplies — 実装フロー
```
1. JP + EN キーワードで広くXを検索（アカウント縛りなし）
   クエリ例: (エムバペ OR クローゼ OR Mbappe OR Klose) -is:retweet lang:ja
   ※ queryType: 'Top' + 'Latest' 両方取得してマージ（候補数拡大）

2. ブルーバッジ(isBlueVerified) + フォロワー10万以上 でフィルター
   → 信頼性の高いメディアアカウントのツイートに絞る

3. GPT-4o-mini でトピック一致判定（上位10件 → JSON配列で合否）
   ※ AI一致0件の場合はフォールバックせず空を返す（無関係スレッド防止）

4. top2 を選択してリプライを並列取得（conversation_id: 検索）
```

#### キーワード設計ルール
- JP: `topic.match(/[ァ-ヶー]{3,}/g)` — カタカナ3文字以上の固有名詞
- EN: `enQuery` から大文字始まりの語のみ（goal/record/cup等の汎用語は除外）
- EN汎用除外リスト: `goal goals record records cup world soccer football match game win score`

#### 試合フェーズ判定（detectMatchPhase）
- `matchData.status.finished/started/utcTime` から `'pre'|'live'|'post'` を返す
- Yahoo検索のsuffixとXのhintをフェーズ別に切替
  - pre: `展望 予想` / `展望 OR 予想 OR 注目`
  - live: `速報 ライブ` / `速報 OR ゴール OR 実況`
  - post: `結果 感想` / `感想 OR 試合終了 OR お疲れ`
- **フェーズヒントはXアカウント検索クエリには入れない**（汎用語がW杯全体にマッチしてしまうため）

#### enQuery の流れ
- `collectComments(topic, { enQuery })` → `fromXReplies(topic, { phase, enQuery })` に伝播
- research.js が `analyzeTopic()` で生成した英語キーワードを `enQuery` として渡す

### TTS並列化（narration.js）
- `makeSemaphore(2)` でスライドレベル・コメントレベル両方を並列化
- MiniMax RPM rate limit 対策: エラー時に3s/6sウェイトでリトライ（最大3回）→失敗時のみVoiceVoxフォールバック
- コメントTTSは `packComments(comments)` で9行スロットに収まる件数のみ読み上げ（画面外コメントはTTSしない）

### Whisper並列化（whisper.js）
- `makeWhisperSemaphore(4)` で並列化。5ファイルで約5秒（従来は逐次で～40秒）

### コメントオーバーレイ 9行スロット設計（slides/comments.js）
- 1920x1080 overlay: top=130px, bottom=120px → 高さ830px / 9スロット
- 短コメ(≤40字)=1行、中(≤80字)=2行、長(≤120字)=3行
- `_packComments()` で貪欲選択（9スロット埋まるまで）
- export: `packComments: _packComments`（narration.js から import して TTS対象を限定）

### VPSレンダリング（render.js）
- **Linux: Xvfb + ffmpeg x11grab（1.0〜1.2倍速）**
  - Chrome args: `--use-gl=swiftshader`（GPU無しVPSでCSSアニメ正常描画）
  - `-draw_mouse 0`（カーソル非表示）
  - warmup 800ms（冒頭0.5sズレ対策）
  - `--disable-backgrounding-occluded-windows` 等スロットリング防止フラグ
- **Windows: CDP JPEG → ffmpeg stdin（従来方式）**
- CDP方式はVPSで6.4倍速（GPU無しでスクリーンショット1枚267ms）→ x11grabに回帰

### VPS 設定
- `/root/side_biz/launcher/ecosystem.config.js`（git管理外）
  - `DISPLAY: ':99'`、`PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium-browser'` を env に設定
  - pm2 起動: `pm2 start ecosystem.config.js --name v5-launcher`
- ダッシュボードURL: `http://37.60.224.54:3456`
- 動画確認用HTTP: `python3 -m http.server 8081`（output/ をサーブ）

## 改修ログ（2026-07-01 その2：ベンチ結果）

| ステップ | 時間 | 備考 |
|---|---|---|
| ①案件取得 | 16.2s | articles:10 comments:34 |
| ②③ラベル・データ取得 | ①に含む | player:エムバペ |
| ④⑤企画ピース | 5.2s | 5視点 |
| ⑥脚本生成 | 7.0s | 5スライド |
| ④画像取得 | 3.2s | 2/5枚 |
| ⑦TTS | 33.4s | 並列化後（従来比 ～40%短縮） |
| ⑧Whisper | 5.3s | 並列化後（従来比 ～87%短縮） |
| ⑨レンダリング | 144.7s | x11grab 1.1倍速 |
| concat+BGM | 39.8s | |
| **合計** | **約255s** | 122.9秒動画 / 15.9MB |

## 改修ログ（2026-07-01 その3：Step2 V3式取得 / Step4 UI / TTSモデル）

### Step2 — V3式「ラベル紐づけ取得」（その1#2 のグループ式チェックUIを置換）
- ラベルは**コンパクトなチップ**に。各チップの**左側に 📊/🖼 アイコンボタン**（押すとそのラベル単体で取得）。
- チップ群の**上に「📊 データ全取得」ボタン**（全ラベル一括データ取得 = `fetchAllLabelData`）。
- 取得結果はチップ下に表示：データ → ラベルごとサマリー（`renderLabelDataResults`）、画像 → ラベルごとにチェック式サムネ（`renderLabelImageResults`）。チェックした画像のみ Step4 ギャラリーへ（`uncheckedImageUrls` で管理・デフォルト全チェック）。
- サーバ: `dashboard.js` に **WS `fetch_label_data`**（単一ラベル→`fetchMatch`/`fetchPlayer`/`fetchTeam`、選手写真/ロゴも `images` で返す）と **WS `fetch_label_images`**（`fetchImagesForLabels([label])` → `facts.xImages` にマージ）を追加。
- クライアント状態: `labelImages`/`labelData`/`labelBusy`（key = `labelKeyOf(lb)`）、`allGalleryImages` は全ラベル画像のマージプール。

### Step4 — エディタUI刷新
- スライド型選択下の「▶プレビュー」ボタン削除（`togglePreview` は未使用化）。
- **画像調整をアコーディオン化**: 見出し「左画像/背景画像/右画像」を横並びタブ（`imgAccordion` / `toggleImgPanel` / `buildImgBlockHTML`）。タブを開くとそのキーが**ギャラリーターゲット**にもなる。
- **ナレーション窓を6行**に（`rows="6"`）。
- **データスロット・コメントを `<details>` で折りたたみ**（`accordion()` ＋ `dataSectionInner`/`cmtSectionInner`）。
- **プレビューを最下部・全幅へ移動**。右カラムは画像ギャラリーのみ。`insight` プレビューに背景画像描画を追加（本番一致）。
- プレビュー本体は WS `preview_slide`（実ビルダー）→ iframe srcdoc（`s4RefreshPreview`/`s4ShowPreview`、`s4PreviewReqId` で古い応答破棄）。

### MiniMax TTS モデル
- 旧設定は `speech-01-hd`（**抑揚弱い原因**）。有効モデル（2026-06時点・公式/pipecat確認）= `speech-2.6-hd`(最新HD・ナレ本命)/`speech-2.6-turbo`/`speech-2.5-hd`/`speech-2.5-turbo`/`speech-02-hd`/`speech-02-turbo`/`speech-01-hd`。`speech-2.8-hd` は**存在しない**。
- `minimax_tester.js` に**モデル選択UI**追加（既定 `speech-2.6-hd`、自作ID入力可）。本番採用モデルは試聴後に `narration.js` の `model:` を差し替える（未確定なら据え置き）。

### 運用メモ（ポート / 起動）
- ダッシュボード: **3456**（`node launcher/dashboard.js`）。MiniMaxテスター: **3457**（`node launcher/minimax_tester.js`）。両方 `0.0.0.0` listen → **Tailscale `http://100.115.224.x:ポート`** で別端末から可（このPCのTS IP = 100.115.192.114）。
- index.html は `Cache-Control: no-cache` 付きで配信（スマホSafariの旧HTMLキャッシュ対策）→ index.html 変更は再起動不要。**dashboard.js 変更時のみ再起動**。
- セッション独立で常駐させるには PowerShell `Start-Process node ... -WindowStyle Hidden`（Claudeのバックグラウンド実行はセッション終了で落ちるため）。
- **VPS上の管理**: `pm2 restart v5-launcher`（PM2 id:8）。手動 `kill -9 <PID>` でもポートが空かないことがある → `pm2 restart` を使うこと。

---

## 改修ログ（2026-07-02：企画書工程新設 / Sonnet監修 / コメントX絞り / 外部画像URL）

### Step 3 廃止 → 企画書に置換

旧「企画ピース」（viewpoints.js / AI論点6件 → ユーザー選択1〜2件）を廃止。代わりに**企画書**（brief）フローを新設。

- `generateBrief(topic, facts)`: DeepSeekが {op_title, slide_a/b_type, slide_a/b_desc, ed_comment, needs_search} を返す
- dashboard `generate_brief` WS action → `brief_ready` broadcast → briefEditorフォームに展開
- ユーザー編集後 `save_brief` → `generate_script` が brief を `generateModsAuto` に渡す
- `needs_search` フィールドがある場合、`generateModsAuto` 内でBraveSearchを実行して articles を補充してから生成

### Sonnet（Haiku）ハルシネーション監修

- `_sonnetFactCheck(mods, facts)`: `claude-haiku-4-5-20251001` で各スライドのnarrationを検証
- チェック対象: 選手名・スコア・数値・「なお〜」補足文・日付・記録
- レスポンス: `{"corrections":[{"i":スライドIndex,"from":"元テキスト","to":"修正後","why":"理由"}]}`
- ANTHROPIC_API_KEY なしは自動スキップ（エラーにならない）
- `generateModsAuto` の最後に呼ばれる

### コメント収集 — X のみに絞り込み（確定）

`fetchers/comments.js` の `collectComments` を簡略化:
```javascript
const xReplies = await fromXReplies(topic, { phase, enQuery });
return { reddit: [], yahoo: [], x: xReplies, all: xReplies, ... };
```
Yahoo の `li p` セレクターが記事関連リンクを広く拾っていた問題、Reddit が日本語コンテンツに合わない問題を解消。Xリプライのみで品質が向上（2026-07-02 確認済み・固定方針）。

### 外部画像URL追加（gallery）

Step4 右カラムの画像ギャラリー下部にURL入力欄を追加。
- WS `add_external_image` → `facts.xImages` に `{url, source:'外部追加', manual:true}` でマージ
- `collectGalleryImages` が即時ピックアップ → gallery_images broadcast

### script_gen — max_tokens 4000→8000

4スライド分のmods JSON生成がDeepSeekの4000トークン上限に当たって途中で切れる問題（`mods 不足: 0枚` エラー）を修正。DeepSeek/OpenAI両方で 8000 に引き上げ。

### matchcard選定プロンプト制約追加

記事に複数試合が出ても予選・旧試合を拾わないよう `generateMods` system promptに制約を追記:
「トピックが直接言及している・最も最近（またはこれから）の試合を選ぶ。過去の予選・関係のない試合を拾うな」

---

## 改修ログ（2026-07-02 その2：画像自動プリセット / 企画書遵守強化 / 取り違えガード）

### 画像自動プリセット（fetchers/x_images.js + fetchers/images.js）

- `fetchImagesForLabels` の戻り値に **`entity`**（由来の選手/チーム英語名）を追加 → `facts.xImages` に保存される
- `presetImagesFromGallery(mods, facts)` 新設（images.js からexport）:
  - `resolveAllImages` の冒頭で実行。mod の `siBinding` / `siBindingLeft` / `siBindingRight` と `xImages[].entity` を正規化マッチ（小文字化・NFDアクセント除去・FC/CF除去・部分一致）して bgImage 等を先埋め
  - `facts._uncheckedImageUrls`（ギャラリーでチェック解除された画像）は対象外
  - 同一画像は1枠のみ（used Set）。埋まらなかった枠だけ従来の X API 検索が走る（API節約）
- クライアント: `re_render` / `render` 送信時に `uncheckedImages` を同送 → `session.uncheckedImageUrls` → runRender で `facts._uncheckedImageUrls` にセット
- 脚本生成プロンプトに **手持ち画像インベントリ**（entity一覧）を追記 → AIが siBinding を画像のある対象に寄せる（背景なしスライド防止）

### 企画書遵守強化（script_gen.js generateModsAuto）

- 企画書セクションを system prompt 末尾追記 → **ユーザープロンプト冒頭の「最優先指示」**に移動（遵守率向上）
- 各スライドの指示に「このスライドの主題はこの指示」「A/Bで内容重複させない」等の拘束文を追加
- `brief.op_title` は生成後に**コード側で強制上書き**（mods[0].title / narration。AIの微妙な書き換え対策）
- contentTypes 強制は従来通り（コード側）

### データ取り違え・エラー防止

- **facts取り違えガード**（dashboard.js）: `factsTopicMismatch()` — `session.facts.topic !== session.activeTopic` を `generate_brief` / `generate_script` / `runRender` で検知して中断（factsは session.facts / factsCache / topicData の3箇所管理のため構造的リスクあり）
- **compressFacts**（script_gen.js）: 8000字での文字数ぶった切りを廃止。予算超過時はフィールド単位で削減（コメント25→8→4件 / 記事5→3件 / snippet 300→120字 / lineup・stats削除 ※実データは生成後に再注入されるため安全）→ 壊れたJSONがAIに渡らない
- **matchcard取り違え検知**（script_gen.js injectRealMatchData）: AI脚本のチーム名と facts.matchData のチーム名が不一致なら警告ログ（実データ上書きは従来通り実行。ナレーションとの矛盾をユーザーがStep4で確認）
- **脚本バリデーション警告のUI表示**: `script_ready` に `validation` を同梱 → Step4 上部に `#s4ValidationWarn` バナー（未設定フィールド一覧）
- **Sonnet監修の不発可視化**（_sonnetFactCheck）: `from` が原文不一致で replace 不発だった修正を警告ログ（「指摘N件中M件適用」）

※ 反映には `node dashboard.js` の再起動が必要。
