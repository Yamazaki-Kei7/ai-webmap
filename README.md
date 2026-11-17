# AI Webmap

チャットで指示した内容から主題図を作る、技術検証用のデモアプリです。バックエンドは AWS Blocks（`aws-blocks/`）、フロントエンドは SvelteKit（Svelte 5）の静的 SPA（`src/`）です。設計と調査の記録は `docs/` にあります。いまは土台の段階で、画面にはサインインと、サインイン後の仮の画面だけがあります。

## セットアップ

必要なもの: Node.js 22 以上（`package.json` の `engines`）。ただし、単体テストの DOM 環境（`jsdom` 31）は Node `^22.22.2 || ^24.15.0 || >=26.0.0` を要求するので、`npm run test:unit` を動かすにはこの範囲の Node を使ってください。

```bash
npm install
cp .env.example .env   # 3 組のユーザー名とパスワード（8 文字以上）を書く。.env は git に入らない
npm run seed:users     # ローカルのユーザーと利用許可の一覧を作る（開発サーバーを止めた状態で）
npm run dev            # http://localhost:3000 （フロントエンドは内部でポート 3100）
```

## コマンド

| コマンド | 内容 |
|---------|------|
| `npm run dev` | ローカル開発サーバー（Building Blocks のモックを使う。AWS は不要） |
| `npm run dev:stop` | 開発サーバーを止める |
| `npm run seed:users` | ローカルと E2E 用のユーザーを作り、利用許可の一覧に入れる（下記） |
| `npm run admin:create-user` | デプロイ先のユーザーを、認証ブロックのテーブルへの直接の書き込みで作る（運用者用。下記「デプロイ先」。`--dry-run` は AWS に何も送らない） |
| `npm run data:convert` | raw データ（N03、L01、S12、N02、P29）から `data/dist/` の 6 つの GeoParquet（`municipalities`、`prefectures`、`land_prices`、`stations`、`railways`、`schools`）を作り、最後にデータセットのカタログ `shared/catalog.json` も書く（先に `scripts/data/download.sh`。方法と結果は `docs/data-sources.md` の 5 と 6） |
| `npm run data:catalog` | `data/dist/` の既存の 6 ファイルから `shared/catalog.json`（LLM のプロンプトに入るデータセットの説明）を作り直す。文章（`scripts/data/catalog.config.ts`）を直したときに使う（`docs/data-sources.md` の 7） |
| `npm run data:upload` | `data/dist/` の 6 つの Parquet と DuckDB-WASM のバイナリを、ローカルのモック（既定）またはサンドボックスのバケットに入れ、入れたものをダウンロードし直して照合する。`--dry-run`、`--verify-only`、`--target <local\|sandbox>`（下記「データのバケット」。本番には使わない） |
| `npm run test:unit` | 単体テスト（vitest。`src/**`、`shared/**`、`aws-blocks/**`、`scripts/**`） |
| `npm run test:unit:coverage` | 同、カバレッジつき |
| `npm run test:e2e` | E2E テスト（下記） |
| `npm run typecheck` | `svelte-check` による型検査（フロントエンド、バックエンド、テスト） |
| `npm run build` | 型検査のあと、フロントエンドを `build/` に出力 |
| `npm run sandbox` / `sandbox:deploy` / `sandbox:preview` / `sandbox:destroy` / `deploy` | AWS へのデプロイ（AWS の認証情報が必要） |

### 開発用の SQL ボックス

開発サーバー（`npm run dev`）では、サインインしてデータエンジンの準備ができると、画面左のパネルに SQL ボックスが出ます。`geom` 列を返す SQL を入れて「追加」を押すと、結果がレイヤーとして地図に載ります（失敗は `コード: メッセージ` で表示）。チャットができるまでの手動確認用で、本番ビルド（`npm run build`）には入りません。

SQL ボックスの下にスタイルボックスもあります。レイヤーを選び、`StyleSpec`（例 `{"type":"graduated","column":"n","method":"quantile","classes":5,"palette":"ylorrd"}`）または `LabelSpec`（例 `{"column":"pref_name"}`）の JSON を入れて「スタイル適用」「ラベル適用」「ラベル解除」を押すと、地図の見た目が変わります（失敗は `コード: メッセージ` で表示）。これも本番ビルドには入りません。

スタイルボックスの下にはツールボックスもあります。6 つのツール（`runQuery` / `addLayer` / `setLayerStyle` / `setLayerLabel` / `removeLayer` / `setView`）から 1 つ選ぶと、`shared/promptExamples.ts` の例の入力が JSON として入ります。「実行」を押すと、チャットのモデルが呼ぶのと同じ実行器（`src/lib/chat/toolExecutor.ts`）が動き、答えの JSON とそのバイト数が出ます。`window.__aiWebmapTool(request)` でも同じ実行器を呼べます。答えは必ず結果（`ok: true` または `ok: false`）で返り、例外にはなりません。本番ビルドには入りません。

