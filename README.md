# AI Webmap

チャットで話しかけて主題図（色分け地図）を作る、技術検証用のデモアプリです。「学校を種別で色分けして」「市区町村ごとの駅の数で塗り分けて」のような日本語の依頼から、モデルが SQL とスタイルを組み立て、ブラウザの中でデータを引いて地図に描きます。

- バックエンドは AWS Blocks（`aws-blocks/`）、フロントエンドは SvelteKit（Svelte 5）の静的 SPA（`src/`）です。
- データは国土数値情報の 5 種（行政区域、地価公示、駅別乗降客数、鉄道、学校）から作った Parquet 6 ファイルで、ブラウザ内の DuckDB-WASM が読みます。
- モデルは Amazon Bedrock の Claude Haiku 5.5（`jp.anthropic.claude-haiku-5-5`）だけです。
- 設計と調査の記録は `docs/`（`spikes.md`、`data-sources.md`、`verification.md`）にあります。

## 概要

### 何ができるか

- チャットの依頼で、レイヤーの追加、4 種のスタイル（単色、分類、段階、比例）の設定、ラベルの設定、視点の移動、レイヤーの削除ができる。
- 地図の状態（レイヤー、スタイル、表示範囲）をモデルは毎回の発言で受け取るので、「さっきのレイヤーの色を青系に変えて」のような続きの依頼が通る。
- 地図を保存し、あとで開いて続きをやり直せる（保存するのはレイヤーの SQL とスタイルで、地物は保存せず、開くときに SQL を実行し直す）。
- サインアップはできない。ユーザーは運用者だけが作る。

### 画面の構成

| 場所 | 内容 |
|------|------|
| 上部バー | アカウントメニュー、地図のタイトルと「保存」「開く」「新規作成」 |
| 中央 | 地図（MapLibre）。左下に、表示中のレイヤーが使うデータの出典（`CC BY 4.0`） |
| 左 | レイヤーパネル。レイヤーごとに名前・ID・件数・表示切替・削除・凡例・SQL（折りたたみ）。凡例は地図と同じ `resolved` から作る（`src/lib/map/legend.ts`）。開発サーバーでは「開発用」のボックスも出る |
| 右 | チャットパネル。ツールの実行状況も出る |

## 構成

```
 ブラウザ                                              AWS（Building Blocks）
┌─────────────────────────────────────────┐          ┌──────────────────────────────┐
│ チャットパネル ── ChatSession            │  RPC     │ api（会話・地図・データの API）│
│   │ interrupt（ツール呼び出し）を受ける  │◄────────►│   サインイン / 許可の一覧     │
│   ▼                                      │ Realtime │ Agent ブロック ── Bedrock    │
│ ツール実行器 ── SQL ガード               │          │   （Claude Haiku 5.5）        │
│   ▼                                      │          │ FileBucket（Parquet、wasm）  │
│ DuckDB-WASM ── GeoParquet（署名付き URL）│◄─────────│ DistributedTable（保存した地図）│
│   ▼ GeoJSON                              │          │ KVStore（会話の持ち主）       │
│ MapLibre（地図、凡例、レイヤー一覧）     │          └──────────────────────────────┘
└─────────────────────────────────────────┘
```

- **ブラウザでデータを引く。** サーバーはデータを処理しません。`api.getDatasetSources()` が署名付き URL を返し、ブラウザが Parquet を丸ごと取得して DuckDB-WASM（`eh` ビルド）に登録します。クエリ結果（地物）はブラウザに残り、モデルには列、件数、先頭の行、階級などの要約だけを返します。
- **ツールはブラウザで動く。** モデルのツール（`runQuery`、`addLayer`、`setLayerStyle`、`setLayerLabel`、`removeLayer`、`setView`）は、バックエンドのハンドラーが入力を検査して `interrupt` でブラウザに渡し、ブラウザの実行器（`src/lib/chat/toolExecutor.ts`）が実行して結果を返します。結果はまた検査して、モデルに渡されます。
- **データの流れ。** 依頼 → `agentStream`（地図の状態を `<map_state>` として発言に付ける）→ モデルがツールを呼ぶ → interrupt が Realtime でブラウザへ → SQL ガード → DuckDB-WASM → 地図に描く → 結果の要約を `agentResume` で返す → モデルが答える。1 回の依頼で、モデルは通常 2 回呼ばれます。
- **保存。** 地図は `DistributedTable`、会話の持ち主は `KVStore` に置きます。会話の履歴は Agent ブロックが持ちます。

| パス | 内容 |
|------|------|
| `aws-blocks/index.ts` | バックエンド: `authApi`（サインインとサインアウトだけ）と `api`（アプリの API。各メソッドの先頭で `requireAllowedUser`） |
| `aws-blocks/access.ts` | 利用許可と管理者の一覧（`AppSetting`）と `requireAllowedUser`、`requireAdmin` |
| `aws-blocks/datasets.ts` | データのバケット（`FileBucket`）と署名付き URL の発行 |
| `aws-blocks/agent.ts`、`agent-tools.ts`、`agent-canned.ts` | Agent ブロックと 6 つのツールの処理、`canned` モデル用の入力（ツールの処理と入力は Building Block を作らない関数。単体テストあり） |
| `aws-blocks/conversation.ts`、`conversation-input.ts`、`conversation-access.ts`、`conversation-owners.ts` | 会話の API、引数の検査、所有者の確認（後ろ 2 つは単体テストあり） |
| `aws-blocks/maps.ts`、`maps-input.ts`、`maps-access.ts`、`maps-table.ts` | 保存した地図の API、引数の検査、所有者を限った読み書き、テーブル（`maps-input.ts`、`maps-access.ts` は単体テストあり） |
| `aws-blocks/user-list.ts`、`llm-mode.ts` | 一覧の解析と `AGENT_LOCAL_MODEL` の解析（Building Block を作らない関数。単体テストあり） |
| `aws-blocks/auth.ts` | `AuthBasic` のインスタンス。`signUp` を公開する `auth.createApi()` / `auth.buildApi()` の戻り値はどこからも export しない |
| `aws-blocks/password-policy.ts` | パスワードの規則（`auth.ts` と、`scripts/admin/` が共有する 1 か所） |
| `aws-blocks/scope.ts` | `Scope`（`ai-webmap`）。ローカルの保存先 `.bb-data/` のディレクトリ名の元 |
| `shared/` | フロントエンドとバックエンドが共有するもの。設定（`config.ts`）、エラー名（`access.ts`）、データのファイル名（`datasets.ts`）、データセットのカタログ（`catalog.json`）、プロンプト（`prompt.ts`）、ツールの入出力（`toolProtocol.ts`）、スタイルの仕様（`mapSpec.ts`）、LLM が書いた SQL の検査（`sqlGuard.ts`、許可する関数の一覧 `sqlFunctions.ts`） |
| `scripts/seed/`、`scripts/admin/`、`scripts/data/` | ユーザーの作成（ローカル）、デプロイ先のユーザーの作成（運用者用）、データの取得・変換・カタログ・投入 |
| `src/lib/duckdb/`、`src/lib/chat/`、`src/lib/map/`、`src/lib/components/` | データエンジン、チャットのセッションとツール実行器、地図の状態とスタイル・凡例・保存、画面の部品 |
| `src/routes/` | `+layout.svelte` にテーマの注入、`+page.svelte` にトップ画面（アカウントメニューは `src/lib/components/AppShell.svelte`） |
| `test/e2e.test.ts` | E2E テスト（バックエンドの API を型付きクライアントで確かめる） |

