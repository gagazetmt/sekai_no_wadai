# V3 Story Architect Prototype

V2 を保持したまま、V3 の前段だけを検証するための独立ランチャー。

この段階では動画生成・TTS・サムネ生成には入らず、以下を確認する。

- 中心問い
- 仮結論
- TOC（答えまでの道筋）
- beat（論旨上の一手）
- beat ごとの必要証拠
- 危険な断定チェック
- サムネ/声の方向性

## Run

```bash
cd 02_reddit_global
node v3_launcher/server.js
```

Open:

```text
http://localhost:3005
```

`V3_LAUNCHER_PORT=3006` のように環境変数でポート変更できる。

## Files

- `server.js`  
  独立 Express サーバー。V2 の `soccer_yt_server_v2.js` には触らない。

- `v3_story_architect.js`  
  `topic -> argumentPlan -> evidencePlan -> slidePlan` の中核プロトタイプ。
  現時点では外部 AI を呼ばず、後から Sonnet / DeepSeek / GPT に差し替えられる契約を固定する。

- `data/argument_plans/*.json`  
  ランチャーから保存した argumentPlan。

## Next Integration

V3 本実装では、この順に拡張する。

1. `createArgumentPlan()` を AI 呼び出し対応にする
2. `evidencePlan.researchTasks` を既存 SI 取得に流す
3. 取得結果を `beat.evidenceStatus` と `evidenceItems` に紐づける
4. `slidePlan` から V2/V3 モジュールを生成する
5. `voicePlan` を TTS styleInstructions に渡す
6. `thumbnailPlan` からサムネテンプレを自動選択する

## Design Rule

V3 は「素材を集めて動画にする」ではなく、
「問いを立てて、答えに必要な証拠だけを集め、一本の論旨にする」。

そのため、スライドの最小単位は `slideType` ではなく `beat.role`。

```text
hook -> contrast -> evidence -> counterpoint -> answer
```

各 beat が中心問いへの答えに貢献しない場合、その情報は動画から落とす。