レイヤーパネルは開発サーバーでも本番でも出ます。地図で上に描かれるレイヤーが上（点、線、面の順で、同じ種類は新しい順）で、各カードに名前・ID・件数・表示切替・削除・凡例・SQL（折りたたみ）があります。幅 640 px 以下では見出しだけに畳めます。左下には、表示中のレイヤーが使うデータセットの出典（各 1 回、`CC BY 4.0`）を出します。凡例は地図と同じ `resolved` から作ります（`src/lib/map/legend.ts`）。

## ユーザー

サインアップはできません。画面にサインアップの操作はありません。型付きクライアントから手作りのサインアップを呼ぶことはできますが、`authApi`（`aws-blocks/index.ts`）はサインインとサインアウトだけを受け付け、それ以外のアクションは何も作らず、セッションもそのままにして、エラー付きで現在の認証状態を返します。ユーザーは運用者だけが作ります。

### ローカルと E2E 用

`npm run seed:users`（`scripts/seed/seed-users.ts`）が、ブロックの `auth.signUp` を直接呼んでユーザーを作り、あわせてローカルの利用許可の一覧に入れます。ユーザーは 3 人です。

| 役割 | 変数 | 一覧 | 用途 |
|------|------|------|------|
| 管理者 | `SEED_USERNAME` / `SEED_PASSWORD` | 利用許可と管理者の両方 | データのアップロード（`npm run data:upload`）と通常の確認 |
| 許可 | `SEED_ALLOWED_USERNAME` / `SEED_ALLOWED_PASSWORD` | 利用許可だけ | 管理者ではない、通常の利用者 |
| 不許可 | `SEED_DENIED_USERNAME` / `SEED_DENIED_PASSWORD` | どちらにもない | サインインはできるが、すべての API メソッドが拒否されること（E2E） |

- 資格情報は環境変数で渡します。コマンドラインには渡しません。未設定なら、リポジトリ直下の `.env`（git 管理外。雛形は `.env.example`）から読みます。3 組のどれかが欠けていると、足りない変数名を表示して、何も作らずに終わります。3 つのユーザー名は互いに違うものにしてください。値に `#` や空白を含めるときは引用符で囲んでください（引用符なしの `#` 以降はコメントとして捨てられます）。変数名の定義は `scripts/seed/seed-env.ts` の 1 か所です。
- 冪等です。同じユーザー名がすでにあれば、上書きせずに「作成済み」と表示します。パスワードが違っても、既存のユーザーは変更されません。一覧には、足りない名前だけを足します（**マージ**）。すでにある名前は残し、削除はしません。不許可のユーザーは入れません。2 回目は何も変えません。
- 開発サーバーが動いていると、何もせずにエラーで終わります（ローカルのユーザーの保存先は起動時に一度だけ読まれ、あとで上書きされるため）。先に `npm run dev:stop` で止めてください。
- リポジトリ直下で実行します（保存先が実行時のカレントディレクトリの `.bb-data/` になるため）。`npm run` 経由なら満たされます。

#### 利用許可の一覧（ローカル）

一覧は 2 つで、どちらも `AppSetting`（`aws-blocks/access.ts`）に持つ、ユーザー名の JSON 配列です。既定は `[]` で、未設定、空、JSON でない、文字列の配列でない場合は、一覧が空として扱われ、全員が拒否されます（拒否は 403、`shared/access.ts` の `NotAllowedException`。管理者の一覧に入っていても、利用許可の一覧になければ許可されません）。名前は大文字小文字と空白を含め、ユーザーを作ったときの文字列と完全に一致させます。

- ローカルでは、一覧は `npm run seed:users` だけが書きます。投入するユーザー（管理者と許可のユーザー）が入ります。ほかの名前をローカルの一覧に足す、サポートされた方法は、いまはありません（ローカルのユーザーも、投入スクリプトだけが作ります）。ローカルの保存先は `.bb-data/settings.json` ですが、`.bb-data/` の下のファイルは手で編集しないでください。
- 一覧が壊れている（文字列の配列でない）とき、アプリは空として扱い、`seed:users` は警告（一覧の名前だけ。内容は出さない）を表示して、投入する名前で置き換えます。（マージの判断は単体テスト済み。スクリプトのこの分岐は、ソースを読んだ範囲で、実行はしていない）不許可のユーザーの名前（`SEED_DENIED_USERNAME`）がすでにどちらかの一覧にあると、`seed:users` は何も作らず、何も書かずに、その一覧と変数名を表示して失敗します。別の名前を選んでください（スクリプトは名前を削除しません）。
- ブロックのソースでは、値は呼び出しのたびに保存先から読まれ、キャッシュはありません（ソースを読んだ範囲。実行はしていない）。

