# V2ランチャー 改修作業ログ

## 既知バグ・エラー箇所（改修前ベースライン）

| # | 場所 | 問題 | 優先度 | 状態 |
|---|------|------|--------|------|
| A | `local_v2_launcher.js:46` | `callAI(prompt, {json:true})` — 引数シグネチャ完全間違い。実行時 **TypeError** で即死 | 🔴 Critical | 修正済 |
| B | `soccer_yt_server_v2.js` + `local_v2_launcher.js` | **同一ポート3004**の重複サーバー。同時起動不可・コード二重管理で乖離 | 🔴 Critical | 修正済 |
| C | `sofascore_player.js:32` | `model:'claude-haiku'` — 正しくは `claude-haiku-4-5-20251001` | 🟡 Medium | ⏳ 待機 |
| D | `local_v2_launcher.js` Step3 | `<p>構成案の準備中...</p>` のみ。完全未実装 | 🟡 Medium | 修正済 |
| E | `JSON.parse(fs.readFileSync(...))` 全箇所 | try-catch なし。JSON 破損でサーバークラッシュ | 🟠 High | 修正済 |
| F | AI翻訳バッチ | パースミス時に全件が原文のまま返る（エラー非表示） | 🟡 Medium | ⏳ 待機 |
| G | Reddit 公開JSONエンドポイント | 認証なし・短時間大量リクエストでレート制限リスク | 🟡 Medium | ⏳ 待機 |
| H | VPS SCP | `try{}catch{}` でエラー無言スキップ | 🟡 Medium | ⏳ 待機 |
| I | Step2 BLUE版 | SofaScore 検索入力がない（RED版のみに存在） | 🟡 Medium | 修正済 |
| J | Step2 BLUE版 | SI履歴にダウンロードアイコンなし | 🔵 Low | 修正済 |

---

## アーキテクチャ変更方針

```
旧: soccer_yt_server_v2.js  + local_v2_launcher.js（二重管理・同ポート競合）
新: local_v2_launcher.js（シェルのみ）
    routes/step1_routes.js（案件選択 API+UI 完全独立）
    routes/step2_routes.js（SI情報取得 API+UI 完全独立）
    routes/step3_routes.js（構成提案 API+UI 完全独立）
```

**独立性の原則:** 各 step ファイルは他の step ファイルを一切 require しない。
共有状態は `window.APP`（クライアント側グローバル）のみ経由。

---

## 作業ログ

### 2026-04-24 — 初回改修（RED版）

| タスク | ファイル | 状態 |
|--------|---------|------|
| WORK_LOG.md 作成 | WORK_LOG.md | ✅ 完了 |
| routes/ ディレクトリ作成 | routes/ | ✅ 完了 |
| Step1 独立実装 | routes/step1_routes.js | ✅ 完了 |
| Step2 独立実装（callAIバグ修正・検索追加） | routes/step2_routes.js | ✅ 完了 |
| Step3 完全実装（Claudeモジュール提案・タブUI） | routes/step3_routes.js | ✅ 完了 |
| メインランチャー統合版（RED） | local_v2_launcher.js | ✅ 完了 |

---

## 次回改修予定タスク

- [x] C: `sofascore_player.js` モデルID修正 + Serperフォールバック削除（2026-04-24）
- [ ] F: AI翻訳エラー時のリトライ/部分成功ハンドリング
- [ ] G: Reddit リクエスト間隔制御（バックオフ）
- [ ] H: VPS SCP エラーを Slack/ログに通知
- [ ] Step4以降: VPS移行・動画生成・投稿準備