## 必要なもの

- Node.js 22 以上（`package.json` の `engines`）。ただし、単体テストの DOM 環境（`jsdom` 31）は Node `^22.22.2 || ^24.15.0 || >=26.0.0` を要求するので、`npm run test:unit` を動かすにはこの範囲の Node を使ってください。
- ローカルで動かすだけなら AWS は要りません（Building Blocks のモックを使う）。実モデル（Bedrock）を使う確認と、デプロイには、AWS の認証情報（Bedrock で `jp.anthropic.claude-haiku-5-5` を呼べること）が要ります。
- データの変換には、`data/raw/` に取得した元データと、`scripts/data/download.sh` が使う道具（mapshaper など。`docs/data-sources.md` の 3、5）が要ります。変換済みの `data/dist/` がなければ、先に変換します。

## ローカルでの起動

```bash
npm install
cp .env.example .env   # 3 組のユーザー名とパスワード（8 文字以上）を書く。.env は git に入らない
npm run seed:users     # ローカルのユーザーと利用許可の一覧を作る（開発サーバーを止めた状態で）
npm run dev            # http://localhost:3000 （フロントエンドは内部でポート 3100）
npm run data:upload    # 別のターミナルで。dev が動いている状態で、データ 6 つと wasm をローカルのバケットに入れる
```

`data/dist/` がないときは、`npm run data:upload` の前に `npm run data:convert` を実行します（下の「データの準備」）。`.bb-data/` を消すと wasm も消えるので、`npm run data:upload` をやり直します。

### コマンド

| コマンド | 内容 |
|---------|------|
| `npm run dev` | ローカル開発サーバー（Building Blocks のモックを使う。AWS は不要） |
| `npm run dev:stop` | 開発サーバーを止める |
| `npm run seed:users` | ローカルと E2E 用のユーザーを作り、利用許可の一覧に入れる（下記） |
| `npm run admin:create-user` | デプロイ先のユーザーを、認証ブロックのテーブルへの直接の書き込みで作る（運用者用。下記「デプロイ」。`--dry-run` は AWS に何も送らない） |
| `npm run data:convert` | raw データ（N03、L01、S12、N02、P29）から `data/dist/` の 6 つの GeoParquet を作り、最後に `shared/catalog.json` も書く |
| `npm run data:catalog` | `data/dist/` の既存の 6 ファイルから `shared/catalog.json` を作り直す（文章を直したとき） |
| `npm run data:upload` | `data/dist/` の 6 つの Parquet と DuckDB-WASM のバイナリを、ローカルのモック（既定）またはサンドボックスのバケットに入れ、ダウンロードし直して照合する。`--dry-run`、`--verify-only`、`--target <local\|sandbox>`（本番には使わない） |
| `npm run test:unit` | 単体テスト（vitest。`src/**`、`shared/**`、`aws-blocks/**`、`scripts/**`） |
| `npm run test:unit:coverage` | 同、カバレッジつき |
| `npm run test:e2e` | E2E テスト（下記「テスト」） |
| `npm run typecheck` | `svelte-check` による型検査（フロントエンド、バックエンド、テスト） |
| `npm run build` | 型検査のあと、フロントエンドを `build/` に出力。`aws-blocks/client.js` を書き換える（下記） |
| `npm run sandbox` / `sandbox:deploy` / `sandbox:preview` / `sandbox:destroy` / `deploy` | AWS へのデプロイ（AWS の認証情報が必要。下記「デプロイ」） |

### 生成されるクライアント `aws-blocks/client.js`

`aws-blocks/client.js` は型付きクライアントで、リポジトリにはローカル用（`@aws-blocks/bb-realtime/mock-middleware` を読む版）がコミットされています。`npm run dev` の起動はローカル用に書き直します（差分は出ません）。`npm run build`（`prebuild` の `blocks-generate-client`）とデプロイは AWS 用（`@aws-blocks/bb-realtime/aws-middleware`）に書き換え、`npm run build` を繰り返しても元に戻りません。ビルドやデプロイのあとにローカルの開発に戻るときは、その 1 行を `mock-middleware` に戻して、`git diff -- aws-blocks/client.js` が空であることを確かめてください（コミットしない）。

### モデル種別（`AGENT_LOCAL_MODEL`）

`AGENT_LOCAL_MODEL`（`bedrock` または `canned`。未設定は `bedrock`）で、ローカルのエージェントのモデル種別を切り替えます。それ以外の値だと、開発サーバーはポートを開かず、`AGENT_LOCAL_MODEL must be one of bedrock, canned (got "..."); unset it for bedrock.` というエラーで読み込みに失敗します（実行して確認済み）。`getAppInfo` がこの値を返します。デプロイ先では設定しません。

- `canned`: 実際のモデルを呼びません。発言にツール名（または名前の単語）があるとそのツールを 1 回呼び、結果を受けると固定の文で終わります。入力は、各ツールの有効な例（`aws-blocks/agent-canned.ts`）です。E2E は、自分で開発サーバーを起動するとき `canned` を設定します。
- `bedrock`: Bedrock のモデルを呼びます。AWS の認証情報は、プロファイルを `AWS_PROFILE` で渡して `npm run dev` を起動します。Bedrock が使えない（資格情報が切れている、モデルが使えないなど）と、ブロックは何も知らせずに `canned` に切り替わります。実モデルの確認では、Bedrock が実際に答えたこと（`canned` の固定文ではないこと、ツール呼び出しの id が `tooluse_…` であること、`done` の `usage` がゼロでないこと）を確かめてください。

### 開発用のボックス

開発サーバー（`npm run dev`）では、サインインしてデータエンジンの準備ができると、画面左のパネルの「開発用」（初期は閉じています）に 3 つのボックスが出ます。本番ビルド（`npm run build`）には入りません。

- **SQL ボックス**: `geom` 列を返す SQL を入れて「追加」を押すと、結果がレイヤーとして地図に載ります（失敗は `コード: メッセージ` で表示）。
- **スタイルボックス**: レイヤーを選び、`StyleSpec`（例 `{"type":"graduated","column":"n","method":"quantile","classes":5,"palette":"ylorrd"}`）または `LabelSpec`（例 `{"column":"pref_name"}`）の JSON を入れて「スタイル適用」「ラベル適用」「ラベル解除」を押します。
- **ツールボックス**: 6 つのツールから 1 つ選ぶと、`shared/promptExamples.ts` の例の入力が JSON として入ります。「実行」を押すと、チャットのモデルが呼ぶのと同じ実行器が動き、答えの JSON とそのバイト数が出ます。`window.__aiWebmapTool(request)` でも同じ実行器を呼べます。答えは必ず結果（`ok: true` または `ok: false`）で返り、例外にはなりません。

ブラウザからの確認用に、開発サーバーでは `window.__aiWebmapEngine`（`ensureViews` / `count(id)` / `scalar(sql)` / `queryLayer` / `queryTable`）、`window.__aiWebmapPersist`（保存・復元・API）、`window.__aiWebmapChat`（`openConversation`）も使えます。

### ユーザー（ローカルと E2E 用）

サインアップはできません（下記「安全のための仕組み」）。`npm run seed:users`（`scripts/seed/seed-users.ts`）が、ブロックの `auth.signUp` を直接呼んでユーザーを作り、あわせてローカルの利用許可の一覧に入れます。ユーザーは 3 人です。

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