#### 開発サーバーのモデル種別

`AGENT_LOCAL_MODEL`（`bedrock` または `canned`。未設定は `bedrock`）で、ローカルのエージェントのモデル種別を切り替えます。それ以外の値だと、開発サーバーはポートを開かず、`AGENT_LOCAL_MODEL must be one of bedrock, canned (got "..."); unset it for bedrock.` というエラーで読み込みに失敗します（実行して確認済み）。`getAppInfo` がこの値を返します。デプロイ先では設定しません。E2E は、自分で開発サーバーを起動するとき `canned` を設定します。`canned` のモデルは、実際のモデルを呼ばず、発言にツール名（または名前の単語）があるとそのツールを 1 回呼び、結果を受けると固定の文で終わります。入力は、各ツールの有効な例（`aws-blocks/agent-canned.ts`）です。

`bedrock` を選んでも、Bedrock が使えない（資格情報が切れている、モデルが使えないなど）と、ブロックは何も知らせずに `canned` に切り替わります。実モデルの確認では、Bedrock が実際に答えたこと（`canned` の固定文ではないこと、`done` の `usage` がゼロでないこと）を確かめてください（Task 4.5 の確認の条件）。

#### 会話の API（`api` の `agent*`）

チャットの会話は、Agent ブロックが動かします（`aws-blocks/agent.ts`）。6 つのツールはブラウザで動くので、ツールの処理（`aws-blocks/agent-tools.ts`）は入力を検査し（SQL は SQL ガードも通す。却下は `SQL_REJECTED` で、ブラウザに送らない）、`interrupt` でブラウザに渡し、返ってきた JSON 文字列を検査して返します。

| メソッド | 内容 |
|------|------|
| `agentCreateConversationId()` | 呼び出した人のものとして会話 ID（UUID）を発行する |
| `agentGetChannel(conversationId)` | Realtime のチャンネル（名前は会話 ID）の `{ channel }` |
| `agentStream(message, conversationId, mapContext)` | ターンを始める。地図の状態を `<map_state>` として発言の後ろに付ける（`shared/mapState.ts`） |
| `agentResume(conversationId, responses)` | interrupt に答える（`{ interruptId, response }` の配列。`response` はツール結果の JSON 文字列） |
| `agentGetConversation(conversationId)`、`agentGetPendingInterrupts(conversationId)` | 履歴と、答えていない interrupt |

どれも、サインイン、利用許可の一覧、引数の検査（400）、会話の所有者の確認（他人の会話と存在しない会話は、どちらも 404）の順に確かめます。Agent ブロックは所有者を確認しないので、確認はここにあります。所有者は、会話 ID を発行するときに `KVStore`（`aws-blocks/conversation-owners.ts`、会話 ID から利用者名）へ記録し、確認は 1 回の `get` です。`agentResume` は、保留中の interrupt の ID だけを受け付けます（偽の ID、重複、答え済みの ID は 409 `InterruptNotPendingException`。保存先は結果整合なので、ブラウザは短い間をあけて 1 回だけやり直してよい）。保留中の interrupt があるときの `agentStream` も 409 `InterruptsPendingException` です。`runQuery`、`addLayer`、`setLayerStyle` の結果は、Agent ブロックが untrusted のデータとして包みます。`<map_state>` の JSON は `<` を `\u003c` にし、発言の中の `<map_state` は全角の `＜` に置き換えます。上限は `shared/config.ts` の `agentConfig`、`mapConfig`、`resultConfig` です。開発サーバーは RPC の引数をそのまま標準出力に出すので、開発ログに発言やクエリ結果が残ります。

### 管理者の一覧

管理者の一覧は、データファイルのアップロード用の署名付き URL を発行する `api.createDatasetUpload` だけを制御します。呼べるのは、利用許可の一覧にも入っている管理者だけです（利用許可がなければ `NotAllowedException`、許可されていても管理者でなければ 403 の `AdminRequiredException`）。管理者の一覧も、未設定や壊れた値は空として扱われます。

### デプロイ先

**この節の手順は、ブロックのソースを読んで書いたもので、デプロイしたアプリではまだ一度も実行していません。最初のデプロイで確認します（ユーザー作成の経路が動かなければ、認証ブロックを、サインアップを無効にしたマネージドなユーザープールに切り替える案があります）。** 以降のコマンドはすべて雛形です。`<…>` は運用者が自分の値に置き換えます。AWS の認証情報とリージョンは、標準の環境変数（`AWS_PROFILE`、`AWS_REGION`）で渡します。

アプリにはサインアップがなく、ユーザーを作る API もありません。デプロイ先のユーザーは、運用者が自分の AWS の資格情報で、認証ブロックのテーブルに直接書き込んで作ります。

#### 1. ユーザーを作る

