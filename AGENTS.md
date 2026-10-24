# Repository Guidelines

## 目的と優先順位

このリポジトリは、ISUCON14 の配車サービス ISURIDE の性能を改善し、競技ベンチマークのスコアを高めるためのものです。アプリケーション、SQL、インデックス、MySQL・nginx 設定を横断してボトルネックを解消します。現在のデプロイ対象は TypeScript / Hono による Node.js 実装です。

仕様と競技ルールを守り、ベンチマークが成功する状態を維持してください。推測だけで最適化せず、計測結果から改善対象を選びます。仕様は `docs/ISURIDE.md`、競技マニュアルは `docs/manual.md`、API 定義は `webapp/openapi.yaml` を参照します。

## 改善対象の配置

- `webapp/nodejs/src/`: 利用者・椅子・オーナー向け API、認証、配車処理。
- `webapp/sql/`: スキーマ、インデックス、初期データ、初期化処理。DB 変更は初期化後も再現する形で反映します。
- `common/etc/mysql/`、`common/etc/nginx/`: デプロイする MySQL・nginx 設定。
- `scripts/`: ベンチマーク実行、計測ログのローテーション、解析・Discord 投稿。
- `webapp/go/`: Go 版実装。`webapp/payment_mock/` は決済モック、`webapp/public/` は配信資産です。
- `Taskfile.yml`: デプロイ・計測・解析の操作入口。

## 性能改善の進め方

1. 現在のコミット、設定、スコア、成功可否を記録して基準値を作ります。
2. `task alp` で処理時間の大きい API、`task slowquery` で負荷の高い SQL を特定します。呼び出し回数、総処理時間、走査行数を見て優先順位を決めます。
3. 改善仮説を立て、効果を比較できる単位で変更します。SQL の絞り込み、インデックス、不要な問い合わせ、ロックやトランザクション範囲を確認します。
4. 変更をコミット・push してデプロイし、同じ条件でベンチマークを実行します。成功可否、スコア、API・SQL の処理時間を比較します。
5. 改善前後の数値と採用理由を残します。悪化や失敗があれば原因を調べ、必要に応じて変更を戻します。

## デプロイ・計測コマンド

ルートで実行します。SSH 接続先はアプリ・DB の `s1` と負荷生成用の `bench` です。

- `task --list`: 利用できる操作を確認。
- `task deploy BRANCH=perf/example`: `s1` で指定ブランチを取得し、依存関係の導入、型検査、設定配置、MySQL・nginx・Node アプリの再起動を実施。省略時はローカルの現在ブランチを使います。サーバーに未コミット変更があると中止します。
- `task deploy-config`: サーバーの取得済み設定を配置・検査し、MySQL・nginx を再起動。Git の取得は行いません。
- `task restart` / `task status` / `task logs`: Node アプリの再起動、状態確認、ログ追跡。
- `task bench`: 計測ログを退避・再オープンし、`bench` から `s1` に負荷をかけます。ログ退避だけなら `task logs:rotate`。
- `task alp`: nginx のログを総処理時間順に集計。`/assets/` と `/images/` を除外し、対象 API の可変 ID をまとめます。
- `task slowquery`: MySQL のスロークエリを `pt-query-digest` で解析。
- `task setup:tools`: `s1` に alp と pt-query-digest を導入。

## 結果共有と設定管理

`Taskfile.yml` は `.env.discord` を読み込みます。`DISCORD_WEBHOOK_URL` が設定されていると、`task bench` は結果・実行ログに加え、alp とスロークエリの解析結果を Discord に自動投稿します。再投稿は `task metrics:discord`、個別投稿は `task alp:discord` / `task slowquery:discord` を使います。解析対象は現在のログ全体なので、比較中は別の負荷やログ退避を混ぜないでください。

変更は `perf/chair-notification` のように目的が分かるブランチにまとめ、コミットや PR に改善仮説、対象 API・SQL、計測条件、変更前後のスコアを記載します。秘密情報や Webhook URL はコミットしません。ルートの `.gitignore` は登録対象を限定しているため、新規ファイルは `git check-ignore` で確認します。