- ローカルでは、一覧は `npm run seed:users` だけが書きます。投入するユーザー（管理者と許可のユーザー）が入ります。ほかの名前をローカルの一覧に足す、サポートされた方法は、いまはありません。ローカルの保存先は `.bb-data/settings.json` ですが、`.bb-data/` の下のファイルは手で編集しないでください。
- 一覧が壊れている（文字列の配列でない）とき、アプリは空として扱い、`seed:users` は警告（一覧の名前だけ。内容は出さない）を表示して、投入する名前で置き換えます。（マージの判断は単体テスト済み。スクリプトのこの分岐は、ソースを読んだ範囲で、実行はしていない）不許可のユーザーの名前（`SEED_DENIED_USERNAME`）がすでにどちらかの一覧にあると、`seed:users` は何も作らず、何も書かずに、その一覧と変数名を表示して失敗します。別の名前を選んでください（スクリプトは名前を削除しません）。
- ブロックのソースでは、値は呼び出しのたびに保存先から読まれ、キャッシュはありません（ソースを読んだ範囲。実行はしていない）。

## データの準備

### 元データと変換

データは国土数値情報の 5 種で、`scripts/data/download.sh` で `data/raw/` に取得し（`data/` は git の管理外）、`npm run data:convert` で `data/dist/` の 6 つの GeoParquet にします。

| 元データ | 作るファイル（テーブル名） |
|---------|------------------------|
| N03 行政区域 | `municipalities`、`prefectures` |
| L01 地価公示 | `land_prices` |
| S12 駅別乗降客数、N02 鉄道 | `stations`（S12 の駅と乗降客数を点にしたもの）、`railways`（N02 の路線を事業者の組でまとめたもの） |
| P29 学校 | `schools` |

- 行政区域は、mapshaper で簡略化して市区町村ごとに統合します。点のデータには、市区町村コード（`muni_code`）を空間結合で付けます。
- 変換の方法、結果、各表の使い方の注意（表ごとの列、値の意味）、未確認の点は `docs/data-sources.md` の 5 と 6 にあります。取得元、採用した版、利用条件は同じ文書の 1 と 2 です。
- `npm run data:convert` は最後にカタログ `shared/catalog.json`（データセットの説明。列、件数、代表的な値など）も書きます。カタログはモデルのプロンプトに入ります。文章（`scripts/data/catalog.config.ts`）だけを直したときは `npm run data:catalog` で作り直します（`docs/data-sources.md` の 7）。

### データのバケットと投入

データファイル（Parquet 6 つ）と DuckDB-WASM のバイナリは、非公開の `FileBucket`（`aws-blocks/datasets.ts`）に置きます。バケットには、署名付き URL でしか届きません（ブロックのソースを読んだ範囲。デプロイしたバケットでは、アクセスの設定そのものは確認していない）。`api.getDatasetSources` が、利用許可のユーザーにだけ、ダウンロード用の署名付き URL（有効期間は `shared/config.ts` の `urlConfig.signedUrlTtlSeconds`）を返します。ファイル名は `shared/datasets.ts` の 1 か所で定義します（Parquet は `datasetFileNames`、wasm は `duckdbWasmFileName`。一覧は `uploadableFiles`）。入れる側の `api.createDatasetUpload` は管理者だけが呼べ、この 7 つの名前以外は拒否します。

`npm run data:upload`（`scripts/data/upload.ts`）が、この 7 つを入れて、照合します。リポジトリ直下で実行します。

- 入れるファイルの元: Parquet は `data/dist/<名前>`（先に `npm run data:convert`）、wasm はインストール済みの `@duckdb/duckdb-wasm` の `dist/duckdb-eh.wasm`（`npm install`）です。7 つがそろっていないと、足りないファイルとそれを作るコマンドを表示して、何も入れずに終わります。
- wasm の版: オブジェクト名の版は `shared/config.ts` の `dataConfig.duckdbWasmVersion` の手書きの値です（ブラウザとバックエンドのコードは `node_modules` を読めないため）。コマンドは、インストール済みの版から作った名前がこれと違うと、両方の版を表示して入れません。`package.json` の依存（バージョンの範囲を使わない固定）、インストール済みの版、`shared/config.ts` の 3 つが同じであることは、単体テストも確かめます。
- 資格情報: 管理者の `SEED_USERNAME` / `SEED_PASSWORD` だけです（環境変数、なければ `.env`）。コマンドラインには渡しません。ユーザー名、パスワード、Cookie、署名付き URL は、エラーを含めてどこにも表示しません。
- 入れ方: 名前ごとに 1 つずつ、`api.createDatasetUpload` で URL を得て、`Content-Type`（`shared/datasets.ts` の `uploadContentType`）をつけて `PUT` します。失敗したら、そこで止まり、オブジェクト名、HTTP ステータス、短い理由（レスポンスのエラーコードかメッセージだけ）、すでに入れたものを表示して、終了コード 1 で終わります。
- 照合: 入れたあと（`--verify-only` ではこれだけ）、`api.getDatasetSources` の URL で 7 つをダウンロードし、バイト数、sha256、レスポンスの `Content-Type` を元のファイルと比べて、1 行ずつ `ok` か違いを表示します。1 つが違っても 7 つすべてを調べ、終了コードは 7 つとも一致したときだけ 0 です。
- `--dry-run`: 計画（オブジェクト名、元のパス、content type、バイト数、sha256）を表示するだけです。ネットワーク、設定ファイル、資格情報、クライアントのどれも使いません。`--dry-run` と `--verify-only` は同時に指定できません。
- 対象の確認（ガード）: 生成されたクライアントは、API の宛先を環境変数 `BLOCKS_API_URL` / `BLOCKS_CONFIG`、なければ `.blocks-sandbox/config.json` から決めます。このファイルは、開発サーバーの起動とデプロイのたびに上書きされるので、そのまま従うと、最後に起動またはデプロイしたものに入れてしまいます。そのため、コマンドはクライアントを読み込む前に、2 つの環境変数が設定されていれば拒否し、ファイルの `environment` が `--target` と同じであること（`local` ではさらに、宛先がこのマシンの開発サーバーのポートであること）を確かめます。確かめた宛先は、そのままクライアントに渡します。表示するのは対象の環境とホストだけです。ファイルがない、または未完成のときは、何を起動するかを表示して終わります。`--target production` は拒否します。

ローカルでは、`npm run seed:users`（開発サーバーを止めた状態で）→ `npm run dev`（別のターミナル）→ `npm run data:upload`（7 つを入れて、7 つが一致するまで確かめる）の順です。ローカルで実行して確かめました（7 つを入れて 7 つ一致。E2E テストのあとの `--verify-only` でも 7 つ一致）。

## チャットでできること

### ツール

モデルが呼ぶツールは 6 つです（入力のスキーマは `shared/toolProtocol.ts` と `shared/mapSpec.ts`）。

| ツール | 内容 |
|--------|------|
| `runQuery` | SELECT を実行して、値を調べる（返すのは最大 `queryConfig.maxRows` 行。描画はしない） |
| `addLayer` | クエリの結果（`geom` 列つき）を新しいレイヤーとして描く。名前、スタイル、ラベル、`replaceLayerId`（既存のレイヤーを差し替える）、`zoomTo` を指定できる |
| `setLayerStyle` | 既存のレイヤーの色とサイズを変える。省略できる `name` で、名前が合わなくなったレイヤーの改名もできる |
| `setLayerLabel` | ラベルの表示と非表示 |
| `removeLayer` | レイヤーの削除 |
| `setView` | レイヤー、範囲、中心とズーム、または場所を引くクエリへの移動 |