1. テーブル名を調べます。認証ブロックのユーザーのテーブルの名前は、`<スタック名>-<スコープ名>-auth-users` です（`@aws-blocks/bb-kv-store` の `src/index.cdk.ts` が、ブロックの `fullId` をテーブル名にします。`fullId` は、スタック名、`aws-blocks/scope.ts` の `new Scope('…')` の引数、ブロックの id を `-` でつないだものです。スタック名は本番では `<stackId>-prod`、下の「スタック名」を参照）。候補は、読み取りだけのコマンドで一覧できます。

   ```sh
   aws dynamodb list-tables --profile <プロファイル> --region <リージョン> \
     --query "TableNames[?contains(@, '<スコープ名>-auth-users')]"
   ```

2. まず `--dry-run` で確かめます。入力とパスワードの規則を確かめ、書き込む項目を組み立てて表示するだけで、AWS には何も送らず、AWS のクライアントも作りません（パスワードのハッシュは表示しません）。パスワードは、ターミナルでは入力が表示されない対話の入力で 2 回聞かれます。コマンドラインには渡せません（`--dry-run` 以外の引数は、引数を繰り返さずに拒否されます）。パスワードをコマンドの後ろに書かないでください。npm は与えられた引数を端末に表示し、引数はシェルの履歴にも残りえます（履歴は一般的な話で、このコマンド固有の確認ではありません）。

   ```sh
   ADMIN_USERS_TABLE='<テーブル名>' ADMIN_NEW_USERNAME='<ユーザー名>' \
     npm run admin:create-user -- --dry-run
   ```

3. 同じコマンドから `--dry-run` を外すと、ユーザーを作ります。

   ```sh
   AWS_PROFILE=<プロファイル> AWS_REGION=<リージョン> \
   ADMIN_USERS_TABLE='<テーブル名>' ADMIN_NEW_USERNAME='<ユーザー名>' \
     npm run admin:create-user
   ```

- 変数名の定義は `scripts/admin/admin-env.ts` の 1 か所です。これらの変数は、その 1 回のコマンドのシェルにだけ置きます。このコマンドは `.env` を読みません。変数は `.env.example` にも入れません。デプロイ先のパスワードがプロジェクトのファイルに残らないようにするためです。
- ユーザー名は、与えたとおりに（前後の空白も大文字小文字もそのまま）保存されます。空の名前は拒否されます。
- 標準入力がターミナルでないとき（スクリプトからの実行）だけ、パスワードを環境変数 `ADMIN_NEW_PASSWORD` から読みます。シェルの履歴に残る書き方（コマンドラインへの直接の `ADMIN_NEW_PASSWORD=…`）は避けてください。
- すでにあるユーザーは上書きしません。「すでにある」と表示して、何も変えずに終わります（書き込みは「キーがなければ」の条件つき）。
- このコマンドは、`@aws-blocks/bb-auth-basic` の `signUp` が保存するレコードの形式（フィールド、符号化、bcrypt のコスト 12）とパスワードの規則を、`scripts/admin/user-record.ts` に写しています（パスワードの規則の値は、アプリの `auth.ts` と共有する `aws-blocks/password-policy.ts` の 1 か所、ブロックの検査を写した関数は `user-record.ts` の `passwordViolations` です）。ブロックのパッケージを上げたときは、この写しを確かめ直してください。
- 確認の範囲: レコードの形式は、ブロックのローカルのモックに対して、ブロック自身の `signUp` と `signIn` で単体テストしています。DynamoDB の項目そのもの（属性 `pk` と、値を 2 重に JSON 符号化した文字列の `value`）は、ブロックの AWS 用のソースを読んだだけで、実行していません。

#### 2. 利用許可の一覧にユーザー名を入れる

ユーザーを作っただけでは、アプリは使えません。ユーザー名を利用許可の一覧に入れます。データをアップロードする人だけは、管理者の一覧にも入れます。名前は、作ったユーザーの名前と、大文字小文字も空白も完全に一致させます。

一覧は SSM パラメーターで、名前は `/<スタック名>-<スコープ名>-allowedUsers`（利用許可）と `/<スタック名>-<スコープ名>-adminUsers`（管理者）です（`@aws-blocks/bb-app-setting` の `src/index.cdk.ts` が `/${fullId}` を名前にします）。候補は読み取りだけのコマンドで一覧できます。

```sh
# 利用許可の一覧
aws ssm describe-parameters --profile <プロファイル> --region <リージョン> \
  --parameter-filters "Key=Name,Option=Contains,Values=allowedUsers" \
  --query "Parameters[].Name"

# 管理者の一覧
aws ssm describe-parameters --profile <プロファイル> --region <リージョン> \
  --parameter-filters "Key=Name,Option=Contains,Values=adminUsers" \
  --query "Parameters[].Name"
```

現在の値を読みます（読み取りだけ）。

