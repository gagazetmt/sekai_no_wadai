# ANA国内線特典航空券 空席ウォッチャー

指定した路線・日付のANA国内線特典航空券に空席が出たら、LINEにリアルタイム通知するシステム。

## 前提として理解しておくこと（重要）

- ANA国内線特典航空券の空席照会は **ANAマイレージクラブへのログインが必須**（未ログインだとログインページに飛ばされる）。
- ANAサイト利用規約には「ソフトウェア等のコンピュータプログラムを利用して、ANAの許可なく、**商用利用を目的として**情報を取得する行為」を禁止する条項がある。本システムは個人の特典航空券監視という非商用利用が前提。ただし規約の文言上の話とは別に、ログイン済みアカウントへの自動的・反復的なアクセスはANA側の不正検知に引っかかる可能性がゼロではない。
- リスクを抑えるため以下を実装している。
  - チェック間隔は固定ではなく `CHECK_INTERVAL_MIN_SEC`〜`CHECK_INTERVAL_MAX_SEC` の範囲でランダム化（デフォルト15〜30分）
  - 複数のANAアカウントを3〜6時間（`SESSION_MIN_HOURS`〜`SESSION_MAX_HOURS`）でランダムにローテーション
  - ログインセッション（Cookie）は使い回し、毎回ログインし直さない
  - フォーム入力・クリックの間に人間らしいランダム待機を挟む
  - それでもリスクをゼロにはできないので、最終判断は自己責任で。

## ディレクトリ構成

```
03_ana_award_watcher/
  config/
    watch_targets.example.json   監視対象のサンプル（コピーして watch_targets.json を作る）
    selectors.example.json       ANAサイトのDOMセレクタのサンプル（要キャリブレーション）
  src/
    scheduler.js       メインループ（pm2から起動するエントリポイント）
    accounts.js         アカウントの読み込み・ローテーション管理
    session_manager.js  ログイン・Cookie管理（puppeteer）
    ana_checker.js       空席チェック本体（キャリブレーションモード / 本番モード）
    line_notifier.js     LINE Messaging API 通知
    state_store.js       前回の空席状態の保存（重複通知防止）
    human_delay.js        人間らしいランダム待機のユーティリティ
  data/       Cookie・状態ファイル（gitignore対象）
  logs/       ログ・キャリブレーション用キャプチャ（gitignore対象）
```

## セットアップ

### 1. 依存パッケージのインストール

```bash
cd 03_ana_award_watcher
npm install
```

### 2. `.env` を作成

```bash
cp .env.example .env
```

`.env` に以下を埋める。

- `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_USER_ID`（下記「LINE Messaging APIの準備」参照）
- `ANA_ACCOUNT_1_CUSNUM` / `ANA_ACCOUNT_1_PASSWORD`（お客様番号10桁・Webパスワード）。2個目、3個目は `ANA_ACCOUNT_2_*` `ANA_ACCOUNT_3_*` と番号を増やして追加。

### 3. 監視対象を設定

```bash
cp config/watch_targets.example.json config/watch_targets.json
```

`departureAirport` / `arrivalAirport` は空港コード（例: `HND`, `OKA`）、`date` は `YYYY-MM-DD`。1つのJSON配列に複数路線・複数日付を並べられる。

### 4. LINE Messaging APIの準備

1. [LINE Developers](https://developers.line.biz/) でプロバイダー・チャネル（Messaging API）を新規作成
2. チャネル基本設定から「チャネルアクセストークン（長期）」を発行 → `LINE_CHANNEL_ACCESS_TOKEN`
3. 作成したLINE公式アカウントをスマホのLINEで友だち追加
4. 自分の `userId` を取得する（例: LINE Official Account Managerの「あなたの友だちリスト」テスト送信画面や、Webhookログから確認）→ `LINE_TO_USER_ID`

### 5. 初回キャリブレーション（必須）

ANAの空席照会画面はログイン後にしか描画されないJSアプリのため、実際のセレクタはログインできる環境で1回確認する必要がある。`config/selectors.json` が存在しない間は、自動的に「キャリブレーションモード」で動作し、実際の画面を操作する代わりにスクリーンショット・HTML・通信ログを `logs/capture_*/` に保存するだけになる。

```bash
node src/scheduler.js --once
```

実行後、`logs/capture_*/search_page.png` と `search_page.html`、`network_capture.json` を確認しながら、`config/selectors.example.json` を `config/selectors.json` としてコピーし、実際のCSSセレクタを埋める。埋めるべき項目は以下。

| フィールド | 内容 |
|---|---|
| `awardToggleSelector` | 「特典航空券」を選ぶトグル/タブのセレクタ |
| `departureSelectSelector` | 出発空港の入力欄 |
| `arrivalSelectSelector` | 到着空港の入力欄 |
| `dateInputSelector` | 搭乗日の入力欄 |
| `submitSelector` | 検索実行ボタン |
| `resultContainerSelector` | 検索結果（カレンダー/空席表）のコンテナ |
| `availableCellSelector` | 「空席あり」を示すセル・アイコンのセレクタ（対象の日付にスコープされるよう調整） |

`config/selectors.json` の主要フィールドが埋まると、次回以降は自動的に本番モード（実際にフォーム入力→検索→空席判定）に切り替わる。

### 6. VPSでpm2常駐

```bash
cd 03_ana_award_watcher
npm install
pm2 start ecosystem.config.js
pm2 logs ana-award-watcher --lines 50
```

## 動作イメージ

1. `scheduler.js` が起動し、ランダム間隔（15〜30分）でループ
2. 毎回、現在ローテーション中のANAアカウントでログイン（Cookie再利用、期限切れのみ再ログイン）
3. `config/watch_targets.json` の各対象について空席をチェック
4. 前回「空席なし」→今回「空席あり」に変化した対象があれば、LINEにpush通知
5. 状態は `data/state.json` に保存し、同じ空席を何度も通知しないようにする

## 既知の制約

- ANAサイトのUIリニューアルで `config/selectors.json` のセレクタが壊れる可能性がある。壊れた場合はチェックがエラーになりログに出力されるので、`logs/watcher.log` を確認して再キャリブレーションする。
- VPSのIPはデータセンターIPであり、住宅回線IPと比べて自動アクセス検知の対象になりやすい可能性がある点は完全には解消できない。
- 複数ANAアカウントの運用がANAマイレージクラブの会員規約（1人1アカウント原則など）に抵触しないか、利用前に各自確認すること。