### スタイルの種類

| 種類 | 内容 |
|------|------|
| `single` | 単色 |
| `categorized` | 値ごとの色分け（定性パレット `set2` / `tableau10` / `paired`。値ごとの色は `overrides` で指定） |
| `graduated` | 数値の段階分け（分位数などの分類、階級数、連続パレット `blues` / `greens` / `reds` / `oranges` / `purples` / `ylorrd` / `viridis`） |
| `proportional` | 値に比例した円の大きさ（点）や線の太さ |

共通で、不透明度、枠線の色と太さ、サイズを指定できます。凡例は、種類ごとに地図の見た目と同じ値から作ります。

### ラベル

列を 1 つ指定して、レイヤーに名前などを出します。面のレイヤーのラベルは、地物ごとに 1 点（面積が最大の部分の内側の代表点。`src/lib/map/labelPoint.ts`）に置くので、飛び地や島のある県でも名前は 1 つです。`minZoom` は、地物が `promptConfig.labelMinZoomFeatureHint` 個以上のときだけ付けるよう、プロンプトでモデルに指示しています（付けたら答えでズームの条件を伝える）。重なるラベルは地図が間引き、ズームを上げると増えます。ラベルがジオメトリの上に出る順序は、非表示のアンカーレイヤー（`mapConfig.labelAnchorLayerId`）で決めます。

### 視点

`setView` は、レイヤー（`layer`）、範囲（`bbox`）、中心とズーム（`center`）、場所を引くクエリ（`query`。`geom` 列を返す SELECT。レイヤーとしては追加せず、結果の範囲に合わせて動く）のいずれかに移動します。

### 保存・開く・新規作成

上部バーのタイトルの隣に「保存」「開く」「新規作成」のボタンと、いまの地図のタイトル（保存前は「無題の地図」）があります。保存すると、最初の 1 回は新しい地図を作り、あとは同じ地図を、そのときのチャットの会話 ID とともに更新します。開くときは、保存されていない変更があれば先に確認し、会話を先に開いてからレイヤーを復元します（復元中は入力を止めて進み具合を出し、復元できなかったレイヤーはカードにエラーを出して残します）。新規作成は、保存されていない変更があれば確認してから、地図を空にして新しい会話を始めます。更新は、保存した（または開いた）版の `updatedAt` を `expectedUpdatedAt` として送るので、別の画面で先に保存されていれば 409 になり、ダイアログに競合のメッセージと「新しい地図として保存」を出します（上書きはしません）。詳しい仕様は下の「内部の仕様」にあります。

## 安全のための仕組み

- **SQL ガード**（`shared/sqlGuard.ts`、許可する関数の一覧は `shared/sqlFunctions.ts`）。モデルが書いた SQL は、バックエンドのツール処理とブラウザの実行器の両方で、実行の前に検査します。`SET lock_configuration = true` は `LOAD`、`INSTALL`、外部 URL の読み取り、`COPY ... TO` を止めないので、このガードが主な防御です。1 つの SELECT または WITH だけを許し（文の途中のセミコロン、`INSERT`、`CREATE`、`COPY`、`SET`、`PRAGMA`、`INSTALL`、`LOAD` などの語は却下）、関数の呼び出しは許可の一覧にある名前だけです（ファイルや URL を読む関数は名前でも却下）。文字列やクォートした名前にパスや URL（ファイル名）が入る、ドル記号、エスケープの列、ASCII 以外の空白なども却下します。許可の一覧が広く却下するほうに倒してあり、誤って却下することはあっても、誤って通さないことを優先しています。却下は `SQL_REJECTED` でモデルに返り、バックエンドの検査で却下したものはブラウザに送りません。
- **許可リスト**。サインインしたユーザーでも、利用許可の一覧に名前がなければ、`api` のすべてのメソッドが 403 `NotAllowedException` です。データのアップロード URL は、さらに管理者の一覧に入っている人だけに出ます。
- **サインアップなし**。画面にサインアップの操作はなく、`authApi`（`aws-blocks/index.ts`）はサインインとサインアウトだけを受け付けます。型付きクライアントから手作りのサインアップを送っても `Action not supported: signUp` で拒否され、アカウントは作られず、セッションも変わりません（サンドボックスでも確かめた）。ユーザーは運用者だけが作ります。
- **ツールの結果は untrusted**。`runQuery`、`addLayer`、`setLayerStyle` の結果は、データの中の文字列をモデルが指示として読まないよう、Agent ブロックが untrusted のデータとして包みます。結果は 1 件 `resultConfig.maxToolResultBytes`（16 KiB）までに縮めてから返します。`<map_state>` の JSON は `<` を `\u003c` にし、発言の中の `<map_state` は全角の `＜` に置き換えます。画面は、モデルの発言も、レイヤーの名前やデータの文字列も、すべて文字として表示し、HTML としては扱いません（`{@html}` は使わない。単体テストで確かめる）。
- **会話の所有者の確認**。Agent ブロックは会話の持ち主を確認しないので、`agent*` と、会話 ID を受ける `saveMap` で、API 側が確認します。所有者は、会話 ID を発行するときに `KVStore`（`aws-blocks/conversation-owners.ts`）に記録します。他人の会話と存在しない会話は、どちらも 404 です。Realtime のチャンネル名は、ユーザー名ではなく、サーバーが発行した会話 ID です。
- **地図の所有者**。保存した地図は、パーティションキーが `userId`（サインインした利用者の名前。クライアントの引数からは取らない）の `DistributedTable` に置きます。他人の地図と存在しない地図は、どちらも 404 です。
- **署名付き URL**。データのダウンロード URL の有効期間は 1 時間で、許可リストのユーザーにだけ返します。URL はエラーメッセージやログに出さず、ユーザー名、パスワード、Cookie も同じです。
- **上限**。モデルの 1 ターンあたりの回数（`agentConfig` の `maxLlmCalls`、`maxToolIterations`）、クエリの時間（`queryConfig.timeoutMs`）、行数、地物数、地図の保存件数などは、`shared/config.ts` にあります。ただし、利用許可の一覧に入った人は、これらの上限の範囲で Bedrock を繰り返し呼べます（1 人あたりの回数制限はありません）。

## 内部の仕様

### バックエンドの API

#### 会話の API（`api` の `agent*`）

チャットの会話は、Agent ブロックが動かします（`aws-blocks/agent.ts`）。ツールの処理（`aws-blocks/agent-tools.ts`）は入力を検査し（SQL は SQL ガードも通す）、`interrupt` でブラウザに渡し、返ってきた JSON 文字列を検査して返します。

| メソッド | 内容 |
|------|------|
| `agentCreateConversationId()` | 呼び出した人のものとして会話 ID（UUID）を発行する |
| `agentGetChannel(conversationId)` | Realtime のチャンネル（名前は会話 ID）の `{ channel }` |
| `agentStream(message, conversationId, mapContext)` | ターンを始める。地図の状態を `<map_state>` として発言の後ろに付ける（`shared/mapState.ts`） |
| `agentResume(conversationId, responses)` | interrupt に答える（`{ interruptId, response }` の配列。`response` はツール結果の JSON 文字列） |
| `agentGetConversation(conversationId)`、`agentGetPendingInterrupts(conversationId)` | 履歴と、答えていない interrupt |