```sh
aws ssm get-parameter --profile <プロファイル> --region <リージョン> \
  --name '<パラメーター名>' --query Parameter.Value --output text
```

新しい値を書きます。値は、ユーザー名の文字列の JSON 配列の全体です。上書きなので、残す名前も全部含めてください。

```sh
aws ssm put-parameter --profile <プロファイル> --region <リージョン> \
  --name '<パラメーター名>' --type String --overwrite \
  --value '["<ユーザー名>"]'
```

- デプロイのあとは、毎回、2 つのパラメーターをもう一度読み、初期値の `[]` に戻っていたら書き直してください。設定ブロックの CDK は、一覧のパラメーターを初期値 `[]` で作ります（`@aws-blocks/bb-app-setting` の `src/index.cdk.ts`）。CloudFormation の外で書いた値は、そのリソースに更新が入るデプロイで上書きされうる、とソースから推定しています（実行して確かめていません）。戻っている間は、アプリは全員を拒否します（開放はしません）。
- 変更は次の呼び出しから効きます。再デプロイは要りません（アプリは呼び出しのたびにパラメーターを読みます）。
- **パラメーターは削除しないでください。** 削除すると、すべての呼び出しが、きれいな拒否ではなくサーバーエラーで失敗します。全員の利用を止めたいときは、`[]` を書きます。

#### 3. 取り消す

- 利用を止めるには、その名前を一覧から外します（上と同じ書き込み。残す名前だけの配列を書く）。
- ユーザーのレコードをテーブルから消す操作でも、次のリクエストから拒否されます（認証ブロックは、リクエストのたびにユーザーのレコードを引くため）。ここにはコマンドを載せません。この操作は実行していません。

## データのバケット

データファイル（Parquet 6 つ）と DuckDB-WASM のバイナリは、非公開の `FileBucket`（`aws-blocks/datasets.ts`）に置きます。バケットには、署名付き URL でしか届きません（ブロックのソースを読んだ範囲。デプロイしたバケットでは確認していない）。`api.getDatasetSources` が、利用許可のユーザーにだけ、ダウンロード用の署名付き URL（有効期間は `shared/config.ts` の `urlConfig.signedUrlTtlSeconds`）を返します。ファイル名は `shared/datasets.ts` の 1 か所で定義します（Parquet は `datasetFileNames`、wasm は `duckdbWasmFileName`。一覧は `uploadableFiles`）。入れる側の `api.createDatasetUpload` は管理者だけが呼べ、この 7 つの名前以外は拒否します。

`npm run data:upload`（`scripts/data/upload.ts`）が、この 7 つを入れて、照合します。リポジトリ直下で実行します。

- 入れるファイルの元: Parquet は `data/dist/<名前>`（先に `npm run data:convert`）、wasm はインストール済みの `@duckdb/duckdb-wasm` の `dist/duckdb-eh.wasm`（`npm install`）です。7 つがそろっていないと、足りないファイルとそれを作るコマンドを表示して、何も入れずに終わります。
- wasm の版: オブジェクト名の版は `shared/config.ts` の `dataConfig.duckdbWasmVersion` の手書きの値です（ブラウザとバックエンドのコードは `node_modules` を読めないため）。コマンドは、インストール済みの版から作った名前がこれと違うと、両方の版を表示して入れません。`package.json` の依存（バージョンの範囲を使わない固定）、インストール済みの版、`shared/config.ts` の 3 つが同じであることは、単体テストも確かめます。
- 資格情報: 管理者の `SEED_USERNAME` / `SEED_PASSWORD` だけです（環境変数、なければ `.env`。「ユーザー」の節と同じ読み込み処理）。コマンドラインには渡しません。ユーザー名、パスワード、Cookie、署名付き URL は、エラーを含めてどこにも表示しません。
- 入れ方: 名前ごとに 1 つずつ、`api.createDatasetUpload` で URL を得て、`Content-Type`（`shared/datasets.ts` の `uploadContentType`）をつけて `PUT` します。失敗したら、そこで止まり、オブジェクト名、HTTP ステータス、短い理由（レスポンスのエラーコードかメッセージだけ）、すでに入れたものを表示して、終了コード 1 で終わります。
- 照合: 入れたあと（`--verify-only` ではこれだけ）、`api.getDatasetSources` の URL で 7 つをダウンロードし、バイト数、sha256、レスポンスの `Content-Type` を元のファイルと比べて、1 行ずつ `ok` か違いを表示します。1 つが違っても 7 つすべてを調べ、終了コードは 7 つとも一致したときだけ 0 です。
- `--dry-run`: 計画（オブジェクト名、元のパス、content type、バイト数、sha256）を表示するだけです。ネットワーク、設定ファイル、資格情報、クライアントのどれも使いません。`--dry-run` と `--verify-only` は同時に指定できません。

