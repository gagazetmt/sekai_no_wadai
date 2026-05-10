---
name: セッション引き継ぎ書（リポ版・クラウドミア用）
description: スマホ・claude.ai/code から続きをやる時の引き継ぎ。最終更新 2026-05-10 夕
type: project
---

# セッション引き継ぎ（クラウドミア向け）

## 🚨 現在の最優先タスク：YouTube OAuth redirect_uri_mismatch を解消して 1本目を投稿

**状況**: 1本目案件（カスタム`プレミアリーグ終盤戦・Pep vs Arteta`）が**通し回し完成**。
動画ファイルもサムネもすべて揃ってて、Step6 で「YouTube投稿」押した瞬間に
`redirect_uri_mismatch` で失敗。

## 🎯 案件の現在ファイル位置（VPS）

- 案件 ID: `custom_20260510_1415_31jh7z`
- 動画: `data/v2_videos/20260510_1415_31jh7z_202605100624.mp4` (22.8MB)
- modules.json / si_data 全て無事
- saved_projects.json に登録済（cleanup バグも修正済）

## 🔧 認証フロー現状

### .env (VPS)
```
YOUTUBE_CLIENT_ID=71603051482-sphu5eb0kp463cn0rk8slh9tua0li8u1.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=GOCSPX-...（35字）
YOUTUBE_REDIRECT_URI=http://37.60.224.54.nip.io:3004/api/v5/youtube-callback
```

### Google Cloud Console 操作済
- 「contabo launcher」（ウェブアプリ・`sphu5...`）に上記 URI 追加・保存済
- それでも mismatch 発生中

### 旧トークン
- `.youtube_tokens.json.bak_20260510_1555` でバックアップ済（4/19取得・期限切れ）

## 🛠️ 解決路の選択肢

### 路線 A: nip.io 待ち
- メリット: 永続的に VPS 直で動く
- デメリット: Google 反映「5分〜数時間」公式案内
- アクション: 5分おきに認証試行

### 路線 B: SSH トンネル + localhost（即解決・推奨）
- メリット: localhost は Google 特別扱い・反映即時
- デメリット: 投稿時に ssh トンネル張る必要
- アクション:
  1. .env を `YOUTUBE_REDIRECT_URI=http://localhost:3004/api/v5/youtube-callback` に変更
  2. Google Cloud Console に上記 URI を追加
  3. 相棒PowerShellで `ssh -L 3004:localhost:3004 -N root@37.60.224.54`
  4. ブラウザで `http://localhost:3004/` アクセス
  5. Step6 → 認証 → 投稿
- ⚠️ クラウドミアは ssh 不可なので、相棒のローカルPCに戻ってから実行

### 路線 C: 手動投稿（保険）
- 動画ダウンロード `http://37.60.224.54:3004/v2_videos/20260510_1415_31jh7z_202605100624.mp4`
- YouTube Studio から手動 upload
- 1本目だけ手動・2本目以降 API

## 📱 クラウドミアの制約と動き方

**できないこと**:
- VPS への ssh
- VPS .env / pm2 直接操作
- ローカルファイルシステム参照

**できること**:
- git push（webhook auto-pull）
- Console 操作の助言
- 認証フロー手順の説明
- コード修正 → push → VPS反映

**スマホで進めるなら**:
1. Console の Client Secret と env 値の一致を相棒に確認してもらう（Console画面でシークレット表示）
2. 一致してれば、伝播待ちなのでループ試行
3. 不一致なら Console でシークレット再生成 → 相棒の代わりに .env更新コードを push

---

## ✅ 今日（2026-05-10）の達成リスト（V2 完成記念回）

### 大物機能群
1. **Step5/6 分割** — サムネ生成 / 動画投稿で完全分離
2. **Gemini Imagen 4 サムネ生成パイプ** — provider抽象化
3. **リネカ題材分類パターンライブラリ** — 9題材
4. **Opening連動 thumb_text 抽出**
5. **Step6 タイトル強化** — opening キーワード必須
6. **外部画像インポート + プロンプトコピー** — 無料 Web 経路対応
7. **カスタム案件モード** — Reddit起点不要
8. **監督画像取得改善** — x_by_time skip / wikimedia 3→8
9. **手動画像アップロード** — Step3.5
10. **監督 comparison per-club** — 通算ではなく現所属
11. **Wiki チーム歴代シーズン fetcher** — Arsenal/Man City 確認済
12. **SofaScore 残り試合 + 今季消化済**
13. **Step4 スライド削除ボタン**

### 重要バグ修正
- localStorage で selected 維持
- step4/step5 inline script syntax bugfix（\\n / \\/ テンプレ評価事故）
- saved-projects auto-cleanup でカスタム案件保護
- 5つの誤読修正（師弟対決 / 薫陶 / アルテタ / 節 / N勝M分K敗）
- WDL の「分」を「ぶ」→「わけ」

### 通し検証フィードバック
- 質感は最高評価
- 残課題（投稿後でOK）:
  - BGM 冒頭フェードイン
  - #5 タイポ「でしが」「終結」
  - #1 opening 本格 narration

## 🎯 次セッション初手

1. この handover を読む
2. 相棒に「YouTube OAuth、その後どうなった？」と聞く
3. 状況に応じて：
   - 通った → 投稿完了確認
   - まだ mismatch → Client Secret 確認 or 路線 B 提案
   - 諦めて手動投稿 → 動画ダウンロード手順案内