どれも、サインイン、利用許可の一覧、引数の検査（400）、会話の所有者の確認（404）の順に確かめます。`agentResume` は、保留中の interrupt の ID だけを受け付けます（偽の ID、重複、答え済みの ID は 409 `InterruptNotPendingException`。保存先は結果整合なので、ブラウザは短い間をあけて 1 回だけやり直してよい）。保留中の interrupt があるときの `agentStream` も 409 `InterruptsPendingException` です。上限は `shared/config.ts` の `agentConfig`、`mapConfig`、`resultConfig` です。開発サーバーは RPC の引数をそのまま標準出力に出すので、開発ログに発言やクエリ結果が残ります。

#### 保存した地図の API（`api` の `saveMap` など）

| メソッド | 内容 |
|------|------|
| `saveMap({ mapId?, title, state, conversationId?, expectedUpdatedAt? })` | `mapId` がなければ新規、あれば自分の地図の上書き。上書きは `expectedUpdatedAt`（自分が保存した、または開いた版の `updatedAt`）が必須で、新規には付けられません（どちらも 400）。`{ mapId, updatedAt }` を返す |
| `listMaps()` | 自分の地図を、新しく保存した順に（`state` なしで）返す |
| `getMap(mapId)` | 自分の地図 1 件（`state` を含む） |
| `deleteMap(mapId)` | 自分の地図を削除 |

`state` は `shared/persistedMap.ts` の `persistedMapStateSchema`（`version: 1`、表示範囲、レイヤー（id、名前、SQL、スタイル、ラベル、表示/非表示）、`nextLayerSeq`）です。地物は保存せず、復元はレイヤーの SQL を実行し直します。上限は `shared/config.ts` の `mapsConfig`（タイトル 1〜80 文字、レイヤー 20 枚、`state` の JSON 64 KiB、1 人 100 件）です。順序は、サインイン、利用許可の一覧、引数の検査（400 `InvalidMapRequestException`）、`conversationId` があればその所有者の確認、保存先の操作です。各レイヤーの SQL は SQL ガードにも通し（却下は、レイヤーの id を挙げた 400）、復元のときにブラウザがもう一度ガードします。上書きは、呼び出し側が渡した `expectedUpdatedAt` と保存済みの `updatedAt` が同じときだけ書き（`ifFieldEquals`）、削除は 1 回の条件付き削除（`ifExists`、なければ 404）なので、削除した地図が上書きで戻ることも、別の画面の新しい保存を黙って上書きすることもなく、どちらも 409 `MapConflictException` です。保存し直し（`mapId` つき）は地図全体を置き換えるので、会話を残すなら `conversationId` をもう一度渡します。100 件を超える新規保存は 409 `MapLimitReachedException`（同時の新規保存は、その数だけ超えることがあります）、保存された内容がスキーマに合わない地図の `getMap` は 500 `MapCorruptException` です。エラー名は `shared/maps.ts` にあります。テーブルは、ローカルでは開発サーバーのモックが作り、デプロイ先では最初のデプロイで作られます（サンドボックスで、保存、一覧、開く、古い版の保存の 409、削除を確かめました）。AWS では、読み取りが結果整合なので、作ったばかりの地図を読むと一度 404 になることがあります（サンドボックスの確認では、起きませんでした）。一覧は 1 人分の全件（状態を含む、最大 100 件）を読みます。

#### 管理者の一覧

管理者の一覧は、データファイルのアップロード用の署名付き URL を発行する `api.createDatasetUpload` だけを制御します。呼べるのは、利用許可の一覧にも入っている管理者だけです（利用許可がなければ `NotAllowedException`、許可されていても管理者でなければ 403 の `AdminRequiredException`）。管理者の一覧も、未設定や壊れた値は空として扱われます。

### フロントエンド