### ローカル

1. `npm run seed:users`（開発サーバーを止めた状態で）
2. `npm run dev` を別のターミナルで起動する
3. `npm run data:upload`（7 つを入れて、7 つが一致するまで確かめる）

`.bb-data/` を消したときは、wasm も消えるので、同じ手順をやり直します。ローカルで実行して確かめました（7 つを入れて 7 つ一致。E2E テストのあとの `--verify-only` でも 7 つ一致）。

### 対象の確認（ガード）

生成されたクライアントは、API の宛先を環境変数 `BLOCKS_API_URL` / `BLOCKS_CONFIG`、なければ `.blocks-sandbox/config.json` から決めます。このファイルは、開発サーバーの起動とデプロイのたびに上書きされるので、そのまま従うと、最後に起動またはデプロイしたものに入れてしまいます。そのため、コマンドはクライアントを読み込む前に、2 つの環境変数が設定されていれば拒否し、ファイルの `environment` が `--target` と同じであること（`local` ではさらに、宛先がこのマシンの開発サーバーのポートであること）を確かめます。確かめた宛先は、そのままクライアントに渡します（クライアントがファイルをもう一度読むことはありません）。表示するのは対象の環境とホストだけです。ファイルがない、または未完成のときは、何を起動するかを表示して終わります。`--target production` は拒否します。

### サンドボックス

**この手順は書いただけで、実行していません**（AWS には一度も接続していません）。

1. サンドボックスをデプロイする（`npm run sandbox:deploy`。AWS の認証情報が必要）。
2. 管理者のユーザーを運用者用コマンドで作り、利用許可と管理者の両方の一覧に名前を入れる（上の「デプロイ先」）。
3. 資格情報を `.env` または環境変数の `SEED_USERNAME` / `SEED_PASSWORD` に置く。
4. `npm run data:upload -- --target sandbox`

デプロイ先のアップロード用 URL は、実際のアップロードで試していません。SDK の既定のチェックサム計算が、空の本体のチェックサムを URL のクエリに入れ、S3 が `PUT` を拒否する可能性があります（ソースを読んだ範囲で、実行はしていない。`aws-blocks/datasets.ts` の注記）。拒否されたら、コマンドは HTTP ステータスと S3 のエラーコードを表示して止まるので、下の AWS CLI の手順に切り替えます。

### 本番

本番はこのコマンドの対象ではありません。`npm run data:upload -- --dry-run` が表示する 7 行（オブジェクト名と元のパス）それぞれについて、AWS CLI で入れます（**実行していません**）。

```sh
aws s3 cp <元のパス> s3://<バケット名>/<オブジェクト名> --content-type <content type> \
  --profile <プロファイル> --region <リージョン>
```

`<content type>` は、`--dry-run` の行にある値です（Parquet は `application/vnd.apache.parquet`、wasm は `application/wasm`）。バケット名は、ブロックのソースでは、バケットの `fullId`（スタック名、`aws-blocks/scope.ts` の `Scope` の名前、`datasets` を `-` でつないだもの）が 63 文字以内ならそのまま名前になります。デプロイしたバケットでは確認していないので、実際の名前は、デプロイしたスタックの出力か、S3 の一覧（読み取りだけの操作）で確かめてください。入れたあとの照合は、利用許可のユーザーでアプリを開いて確かめます（`--verify-only` は本番を対象にできません）。

### データの利用範囲

N03（行政区域）から作った `municipalities.parquet` と `prefectures.parquet` は、ローカルのモックと、このアプリ専用の非公開のバケットにだけ置きます。ほかのバケット、公開の場所、ほかのサービスには置かないでください（N03 の利用条件の記載が食い違うため。経緯は `docs/data-sources.md` の 1、2.3）。

### E2E テストが書き換えるオブジェクト

E2E テストは、アップロードの往復を確かめるために、先頭のデータセットのファイル（`datasetFileNames` の先頭）を、ランダムなバイト列で一度置き換えます。置き換える前の内容を読んでおき、テストの最後に同じバイト列で入れ直して、ダウンロードして一致を確かめます。そのオブジェクトがもともとなかったとき（`.bb-data/` を消した直後など）は、API に削除がないので、ランダムなバイト列が残ります。テストはそのことを 1 行表示します（この「もともとなかった」場合の分岐は、実行していません。ブロックのファイルサーバーのソースを読んで、存在しないオブジェクトの答えが 404 と `NoSuchKey` であることを確かめただけです）。直すには `npm run data:upload` を実行します。E2E テストを途中で止めたときも、オブジェクトにランダムなバイト列が残りえます。`npm run data:upload -- --verify-only` で確かめ、違いが表示されたら `npm run data:upload` をやり直してください。もう 1 つのテストは、`Content-Type` が違う、またはない `PUT` が拒否される（ローカルのモックでは 403）ことと、そのあとのオブジェクトが変わっていないことを確かめます。署名付き URL はテストのメッセージにも出ません。

