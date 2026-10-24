# Repository Guidelines

## プロジェクト構成

ISUCON14 の配車サービス ISURIDE を改善するリポジトリです。現在のデプロイ対象は TypeScript / Hono による Node.js 実装です。

- `webapp/nodejs/src/`: API ハンドラー、認証ミドルウェア、型定義。利用者・椅子・オーナー別にファイルを分割します。
- `webapp/nodejs/test/`: Node.js 実装の回帰テスト。
- `webapp/go/`: Go 版のアプリケーション。
- `webapp/sql/`: スキーマ、マスターデータ、初期化スクリプト。
- `webapp/public/`: 配信済みフロントエンド資産と画像。
- `webapp/payment_mock/`: 決済モック。
- `common/etc/`: MySQL・nginx 設定。`scripts/` は計測・運用スクリプトです。
- `docs/`: アプリ仕様と競技マニュアル。API 定義は `webapp/openapi.yaml` を参照します。

## 開発・検証コマンド

以下は `webapp/nodejs/` で実行します。

- `npm ci`: ロックファイルに従って依存関係を導入。
- `npm run dev`: TypeScript を監視して開発サーバーを起動。
- `npm start`: `tsc` でビルドし、`dist/main.js` を起動。
- `npx tsc --noEmit`: strict モードの型検査。
- `npx tsx --test test/*.test.ts`: 回帰テストを実行。
- `npx biome check src test`: フォーマット、import 整理、lint を検査。

ルートでは `task --list` で運用タスクを確認します。`task deploy BRANCH=perf/example` は `s1` にブランチを反映し、MySQL・nginx・アプリを再起動します。`task bench` は計測ログを退避してリモートベンチマークを実行します。解析には `task alp` と `task slowquery` を使います。

## コーディング規約

TypeScript はスペース2文字、ダブルクォートを基本とし、`biome.json` に従います。関数・変数は camelCase、型は PascalCase、既存ハンドラーファイルは `chair_handlers.ts` のような snake_case です。ES Modules の相対 import は既存コード同様に `.js` 拡張子を付けます。Go を変更する場合は `gofmt` を適用します。

## テスト方針

テストは `node:test` と `node:assert/strict` を使い、`test/*.test.ts` に配置します。テスト名には期待する動作を記述してください。通知や SQL を変更するときは、レスポンス、更新内容、トランザクションの正常終了・失敗を検証します。数値によるカバレッジ基準はありません。性能改善では型検査・関連テストに加え、ベンチマークの成功とスコア・処理時間の変化を確認します。

## コミット・Pull Request

履歴に合わせ、コミット件名は `Optimize chair notifications with indexed ride lookups` のような簡潔な英語の命令形にします。ブランチ名は `perf/chair-notification` など、目的が分かる名前を使います。PR には変更理由、変更後の動作、検証コマンドと結果を記載し、性能変更には計測条件と改善前後の数値を添えます。関連 issue があればリンクし、画面変更にはスクリーンショットを添付します。

## 設定・運用上の注意

DB 接続は `ISUCON_DB_HOST`、`ISUCON_DB_PORT`、`ISUCON_DB_USER`、`ISUCON_DB_PASSWORD`、`ISUCON_DB_NAME` で設定します。秘密情報や `.env.discord` をコミットしないでください。ルートの `.gitignore` は登録対象を限定するため、新規ファイルが無視されていないか `git check-ignore` で確認します。