[SvelteKit](https://svelte.dev/docs/kit)（Svelte 5）と [Tailwind CSS](https://tailwindcss.com) v4 による静的 SPA です。`@sveltejs/adapter-static` が `build/` に出力し、サーバーサイドレンダリングは無効です（`src/routes/+layout.ts`）。

- `aws-blocks/index.cdk.ts` の `framework: 'spa'` が必要です。外すと、Hosting が SvelteKit を SSR として Lambda にデプロイしようとして、`adapter-static` ではビルドできません。
- `+page.server.ts`、`+server.ts`、`hooks.server.ts` はデプロイ後に動きません。サーバー側の処理は `aws-blocks/index.ts` に書きます。
- Blocks の UI 部品は DOM 要素です。`src/lib/mountNode.ts` の `mountNode` で取り付けます。

#### データエンジン（DuckDB-WASM）

`src/lib/duckdb/` がブラウザ内の DuckDB-WASM（`eh` ビルドのみ）を起動し、Parquet を必要になった時点で取得してビューにします。サインイン後に `+page.svelte` が起動し、サインアウトで破棄します。

- wasm と各 Parquet は、`api.getDatasetSources()` が返す署名付き URL から取得します（許可リストのユーザーのみ）。署名付き URL は HEAD に 403 を返すので、ファイルは丸ごと `fetch` します。
- 初期化のたびに URL を取り直します。遅延取得の前は、有効期限まで `urlConfig.refreshMarginSeconds` を切っていれば取り直し、403 なら一度だけ取り直して再試行します。
- 初期化では、空間拡張（`spatial`）を DuckDB の拡張の配布元から実行時にダウンロードします（`INSTALL spatial` / `LOAD spatial`）。
- 設定は `engineConfig`（`shared/config.ts`）。`SET lock_configuration = true` で固定します。外部読み取りの防御は SQL ガードです。
- クエリは `queryLayer(sql)`（`geom` 列を GeoJSON のレイヤーにする）と `queryTable(sql, maxRows)`（表にする）で実行します。どちらも SQL ガードを通し、一度に 1 本ずつ流し、`queryConfig.timeoutMs` でキャンセルします（止まらなければワーカーを作り直します）。結果とエラーは `ClientToolResult`（`shared/toolProtocol.ts`）で返します。

#### チャットのセッション

右のドックにチャットパネル（`src/lib/components/ChatPanel.svelte`。メッセージは `ChatMessage.svelte`、ツールの実行状況は `ToolActivity.svelte`）があります。入力は Enter で送信、Shift+Enter で改行で、IME の変換確定の Enter では送りません。データエンジンの準備中は入力を止め、起動に失敗したときはパネルに再試行つきのバナーを出し、許可リストにないアカウントでは「このアカウントはデータを利用できません」と出してチャットを使えなくします。文言と値は `shared/config.ts` の `chatConfig` にあります。会話は `src/lib/chat/chatSession.svelte.ts` が動かします。Agent ブロックの `createChat` を Realtime のトランスポートで `agent*` の API につなぎ、モデルのツール呼び出し（interrupt）をブラウザの実行器で動かして、結果をまとめて 1 回で返します。ターンが終わる（`done` かエラー）まで送信できません。「新しい会話」を押すと、実行中のターンは捨てられ、その後のツール呼び出しには `SESSION_RESET` を返します。ストアの結果整合のための 409 / 404 は、`chatConfig.retryDelaysMs` の間隔で再試行します。ページを再読み込みすると会話は引き継がれません（古い会話の保留中の interrupt はサーバーに残ります）。

#### 地図の保存と復元（ブラウザ側）

`src/lib/map/persist.svelte.ts` の `toPersisted()` が、いまの地図を `persistedMapStateSchema` に合う状態（地物なし）にして `{ ok: true, state }` で返します（レイヤーが上限を超えると `{ ok: false, reason: 'tooManyLayers' }`、スキーマに合わないと `'invalid'`。例外は投げません。ズームは保存できる範囲に丸めます）。`restoreMap(state, { queryLayer, jumpTo })` は、状態をスキーマで検査し（不正なら何もせず `report.invalid`）、地図を空にして（保存された id は先に確保します）から、保存順に 1 枚ずつ、SQL ガードを通る `queryLayer` で SQL を実行し直し、保存された id・名前・スタイル・ラベル・表示/非表示でレイヤーを戻します（表示範囲は最後に戻し、レイヤーごとの自動フィットはしません）。クエリやスタイルが失敗したレイヤーは、`status: 'error'` のエラーレイヤーとして一覧に残り（カードにメッセージを出し、地図には描かず、`<map_state>` には id・名前・`error` だけを載せます）、ほかのレイヤーは復元されます。進み具合は `restoreProgress.current`（`{ done, total }`）、結果は `RestoreReport`（`restored`、`failed`）です。復元中にもう一度復元すると、前のものは打ち切られます。`ChatSession.openConversation(conversationId)` は、保存された会話の履歴を表示して続きの会話にし、保留中の interrupt には `SESSION_RESET` を返します（見つからなければ日本語のエラーを出し、新しい会話のままです）。

#### 地図の保存・開く・新規作成（上部バー）

`src/lib/components/MapBar.svelte`。ダイアログは `SaveMapDialog.svelte`、`OpenMapDialog.svelte`、`ConfirmDialog.svelte` で、いずれもネイティブの `<dialog>` を使う `ModalDialog.svelte` の上にあり、フォーカスはダイアログ内に閉じ、Esc で閉じ、閉じるとフォーカスは元の場所へ戻ります。レイヤーが `mapsConfig.maxLayers` を超える地図は、理由を出して保存ボタンを止めます。保存中は、ボタンも Esc も止めます（二重に作らないため）。

保存されていない変更は、最後に保存した（または開いた）状態の `toPersisted()` と比べて決めます（`src/lib/map/savedMaps.ts` の `hasUnsavedChanges`）。レイヤーの追加・削除・並べ替え・名前・SQL・スタイル・ラベル・表示/非表示はどれも変更です。表示範囲は、少し動かしただけでは変更にならず、ズームが `mapsConfig.unsavedViewChange.zoomLevels`（0.5）以上変わるか、中心が保存時のズームで `centerTiles`（0.25 タイル分）以上動いたときだけ変更です。変更があるあいだは、ページを離れる前にブラウザが確認します（`beforeunload`）。メッセージは `shared/config.ts` の `mapsConfig.text` にあり、エラーはサーバーのエラー名（`shared/maps.ts`）から日本語にします。

## デプロイ

**サンドボックス（`npm run sandbox:preview`）は一度実行して確かめました（`docs/verification.md` の「サンドボックスでの確認」）。本番（`npm run deploy`）は実行していません。** 以降のコマンドは雛形で、`<…>` は運用者が自分の値に置き換えます。AWS の認証情報とリージョンは、標準の環境変数（`AWS_PROFILE`、`AWS_REGION`）で渡します。

### サンドボックス

確かめた手順です（初回のデプロイは約 2.5 分でした）。

1. サンドボックスをデプロイする（`npm run sandbox:deploy`、またはプレビューつきの `npm run sandbox:preview`。AWS の認証情報が必要）。デプロイは `aws-blocks/client.js` を AWS 用のものに書き換えます（上記「生成されるクライアント」）。ローカルの開発に戻すときは、その 1 行を戻してください（`npm run dev` を起動すると、ローカル用に書き直されますが、`.blocks-sandbox/config.json` も上書きされます）。
2. 管理者のユーザーを運用者用コマンドで作り、利用許可と管理者の両方の一覧に名前を入れる（下の「ユーザーを作る」「利用許可の一覧に入れる」）。
3. 資格情報を `.env` または環境変数の `SEED_USERNAME` / `SEED_PASSWORD` に置く。
4. `npm run data:upload -- --target sandbox`（7 つが 7 つ一致）

デプロイ先のアップロード用 URL でのアップロードは、実際に行い、拒否されませんでした。ただし、S3 の仕様や SDK の版が変わって拒否されたときは、コマンドが HTTP ステータスと S3 のエラーコードを表示して止まるので、下の本番の AWS CLI の手順に切り替えます。

`.blocks/config.json`（`stackId`）は、意図してリポジトリで追跡しています（Blocks が必要とするため。ないと別のスタックになります）。

スタック名は `.blocks/config.json` の `stackId` から決まります。本番は `<stackId>-prod`、サンドボックスは `<stackId>-<ユーザー名>-<ランダムな文字列>` です。`stackId` を変えると別のスタックになるので、変えないでください。

### ユーザーを作る

アプリにはサインアップがなく、ユーザーを作る API もありません。デプロイ先のユーザーは、運用者が自分の AWS の資格情報で、認証ブロックのテーブルに直接書き込んで作ります（サンドボックスで確かめた）。

1. テーブル名を調べます。認証ブロックのユーザーのテーブルの名前は、`<スタック名>-<スコープ名>-auth-users` です（スコープ名は `aws-blocks/scope.ts` の `new Scope('…')` の引数）。候補は、読み取りだけのコマンドで一覧できます。

   ```sh
   aws dynamodb list-tables --profile <プロファイル> --region <リージョン> \
     --query "TableNames[?contains(@, '<スコープ名>-auth-users')]"
   ```

2. まず `--dry-run` で確かめます。入力とパスワードの規則を確かめ、書き込む項目を組み立てて表示するだけで、AWS には何も送らず、AWS のクライアントも作りません（パスワードのハッシュは表示しません）。パスワードは、ターミナルでは入力が表示されない対話の入力で 2 回聞かれます。コマンドラインには渡せません（`--dry-run` 以外の引数は、引数を繰り返さずに拒否されます）。パスワードをコマンドの後ろに書かないでください。

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
- このコマンドは、`@aws-blocks/bb-auth-basic` の `signUp` が保存するレコードの形式（フィールド、符号化、bcrypt のコスト 12）とパスワードの規則を、`scripts/admin/user-record.ts` に写しています（パスワードの規則の値は `aws-blocks/password-policy.ts` の 1 か所）。ブロックのパッケージを上げたときは、この写しを確かめ直してください。
- 確認の範囲: レコードの形式は、ブロックのローカルのモックに対して、ブロック自身の `signUp` と `signIn` で単体テストしています。DynamoDB の項目そのもの（属性 `pk` と、値を 2 重に JSON 符号化した文字列の `value`）は、サンドボックスで確かめました。このコマンドで作った 2 人が、デプロイしたアプリの画面でサインインできました。

### 利用許可の一覧にユーザー名を入れる

ユーザーを作っただけでは、アプリは使えません。ユーザー名を利用許可の一覧に入れます。データをアップロードする人だけは、管理者の一覧にも入れます。名前は、作ったユーザーの名前と、大文字小文字も空白も完全に一致させます。

一覧は SSM パラメーターで、名前は `<スタック名>-<スコープ名>-allowedUsers`（利用許可）と `<スタック名>-<スコープ名>-adminUsers`（管理者）です。**先頭に `/` はつきません**（サンドボックスで確かめた）。候補は読み取りだけのコマンドで一覧できます。

```sh
# 利用許可の一覧（管理者の一覧は Values=adminUsers）
aws ssm describe-parameters --profile <プロファイル> --region <リージョン> \
  --parameter-filters "Key=Name,Option=Contains,Values=allowedUsers" \
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

- 最初のデプロイの直後は、2 つのパラメーターとも初期値の `[]` でした（この間、アプリは全員を拒否します）。書いた値は、再デプロイ（サンドボックス、コードの変更を含む `sandbox:preview` を 1 回）のあとも**残りました**（パラメーターの版も値も変わらず、人数は 2 人と 1 人のまま。サンドボックスで確かめました。本番の再デプロイと、設定ブロックに変更が入る再デプロイは確かめていません）。念のため、デプロイのあとは 2 つのパラメーターを読み直し、`[]` に戻っていたら書き直してください。
- 変更は次の呼び出しから効きます。再デプロイは要りません（アプリは呼び出しのたびにパラメーターを読みます）。
- **パラメーターは削除しないでください。** 削除すると、すべての呼び出しが、きれいな拒否ではなくサーバーエラーで失敗します。全員の利用を止めたいときは、`[]` を書きます。

### 取り消す

- 利用を止めるには、その名前を一覧から外します（上と同じ書き込み。残す名前だけの配列を書く）。サンドボックスで、外したユーザーの呼び出しがすべて 403 `NotAllowedException` になること、一覧を戻すと使えることを確かめました。
- ユーザーのレコードをテーブルから消す操作でも、次のリクエストから拒否されます（認証ブロックは、リクエストのたびにユーザーのレコードを引くため）。この操作は実行していません。コマンドは載せません。

### 本番

本番（`npm run deploy`）は実行していません。`npm run data:upload` は本番を対象にできないので、`npm run data:upload -- --dry-run` が表示する 7 行（オブジェクト名と元のパス）それぞれについて、AWS CLI で入れます（**実行していません**）。

```sh
aws s3 cp <元のパス> s3://<バケット名>/<オブジェクト名> --content-type <content type> \
  --profile <プロファイル> --region <リージョン>
```

`<content type>` は、`--dry-run` の行にある値です（Parquet は `application/vnd.apache.parquet`、wasm は `application/wasm`）。バケット名は、ブロックのソースでは、バケットの `fullId`（スタック名、`aws-blocks/scope.ts` の `Scope` の名前、`datasets` を `-` でつないだもの）が 63 文字以内ならそのまま名前になります。確認していないので、実際の名前は、デプロイしたスタックの出力か、S3 の一覧（読み取りだけの操作）で確かめてください。入れたあとの照合は、利用許可のユーザーでアプリを開いて確かめます。

### 実行していないこと

本番のデプロイ、署名付き URL の本当の期限切れ、取り直しても 403 のときの表示（`docs/verification.md` の「確認していないこと」）。

## テスト

| コマンド | 内容 |
|---------|------|
| `npm run typecheck` | `svelte-check`（フロントエンド、バックエンド、テスト） |
| `npm run test:unit` | vitest の単体テスト。`src/**`（jsdom）、`shared/**`、`aws-blocks/**`、`scripts/**` |
| `npm run test:unit:coverage` | 同、カバレッジつき |
| `npm run test:e2e` | E2E テスト。バックエンドの API を型付きクライアントで確かめる（`test/e2e.test.ts`。ブラウザは使わない） |

### E2E テスト

`npm run test:e2e` は、次の順で動きます。

1. 開発サーバーが動いていなければ、`npm run seed:users` でユーザーと一覧を投入する（冪等）。
2. 開発サーバーを `AGENT_LOCAL_MODEL=canned` で起動する。
3. 型付きクライアントで、サインアップなどの手作りの呼び出しが拒否されること（アカウントが作られず、セッションも変わらないこと）と、公開される名前空間が `api` と `authApi` だけであること、投入済みのユーザーのサインイン、サインアウトを確かめる。未サインインの呼び出しと、不許可のユーザーの呼び出しが、`api` のすべてのメソッドで拒否されること、許可のユーザーと管理者が `getAppInfo` の答えを得ることも確かめる。データセットでは、署名付きのダウンロード URL と、アップロード URL が管理者だけに出ることに加えて、アップロードの往復と `Content-Type` の拒否も確かめる（`data/dist/` は要らない）。会話の API は、`canned` のモデルで、ツール呼び出し、interrupt、再開、完了の往復と、他のユーザーの会話の 404、不正な ID と上限超えの 400 を確かめる。保存した地図の API は、保存、一覧、取得、更新、古い版での 409、他人の地図の 404、上限を確かめる。終わると、起動した開発サーバーを止める。

型付きクライアントはメソッドを列挙できないので、テスト内の `apiArguments` に `api` のメソッドごとの引数を書きます。メソッドを足して `apiArguments` に足さないと、`npm run typecheck` が失敗します。資格情報は、上の `.env`（または環境変数）から、テストとスクリプトが同じ読み込み処理で得ます。

| 状況 | 動作 |
|------|------|
| `.env` がない初回 | 投入が「資格情報が未設定」のメッセージで失敗し、サーバーは起動しない。`.env` を作って再実行する |
| 2 回目（ユーザーがいる） | 投入は「作成済み」と表示して成功し、テストが通る |
| 開発サーバーが動いていて、ユーザーがいる | 投入せずにそのまま実行し、通る（モデル種別は `bedrock` と `canned` のどちらでも通る。自分で起動したときだけ `canned` を期待する） |
| 開発サーバーが動いていて、ユーザーまたは一覧がない | サインインや `getAppInfo` のテストが、「`npm run dev:stop`、`npm run seed:users` の順に実行する」というメッセージで失敗する（コードを読んだ範囲。実行はしていない） |
| ユーザーはいるが、資格情報（`.env`）がない | 投入が未設定のメッセージで失敗する。何も消さない。サーバーが動いている場合は、サインインのテストが未設定のメッセージで失敗する |

#### E2E テストが書き換えるオブジェクト

E2E テストは、アップロードの往復を確かめるために、先頭のデータセットのファイル（`datasetFileNames` の先頭）を、ランダムなバイト列で一度置き換えます。置き換える前の内容を読んでおき、テストの最後に同じバイト列で入れ直して、ダウンロードして一致を確かめます。そのオブジェクトがもともとなかったとき（`.bb-data/` を消した直後など）は、API に削除がないので、ランダムなバイト列が残ります。テストはそのことを 1 行表示します（この「もともとなかった」場合の分岐は、実行していません）。直すには `npm run data:upload` を実行します。E2E テストを途中で止めたときも、オブジェクトにランダムなバイト列が残りえます。`npm run data:upload -- --verify-only` で確かめ、違いが表示されたら `npm run data:upload` をやり直してください。もう 1 つのテストは、`Content-Type` が違う、またはない `PUT` が拒否される（ローカルのモックでは 403）ことと、そのあとのオブジェクトが変わっていないことを確かめます。署名付き URL はテストのメッセージにも出ません。

## 検証結果

`docs/verification.md` に、実モデル（Bedrock の Claude Haiku 5.5）での検証シナリオと、AWS のサンドボックスでの確認、完了の定義との照合を記録しています。

- 検証シナリオ 13 件（2 回目）はすべて成功し、ツールの呼び出しは 0〜3 回、所要時間は 3.6〜20.9 秒でした。デプロイしたサンドボックスでも、同じ 6 つの依頼が成功しました（4.8〜19.9 秒。サインアップ不可、許可リスト、保存、Realtime の再接続も確認）。
- 1 回の依頼でモデルを 2 回呼び、入力は 1 回あたり約 2 万トークンです。各シナリオは 1 回ずつの実行で、繰り返しのばらつきは測っていません。

## データの出典と利用条件

データは、国土交通省の国土数値情報ダウンロードサイトのデータを加工して作っています。出典は次の形で表示します（アプリの左下にも、表示中のレイヤーのデータの出典を出します）。

- 国土数値情報（行政区域データ N03）（国土交通省）を加工して作成
- 国土数値情報（地価公示データ L01）（国土交通省）を加工して作成
- 国土数値情報（駅別乗降客数データ S12）（国土交通省）を加工して作成
- 国土数値情報（鉄道データ N02）（国土交通省）を加工して作成
- 国土数値情報（学校データ P29）（国土交通省）を加工して作成

採用した版と条件（調査日 2026-11-17。詳細と原文の引用は `docs/data-sources.md` の 1 と 2）:

| データ | 採用した版 | 配布ページの利用条件 |
|--------|-----------|----------------------|
| N03 行政区域 | 2026 年版 | オープンデータ（CC BY 4.0）。ただし同梱のメタデータに複製の承認の記載があり、公式の記載が食い違う（下記） |
| L01 地価公示 | 2026 年版 | オープンデータ（CC BY 4.0） |
| S12 駅別乗降客数 | 2024 年度版 | オープンデータ（CC BY 4.0）。事業者ごとに独自に算出した値で、統一的な基準ではない |
| N02 鉄道 | 2025 年度版 | オープンデータ（CC BY 4.0） |
| P29 学校 | 2023 年度版 | オープンデータ（CC BY 4.0）。版によって条件が違い、2013 年度版は非商用なので使っていない |

- **N03（行政区域）は、技術検証の範囲に限って使っています。** 配布ページは CC BY 4.0 ですが、同梱のメタデータに複製の承認についての記載があり、食い違いは解消していません。ローカルのモックと、このアプリ専用の非公開のバケットにだけ置き、ほかのバケット、公開の場所、ほかのサービスには置かないでください。一般公開、再配布、商用の用途に使う前に、国土交通省へ測量法上の扱いを問い合わせてください（`docs/data-sources.md` の 1.0、2.3）。N03 から作った `municipalities.parquet` と `prefectures.parquet` が対象です。
- P29 の配布ページには、測量法に基づく国土地理院長の承認の記載もあります。N03 より弱い記載と見て、利用可としていますが、同じ問い合わせの中で確認してよいとしています（`docs/data-sources.md` の 1.0、2.5）。
- 加工したことは、出典の書き方に含めます。加工した情報を、国が作成したかのような態様で公表してはいけません（サイトの利用規約）。
- 条件は配布元で変わりえます。利用する前に、各データの配布ページ（`docs/data-sources.md` に URL があります）の利用条件を確認してください。
- 変換に使う道具（mapshaper など）とライセンスは、`docs/data-sources.md` の 5.6 にあります。DuckDB の spatial 拡張のライセンスは確かめていません。

## 既知の制約

- **プロンプトキャッシュが使えない。** Agent ブロック（`@aws-blocks/bb-agent` 0.7.0）の公開設定では Bedrock のプロンプトキャッシュを有効にできないので、1 回の依頼で入力が約 4 万トークン（1 回約 2 万 × 2 回。ほとんどがシステムプロンプトとツールの定義）かかります（`docs/verification.md` の R112）。
- **空間拡張を実行時に取得する。** DuckDB の `spatial` 拡張は、初期化のたびに DuckDB の拡張の配布元からダウンロードします。そこに届かない環境では、データエンジンが起動しません。
- **サンドボックスの再デプロイでは、一覧は戻らなかった。** 本番の再デプロイは確かめていません。デプロイのあとは一覧を読み直してください。
- **サインアップはできない。** ユーザーは運用者がコマンドで作ります。
- **モデルは Haiku 5.5 だけ。** `jp.anthropic.claude-haiku-5-5` を `shared/config.ts` の 1 か所に指定しています。ほかのモデルでの品質は評価していません。
- **モデルの呼び出しに回数制限がない。** 利用許可の一覧に入った人は、1 ターンの上限の範囲で、何度でもモデルを呼べます。
- **サインインの試行は、ユーザー名ごとに制限している。** Auth ブロックの `lockout` を有効にしています（`shared/config.ts` の `authConfig.lockout`。連続 5 回失敗すると 15 分ロック。ブロックの既定値）。ユーザー名を知っている人は、そのユーザーを（パスワードを知らなくても）ロックできます（15 分で自動的に解けます）。IP ごとの制限はありません。この設定を AWS に反映するには、サンドボックスの再デプロイが必要です（再デプロイしたサンドボックスで確かめました: 存在しないユーザー名でも失敗は数えられ、6 回目の試行が「Too many failed sign-in attempts; try again later」になりました。存在するユーザーのロックと、ロック中の正しいパスワードの拒否は、実行していません）。
- **背景地図を外部から取得する。** 背景地図は OpenFreeMap（`shared/config.ts` の `mapConfig.basemapStyleUrl`。`https://tiles.openfreemap.org/styles/positron`）のスタイルとタイルを、利用者のブラウザが直接取得します。DuckDB の配布元に加えて、このサービスにもアクセスするので、届かない環境では背景が出ません（レイヤーは出ます）。利用条件とプライバシー（ブラウザの接続先が増えること）は、運用者が確認してください。画面の帰属表示は MapLibre が自動で出します。
- **サーバーが断った呼び出しの理由は出ない。** SQL ガードや入力の検査でサーバーが先に断った呼び出しは、ブラウザで実行しないため、ツールの実行状況には「サーバーが受け付けなかった」とだけ出ます（ストリームの `tool-result` は理由を運ばない）。理由はモデルだけが読みます。Agent の入力スキーマの検査で落ちた呼び出しも、同じ「サーバーが受け付けなかった」の行として出ます（strands がツールのコールバックの中で検査するため。`zod-tool.js:48`）。`maxToolIterations` の上限で打ち切られた呼び出しも、同じ行で出ます。どちらも、コードを読んだ範囲で、実モデルでは引き起こせていません。
- **回線が遅いと起動やデータの取得が間に合わない。** データエンジンの起動は 30 秒（`initTimeoutMs`）、データの取得は 120 秒の上限があります。約 10 Mbps より遅い回線では、34 MB の wasm と spatial 拡張の取得で、起動が毎回タイムアウトすることがあります。
- **`single` は、モデルが明示した入力では確かめていない。** 実モデルの実行で確かめた `single` は、`style` を省いたときの既定としてのものです。モデルが `style: single` を明示した入力は、単体テストだけです。
- **N03 の原典表示は未決。** N03 の出典に「測量法に基づく国土地理院長承認（複製）」の承認番号を併記するかどうかは、決めていません（アプリの表示と上の「出典」には入っていません）。N03 を公開に使う前に、国土交通省への問い合わせとあわせて決めてください。番号はここでは書きません。
- **モデルの癖。** レイヤー名に色の語を入れることがあります（プロンプトの 1 行では抑えられなかった）。広い分類（「学校の数」など）で、数えた種別を答えに書かないことがあります。`docs/verification.md` の「残る問題」を参照してください。
- **確認の範囲。** 検証は Chrome（ヘッドレス）と 1 台の Mac のみで、別のブラウザ、モバイル、同じ依頼を繰り返したときのばらつきは評価していません。

## エージェント向け

Building Blocks の文書は `node_modules/@aws-blocks/blocks/README.md` にあります。永続化にはローカルのファイルやメモリを使わず、Building Blocks を使ってください。API の呼び出しには、`import { api, authApi } from 'aws-blocks'` の型付きクライアントを使い、JSON-RPC を手で組み立てません。詳細は `AGENTS.md` を参照してください。