## E2E テスト

`npm run test:e2e` は、次の順で動きます。

1. 開発サーバーが動いていなければ、`npm run seed:users` でユーザーと一覧を投入する（冪等）。
2. 開発サーバーを `AGENT_LOCAL_MODEL=canned` で起動する。
3. 型付きクライアントで、サインアップなどの手作りの呼び出しが拒否されること（アカウントが作られず、セッションも変わらないこと）と、公開される名前空間が `api` と `authApi` だけであること、投入済みのユーザーのサインイン、サインアウトを確かめる。未サインインの呼び出しと、不許可のユーザーの呼び出しが、`api` のすべてのメソッドで拒否されること、許可のユーザーと管理者が `getAppInfo` の答えを得ることも確かめる。データセットでは、署名付きのダウンロード URL と、アップロード URL が管理者だけに出ることに加えて、アップロードの往復と `Content-Type` の拒否も確かめる。この 2 つは、ローカルのバケットの 1 つのオブジェクトを一度置き換えて元に戻す（上の「E2E テストが書き換えるオブジェクト」）。`data/dist/` は要らない。会話の API は、`canned` のモデルで、ツール呼び出し、interrupt、再開、完了の往復と、他のユーザーの会話の 404、不正な ID と上限超えの 400 を確かめる（`canned` で起動したサーバーのときだけ往復を確かめる）。終わると、起動した開発サーバーを止める。

型付きクライアントはメソッドを列挙できないので、テスト内の `apiArguments` に `api` のメソッドごとの引数を書きます。メソッドを足して `apiArguments` に足さないと、`npm run typecheck` が失敗します。

資格情報は、上の `.env`（または環境変数）から、テストとスクリプトが同じ読み込み処理で得ます。

| 状況 | 動作 |
|------|------|
| `.env` がない初回 | 投入が「資格情報が未設定」のメッセージで失敗し、サーバーは起動しない。`.env` を作って再実行する |
| 2 回目（ユーザーがいる） | 投入は「作成済み」と表示して成功し、テストが通る |
| 開発サーバーが動いていて、ユーザーがいる | 投入せずにそのまま実行し、通る |
| 開発サーバーが動いていて、ユーザーまたは一覧がない | サインインや `getAppInfo` のテストが、「`npm run dev:stop`、`npm run seed:users` の順に実行する」というメッセージで失敗する（コードを読んだ範囲。実行はしていない） |
| 開発サーバーが動いている | モデル種別は `bedrock` と `canned` のどちらでも通る（自分で起動したときだけ `canned` を期待する） |
| ユーザーはいるが、資格情報（`.env`）がない | 投入が未設定のメッセージで失敗する。何も消さない。サーバーが動いている場合は、サインインのテストが未設定のメッセージで失敗する |

## 構成

| パス | 内容 |
|------|------|
| `aws-blocks/index.ts` | バックエンド: `authApi`（サインインとサインアウトだけ）と `api`（アプリの API。各メソッドの先頭で `requireAllowedUser`） |
| `aws-blocks/access.ts` | 利用許可と管理者の一覧（`AppSetting`）と `requireAllowedUser`、`requireAdmin` |
| `aws-blocks/datasets.ts` | データのバケット（`FileBucket`）と署名付き URL の発行 |
| `aws-blocks/agent.ts`、`agent-tools.ts`、`agent-canned.ts` | Agent ブロックと 6 つのツールの処理、`canned` モデル用の入力（ツールの処理と入力は Building Block を作らない関数。単体テストあり） |
| `aws-blocks/conversation.ts`、`conversation-input.ts`、`conversation-access.ts`、`conversation-owners.ts` | 会話の API、引数の検査、所有者の確認（後ろ 2 つは単体テストあり） |
| `aws-blocks/user-list.ts`、`llm-mode.ts` | 一覧の解析と `AGENT_LOCAL_MODEL` の解析（Building Block を作らない関数。単体テストあり） |
| `aws-blocks/auth.ts` | `AuthBasic` のインスタンス。`signUp` を公開する `auth.createApi()` / `auth.buildApi()` の戻り値はどこからも export しない |
| `aws-blocks/scope.ts` | `Scope`（`ai-webmap`）。ローカルの保存先 `.bb-data/` のディレクトリ名の元 |
| `shared/` | フロントエンドとバックエンドが共有する設定（`config.ts`）、エラー名（`access.ts`）、データのファイル名（`datasets.ts`）、LLM が書いた SQL の検査（`sqlGuard.ts`、許可する関数の一覧 `sqlFunctions.ts`） |
| `aws-blocks/password-policy.ts` | パスワードの規則（`auth.ts` と、`scripts/admin/` が共有する 1 か所） |
| `scripts/seed/` | ユーザー作成スクリプトと、資格情報の読み込み |
| `scripts/admin/` | デプロイ先のユーザーを作る運用者用コマンド（`create-user.ts`）。レコードの組み立て（`user-record.ts`）、変数名（`admin-env.ts`）、単体テストあり |
| `scripts/data/` | データの取得（`download.sh`）と変換（`convert.ts`）。設定は `datasets.config.ts`、純粋関数は `convert-plan.ts`、単体テストあり。バケットへの投入は `upload.ts`（引数 `upload-args.ts`、計画 `upload-plan.ts`、対象の確認 `upload-target.ts`、入れ方と照合 `upload-flow.ts`、エラーの理由 `upload-reason.ts`） |
| `src/routes/` | フロントエンド: `+layout.svelte` にアカウントメニュー、`+page.svelte` にトップ画面 |
| `test/e2e.test.ts` | E2E テスト |

