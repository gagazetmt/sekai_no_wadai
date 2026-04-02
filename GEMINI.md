# GEMINI.md - プロジェクト指示書 (2026-04-01)

## 0. 進捗管理と連携
- **共通進捗ファイル**: `handoverC&G.md` を必ず最初に読み込み、最新の進捗とToDoを把握すること。
- **連携**: Gemini CLI と Claude Code を併用しているため、変更内容や進捗は `handoverC&G.md` に適宜追記・修正すること。

このプロジェクト「side-biz」における Gemini CLI の絶対的な振る舞いを定義する。

## 1. プロジェクト目標
- **YouTube収益化**: 登録者1000人 + 総再生時間4000時間
- **直近のターゲット**: サッカー（プレミアリーグ中心）
- **メインプロジェクト**: `02_reddit_global`

## 2. 開発・デプロイフロー
- **修正の原則**: スクリプト変更前は、必ずユーザー（相棒）に確認を取る。
- **デプロイ**: ローカルで修正 -> `git push` -> GitHub -> VPS webhook -> 自動デプロイ。
- **文法チェック**: 修正後は必ず `node --check <script>` で確認する。
- **削除禁止**: `02_reddit_global/generate_content.js` はランチャーから呼ばれているため削除厳禁。

## 3. インフラ・環境情報
- **VPS (Contabo)**: `37.60.224.54` (Public) / `100.116.25.91` (Tailscale)
- **ランチャー**: `http://100.116.25.91:3003` (Tailscale接続必須)
- **主なスタック**: Node.js, pm2, VoiceVox (Docker), Puppeteer, FFmpeg
- **AI設定**: `.env` で `AI_PROVIDER=deepseek` に設定。全コールは DeepSeek V3 にルーティングされる。
- **セキュリティ**: `.env` のAPIキーは絶対にコミット・出力・ログ記録しない。

## 4. 自動素材収集パイプライン (心臓部)
- **STEP1**: `fetch_daily_candidates.js` (収集・重複除去)
- **STEP2**: `generate_text_content.js` (AIテキスト生成・VPSトリガー)
- **VPS側**: `fetch_images_for_content.js` (画像自動収集)
※ 停止した場合は最優先で復旧させること。

## 5. コマンド集
- **VPSログ確認**: `ssh root@37.60.224.54 'tail -80 /root/sekai_no_wadai/02_reddit_global/soccer_yt.log'`
- **画像取得状態**: `curl http://100.116.25.91:3003/api/img-fetch-status`
- **pm2再起動**: `pm2 restart soccer-yt`