## フロントエンド

[SvelteKit](https://svelte.dev/docs/kit)（Svelte 5）と [Tailwind CSS](https://tailwindcss.com) v4 による静的 SPA です。`@sveltejs/adapter-static` が `build/` に出力し、サーバーサイドレンダリングは無効です（`src/routes/+layout.ts`）。

- `aws-blocks/index.cdk.ts` の `framework: 'spa'` が必要です。外すと、Hosting が SvelteKit を SSR として Lambda にデプロイしようとして、`adapter-static` ではビルドできません。
- `+page.server.ts`、`+server.ts`、`hooks.server.ts` はデプロイ後に動きません。サーバー側の処理は `aws-blocks/index.ts` に書きます。
- Blocks の UI 部品は DOM 要素です。`src/lib/mountNode.ts` の `mountNode` で取り付けます。

### チャットのセッション

右のドックに仮のチャット（`src/lib/components/TempChatBox.svelte`。のちのチャットパネルが置き換えます）があります。会話は `src/lib/chat/chatSession.svelte.ts` が動かします。Agent ブロックの `createChat` を Realtime のトランスポートで `agent*` の API につなぎ、モデルのツール呼び出し（interrupt）をブラウザの実行器で動かして、結果をまとめて 1 回で返します。ターンが終わる（`done` かエラー）まで送信できません。「新しい会話」を押すと、実行中のターンは捨てられ、その後のツール呼び出しには `SESSION_RESET` を返します。ストアの結果整合のための 409 / 404 は、`shared/config.ts` の `chatConfig.retryDelaysMs` の間隔で再試行します。ページを再読み込みすると会話は引き継がれません（古い会話の保留中の interrupt はサーバーに残ります）。

### データエンジン（DuckDB-WASM）

`src/lib/duckdb/` がブラウザ内の DuckDB-WASM（`eh` ビルドのみ）を起動し、Parquet を必要になった時点で取得してビューにします。サインイン後に `+page.svelte` が起動し、サインアウトで破棄します。

- wasm と各 Parquet は、`api.getDatasetSources()` が返す署名付き URL から取得します（許可リストのユーザーのみ）。署名付き URL は HEAD に 403 を返すので、ファイルは丸ごと `fetch` します。
- 初期化のたびに URL を取り直します。遅延取得の前は、有効期限まで `urlConfig.refreshMarginSeconds` を切っていれば取り直し、403 なら一度だけ取り直して再試行します。
- 設定は `engineConfig`（`shared/config.ts`）。`SET lock_configuration = true` で固定します。外部読み取りの防御は SQL ガード（`shared/sqlGuard.ts`）です。
- クエリは `queryLayer(sql)`（`geom` 列を GeoJSON のレイヤーにする）と `queryTable(sql, maxRows)`（表にする）で実行します。どちらも SQL ガードを通し、一度に 1 本ずつ流し、`queryConfig.timeoutMs` でキャンセルします（止まらなければワーカーを作り直します）。結果とエラーは `ClientToolResult`（`shared/toolProtocol.ts`）で返します。
- 開発サーバー（`import.meta.env.DEV`）では `window.__aiWebmapEngine`（`ensureViews` / `count(id)` / `scalar(sql)` / `queryLayer` / `queryTable`）で、UI なしにブラウザから確認できます。本番ビルドには入りません。

## スタック名

CloudFormation のスタック名は `.blocks/config.json` の `stackId` から決まります（本番は `<stackId>-prod`）。変えると別のスタックになるので、変えないでください。

## エージェント向け

Building Blocks の文書は `node_modules/@aws-blocks/blocks/README.md` にあります。永続化にはローカルのファイルやメモリを使わず、Building Blocks を使ってください。API の呼び出しには、`import { api, authApi } from 'aws-blocks'` の型付きクライアントを使い、JSON-RPC を手で組み立てません。詳細は `AGENTS.md` を参照してください。
