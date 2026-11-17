# スパイク記録

実装に入る前に、設計の前提になっている 3 点（interrupt の往復、DuckDB-WASM、ローカルからの Bedrock 呼び出し）を小さなコードで確かめる。コードは使い捨てで、結果と判断だけをこのファイルに残す。出典は `.tmp/design.md` 10.1 節と `.tmp/tasks.md` の Task 0.3〜0.7。

スパイクのコードは Task 0.7 で削除した。この記録に出てくるスパイクのコードのパス（`src/routes/spike/…`、`scripts/spike/…`、`shared/spike-files.ts`）はもう存在しない。

## 環境

| 項目 | 値 |
|---|---|
| Node.js | v24.22.1 |
| npm | 11.19.1 |
| ネイティブ DuckDB CLI | v1.2.1 (8e52ec4395) |
| `@duckdb/duckdb-wasm` | 1.32.0 |
| `vitest` | 4.1.12 |
| Vite | 6.4.6 |
| テンプレートの E2E（`npm run test:e2e`） | 13/13 通過（改変前のテンプレート） |
| スパイク B-1 の計測環境 | Apple M2 / 24 GB、macOS 26.6.2、Chrome 157.0.8103.79（Playwright MCP）。`npm run dev`（Vite の開発サーバー）で計測。静的ビルドは動作確認のみ |
| スパイク B-2 / A の再計測の環境 | AWS サンドボックス（ap-northeast-1、プロファイル `training`）のホスト型プレビュー。手元の Mac から Chrome for Testing 149.0.7827.55（headless shell、Playwright + CDP） |
| ブラウザ内の DuckDB | `@duckdb/duckdb-wasm` 1.32.0 が載せるエンジンは v1.4.3、`eh` バンドル |
| `svelte-maplibre-gl` / `maplibre-gl` | 2.2.1 / 6.18.0 |

補足:

- `@duckdb/duckdb-wasm` は npm の `latest` タグが開発ビルド（1.33.1-dev57.0）を指していたため、最新の安定版である 1.32.0 を選んだ。
- `vitest` は 5.1.0 が `@types/node` の peer に `^22 || >=24` を要求し、プロジェクトの `@types/node@^20` と衝突する。依存を上げずに済む 4 系の最新（4.1.12）を選んだ。Vite 6 は両系とも対応している。

### AWS の認証状態（2026-11-17 時点）

- ユーザーが SSO でプロファイル `training`（アカウント <アカウント ID>、プロファイルのリージョンは ap-northeast-1）にサインインした。`aws sts get-caller-identity --profile training` が成功することを確認した（ロールは `AWSReservedSSO_AWSAdministratorAccess_*`）。
- シェルに `AWS_PROFILE` は設定されていないので、開発サーバーは `AWS_PROFILE=training npm run dev` で起動した。
- Bedrock の呼び出し可否（`AWS_PROFILE=training`、dev サーバー経由。拒否の確認はそれぞれ 1 回、短い発話で）: Claude Sonnet 4.6（`global.` プロファイル）と Claude Haiku 4.5（`global.` プロファイル）は、組織の SCP の明示的な拒否（`AccessDeniedException`、403）で呼べなかった。`jp.anthropic.claude-haiku-5-5` は呼べた。Blocks を通さない SDK の 1 回の呼び出しでは、`jp.anthropic.claude-sonnet-4-6` も呼べた。詳細は「スパイク C」。

## スパイク A: interrupt の往復

### 確かめること

- 往復 1 回の追加時間（`onInterrupt` → `sendMessage({ interruptResponses })`）。10 回測って中央値を出す
- 1 ターンにツールが複数回続く場合
- 1 回のモデル応答に複数のツール呼び出しが並ぶ場合（interrupt が配列でどう届くか、応答をどうまとめるか）
- 同じターンで同じ入力のツールが 2 回呼ばれる場合（`interruptName` の衝突）
- interrupt の保留中に再読み込みした場合（`getPendingInterrupts`、再通知）
- `canned` のモデルからツールを呼び出せるか（E2E テストの前提）
- 再開をまたいで `maxLlmCalls` と `maxToolIterations` が効くか

### 合格の目安

- 往復 1 回の追加時間が中央値 3 秒以内
- 結果が欠けずに届く

だめな場合の代替: 一方通行のコマンド + SQL エラーを次の発話に添える方式。

### 結果

実施日 2026-11-17。コードは `aws-blocks/index.ts` の `Spike A` ブロックと `src/routes/spike/agent/interrupt/+page.svelte`（どちらも Task 0.7 で削除）。実モデルの結果はすべて `jp.anthropic.claude-haiku-5-5`（`SPIKE_MODEL`）で、ローカルの開発サーバー（`AWS_PROFILE=training npm run dev`）、Chrome（Playwright）から測った。時間はブラウザ内の `performance.now()`。実モデルの呼び出しは合計で約 79 回（各ターンのモデル呼び出しを数えた概算。内訳: スモーク 2、往復計測 40、順番ツール 3、誤って実モデルで動かした canned 用シナリオ 約 3、並列 約 5、同じ入力 5、再読み込み 約 5、上限 約 6、内容照合（修正ラウンド）10）。

各項目の根拠は【実行】（動かして観察した）、【ソース】（`node_modules/@aws-blocks/bb-agent` / `@strands-agents/sdk` を読んだ）、【推定】のどれかを付けて区別する。

実装の要点（コードで確認）: ツールのハンドラーは `interrupt<string>({ name, reason })` を呼ぶだけで、その戻り値が応答。ブラウザは `onInterrupt` で受け、`chat.sendMessage({ interruptResponses: [{ interruptId, response }] })` で返す。`response` は JSON 文字列で渡す（サーバーが `String()` 化するため。ハンドラー側で `JSON.parse` する）。

| 項目 | 結果 | 備考 |
|---|---|---|
| 往復 1 回の追加時間（10 回、中央値） | 中央値の差 938 ms（interrupt 版 3,955 ms、対照 3,017 ms）。合格の目安 3 秒以内 | 下の「往復の追加時間」。範囲は重ならない（interrupt 版 3,539〜4,912、対照 2,706〜3,436） |
| 1 ターンに複数回のツール（順番に） | 動いた（実モデル 1 回）。2 つのツールを順番に呼ばせて interrupt が 2 回届き、2 回とも返して最後まで完了 | interrupt の ID は毎回違う。往復のたびに新しい購読を張り直している |
| 1 回の応答に並列のツール呼び出し | 動いた（異なる 2 ツールの指示を実モデルで 2 回試して 2 回とも 1 回の応答で 2 つ呼んだ。同じツール 2 回の指示でも 1 回）。interrupt は **1 つの `interrupt` チャンクに配列で 2 件** 届く | 下の「並列」。1 回の `sendMessage` で 2 件まとめて返すと完了。片方だけ返すと、もう片方だけが再度届く |
| 同じ入力のツールが 2 回（名前の衝突） | 衝突しない（実モデルで順番 1 回、並列 1 回）。`name` は同じだが `id` は `tool:<toolUseId>:<name>` で、呼び出しごとに違う | 下の「同じ入力」。1 回のハンドラーの中で同じ `name` を 2 回出すと衝突するはずだが、動かしていない（ソースを読んだだけ） |
| 保留中の再読み込み | 保留は残り、`loadConversation` で同じ ID の `onInterrupt` が再通知され、再読み込み後にそのまま返して完了した。保留中に新しいメッセージを送るとエラーになる | 下の「再読み込み」 |
| `canned` からのツール呼び出し | 呼べる。ハンドラーに届き、interrupt を出し、再開して完了。Bedrock を呼ばない | 下の「canned」。選択は `model.local`、環境変数で切り替えるコードを書けば設定を書き換えずに切り替えられる（確認済み） |
| `maxLlmCalls` / `maxToolIterations` | 再開をまたいで数え続ける（リセットされない）。上限を超えると `error` チャンクが届く | 下の「上限」 |
| 返した結果が欠けずに届くか（内容の照合） | 【実行】canned 30 回と Haiku 5 回で、ブラウザが返した JSON と、履歴に残ったハンドラーの戻り値が完全一致（35/35）。`tool-result` チャンクは 1 呼び出しにつきちょうど 1 個（重複なし） | 下の「内容の照合」 |
| 応答のサイズ（canned、ローカルの開発サーバーのみ） | 【実行】ASCII の英数字で 204,500 文字まで長さ・SHA-256 とも一致。204,700 文字以上は届かず、`resume` の RPC が `ItemTooLargeException`（400 KB）で拒否され、`onError` が呼ばれる（`error` / `done` チャンクは来ない） | 下の「サイズ」。デプロイ後の上限は未確認（Task 0.6 では、プローブ用ツールを削除してデプロイしたので再実行していない） |

#### 往復の追加時間

- 条件: プロンプトは固定（`getLayerInfo ツールを layer="schools" で 1 回だけ呼び、結果を報告してください。`）。毎回新しい会話。interrupt 版（`int`）と対照（`ctl`）を交互に 10 回ずつ（計 20 回）。対照は同じ名前・同じスキーマ・同じ説明のツールで、ハンドラーがサーバーで即座に `{ layer, count: 42 }` を返す。interrupt 版はブラウザが `onInterrupt` の中で即座に定数の結果を返す。20 回とも、ツールの呼び出しはちょうど 1 回、interrupt は 1 回、終了は `done` だった。【実行】「ちょうど 1 回」の判定基準は `tool-call` チャンクの数で、interrupt 版は再開で再送されるため 2、対照は 1（記録した 20 回すべてがこの値）。`interrupt` チャンクの数（1）では並列 2 呼び出しを除外できないので基準にしていない。
- 時計: 開始は「送信」を呼ぶ直前（`sendMessage` を呼ぶ直前。会話作成の RPC と購読の確立を含む）。終了は `done` チャンクの到着。どちらの版もモデルの時間が入っている。モデル呼び出しは 1 ターンにつき 2 回（ツール呼び出しの応答と、結果を受けた後の応答）のはずだが、これは数えておらず【推定】。差だけが「サーバー実行に対する client-executed のコスト」。
- 全値（ms、新しい会話ごと、実行順）:
  - interrupt 版: 4440 / 4007 / 4394 / 4912 / 3765 / 4006 / 3746 / 3728 / 3539 / 3903。中央値 3,954.5
  - 対照: 3157 / 2920 / 3398 / 3103 / 2876 / 2838 / 2706 / 2930 / 3113 / 3436。中央値 3,016.5
  - 中央値の差 938 ms（平均の差 996 ms、隣り合う 2 回ずつの差は 426〜1,809 ms）
- 実行順: 各ペアで interrupt 版が必ず先、対照が後（`bench` の固定順）。順序の効果は分けていない。
- interrupt 版の区間（ms、中央値と範囲）:
  - 送信 → `interrupt` チャンクの到着（`onInterrupt` が呼ばれた時刻）: 2,008（1,693〜2,836）。対照の送信 → `tool-call` チャンクは 2,027（1,817〜2,297）で、ほぼ同じ。大半は 1 回目のモデル呼び出し。interrupt 版の `tool-call` チャンク → `interrupt` チャンク（ハンドラーが interrupt を出して届くまで）を直接見ると、最初の 10 回は 3〜12 ms（中央値 10 ms。各回の `tToolCall` と `tInterrupt` の差を当時の出力から計算）、修正ラウンドの 5 回は 8 / 10 / 10 / 10 / 12 ms
  - 応答を送る（`sendMessage` を呼ぶ直前）→ 続きの最初のチャンク: 538（474〜714）。この最初のチャンクは、再開で再送される `tool-call` チャンクだった（ログを見た実行で確認。10 回すべてで `tool-result` は最初のチャンクの 0〜12 ms 後）。`tool-result` チャンクまでは 542（477〜716）
  - その内訳のうち、購読の確立までが 5.5（2〜8）、再開 RPC（`resume`）が 4（2〜8）。残りの約 530 は RPC 返却から `tool-result` までで、サーバー側の再開処理に当たる。内訳（セッションの復元、ハンドラーの再実行など）は切り分けていない【推定】
  - `tool-result` → 最初のテキストは、interrupt 版 1,262（1,133〜1,654）、対照 964（709〜1,110）。測ったのは「`tool-result` チャンク → 最初のテキスト」の区間で、これには再開後のサーバー側の処理が含まれる。約 300 ms の差の原因は切り分けていない
- 補足: 追加時間は上の 538 ms より大きい 938 ms になった。差のうち約 300 ms は上の `tool-result` → 最初のテキストの区間に出ている（原因は未確認）。モデルのばらつきも大きく、これは 10 回ずつの小さな標本。

#### 順番に複数回 / 並列

- 順番（実モデル 1 回）: 「getLayerInfo → 結果を見て runQuery」の指示で、`interrupt` が 2 回、`tool-call`（再送含め）4 個、最後に `done`。
- 並列（実モデル）: 「2 つのツールを同じ 1 回の応答で同時に呼べ」と指示。1 回目の試行で 2 つ呼ばれた（2 回試して 2 回とも）。`interrupt` チャンクは 1 つで `interrupts` が 2 件、`onInterrupt` も 1 回で 2 件を受ける。`getPendingInterrupts` も同じ 2 件を返す。`tool-call` チャンクは先に 2 つ届く。
  - 2 件を 1 回の `sendMessage` でまとめて返す: 再開して完了（実モデル 1 回、canned 1 回）。
  - 片方（2 つ目）だけ返す: その 1 件は実行され（`tool-result` が届く）、返していない 1 件だけが同じ ID でもう一度 `interrupt` チャンクに載る。`getPendingInterrupts` も残りの 1 件を返す。続けて残りを返すと完了（実モデル 1 回、canned 1 回）。つまり 2 回に分けて返すことはできるが、2 回目は 1 回目の再開が終わって再度 `interrupt` が届いてから。
  - 2 回の `sendMessage` を待たずに続けて呼ぶ（canned、手動で返した場合）: 1 回目は `true`、2 回目は `false` が返り、2 回目の応答は送られずに捨てられた（`loading` が `true` の間は `createChat` が弾く）。その後、残りの 1 件が再度 `interrupt` として届いた。`onInterrupt` の中で即座に返した場合は別の結果になる（下の「二重送信」）。

#### 同じ入力

- 実モデルで「同じ入力 `layer="schools"` を 2 回呼べ」を、順番（別々の応答）と並列（1 回の応答）で 1 回ずつ。`name` は両方 `client:getLayerInfo` で同じ。`id` は `tool:tooluse_…:client:getLayerInfo` の形で、`tooluse_…` が呼び出しごとに違うので衝突せず、どちらも 2 件を返して完了した。
- `id` の形は Strands の `interruptFromAgent`（`tool:${toolUseId}:${name}`）を読んで確かめた。canned は `canned-tool-N`（プロセス内の連番）。
- 衝突しうるのは、1 回のハンドラーが同じ `name` で `interrupt()` を 2 回呼ぶ場合（`id` が同じになる）。これは動かしていない（未確認）。

#### 再読み込み

- 実モデル。interrupt が出た会話の ID を使い、ページを開き直して（新しい JS コンテキスト）`chat.loadConversation(id)` を呼んだ。
  - `loadConversation` が `getPendingInterrupts` を呼び、`onInterrupt` が同じ ID で再通知された（1 回）。`getConversation` の履歴には `user` / `tool-call` / `interrupt` の行が残る。
  - そのまま `sendMessage({ interruptResponses })` で返すと再開して完了した（1 回）。
  - 別の会話で、再読み込み後に応答せず新しいメッセージを送ると、`error` チャンク `Agent is in an interrupted state. Resume by invoking with interruptResponse content blocks.` が届いた（モデル呼び出しなし）。その後、サーバー側の `getPendingInterrupts` は空配列を返した（履歴に空の `assistant` 行が書かれるため）。それでも古い ID で返すと再開して完了し（1 回）、その後の通常のメッセージも通った。つまり再開できる状態は残るが、`getPendingInterrupts` ではもう見えない。
  - 保留中でない ID で再開しようとすると、`error` チャンク `This model does not support assistant message prefill. The conversation must end with a user message.` が届いた（実モデル、1 回）。
- 再読み込みなしの接続断からの再通知は、ドキュメントに書かれた設計（`handleReconnect` が `getPendingInterrupts` を読む）を読んだだけで、動かしていない（未確認）。

#### canned

- 設定: `model: { deployed: …, local: { provider: 'canned' } }`。`local` を省略しても canned が使われ、実モデルを `local` に指定しても末尾に canned が自動で追加される（どちらもソース `agent.mock.ts` を読んだ。省略時の動作は動かしていない）。
- 確認（Bedrock を呼ばない）: プロンプトにツール名（`getLayerInfo`）を含めるとツール呼び出しが出て、ハンドラーが `interrupt()` を出し、`interrupt` チャンク → 返事 → 再開 → 固定の文（`I called the tool. Output: … [canned tool response]`）で完了した。往復は約 0.3〜0.6 秒。ツール名を 2 つ含めると 1 回の応答に並列で 2 つ出る（上の並列の canned の結果）。
- 制約（ソースと実行で確認）: 入力はスキーマの placeholder（`layer: "sample"`。プロンプトの `schools` は使われない。`cannedExamples` で変えられる）。ツールの結果を受けた後は必ず固定の文で終わるので、順番に複数回のツールは出せない。同じ入力を 2 回呼ぶこともできない。
- 切り替え: 環境変数 `SPIKE_A_MODEL=canned` で `int` の `local` を canned にするコードを書き、開発サーバーを再起動して確認した（同じプロンプトが約 0.3 秒で canned の応答になった）。ライブラリ自身が読む環境変数はない。切り替えにはアプリ側の 1 行（環境変数で `model.local` を決める）が要る。

#### 上限（`maxLlmCalls` / `maxToolIterations`）

- canned（モデル呼び出しなし）: `maxLlmCalls: 1` でツール 1 回の往復をすると、再開後の 2 回目のモデル呼び出しで止まった。`error` チャンク `Agent stopped: exceeded maxLlmCalls (1).`。再開でリセットされるなら通るので、カウントは再開をまたぐ。
- 実モデル: `maxToolIterations: 2` で、a → b → c の順に呼ばせた（実モデル 1 回）。a、b は往復できて、3 つ目の `getLayerInfo(c)` は実行されずに `tool-result` が届いたあと、`error` チャンク `Agent stopped: exceeded maxToolIterations (2).`。`maxLlmCalls: 2` で同じ指示をすると、2 つ目の往復の再開後に `Agent stopped: exceeded maxLlmCalls (2).`（実モデル 1 回）。どちらも interrupt が 2 回届いたあと。
- `error` チャンクの `errorName` は付かない。`createChat` は `onError` を 1 回呼ぶ。`done` は来ない。

#### その他の観察（実行で確認）

- 【実行】再開すると、中断前に出した `tool-call` チャンクが再送される（並列なら全部）。`tool-result` チャンクは再送されず 1 呼び出しにつき 1 個（下の「内容の照合」）。画面の「呼び出し数」を数える場合は `tool-call` の重複を除く。
- 【実行】ハンドラーは再開のたびに最初から再実行される。ハンドラーの `interrupt()` の前に実行回数のカウンターを置き（サーバー側の変数。API `handlerRuns` で読む）、canned で 1 往復（`interrupt` 1 回 → 返す → 完了）したところ、カウンターは 2 になった。
- 【実行】`tool-result` チャンクには `toolName` しか載らず、ハンドラーの戻り値は載らない。戻り値は履歴（`getConversation`）の `tool-result` 行の `metadata.toolOutput`（`[{ json: … }]`）に残る。
- 【ソース】`tool-call` / `tool-result` の発行は `agent.ts` の `BeforeToolCallEvent` / `AfterToolCallEvent` で、`resume` は応答の文字列を `approval` 行の `content` と `metadata.response` の両方に保存する（`agent.ts` の `resume`）。
- `createChat` が履歴に書く `approval` の行は、`approved` を付けないと内容が `Denied` になる。表示だけの問題【実行】。

#### 内容の照合（「結果が欠けずに届く」の測定）

- 方法: 1 回の実行ごとに、ブラウザが返した応答の文字列（`sent`）、`tool-result` チャンクの数、履歴の `tool-result` 行の数と、そこから取り出したハンドラーの戻り値（`received`）を記録する。`sent` を `JSON.parse` → `JSON.stringify` し（ハンドラーと同じ往復）、`received` と並べ替えた上で完全一致を見る。ctl は返していないので対象外。ハンドラーが `JSON.parse` に失敗すると戻り値が履歴に残らないので、`done` で終わっても一致しない。
- canned 30 回（単一ツール 15 回、並列 2 ツール 15 回、`all` で自動返信）: 30/30 一致。単一は `tool-call` 2（再送含む）/ `tool-result` 1 / 履歴の行 1、並列は `tool-call` 4 / `tool-result` 2 / 行 2。
- Haiku 5 回（上の固定プロンプト、毎回新しい会話）: 5/5 一致。すべて `tool-call` 2 / `tool-result` 1 / 履歴の行 1。送った値と受け取った値はどれも `{"layer":"schools","count":42}`。
- 照合した範囲: 返した応答がハンドラーに届いて戻り値になること、`tool-result` チャンクが重複しないこと。ブラウザが返事を返さない場合（タイムアウト）は未確認。

#### サイズ（応答の大きさ。canned のみ、ローカルの開発サーバーのみ）

- 方法: canned で `probePayload` ツール（ハンドラーが受け取った応答の長さと SHA-256 だけを返す）を呼び、ブラウザが返す応答（擬似乱数の ASCII）を 1 KB から変えた。ブラウザ側でも SHA-256 を計算して比べる。中身は記録しない（ただし開発サーバーは RPC の引数をそのまま標準出力に出すので、開発ログには中身が出る）。
- 結果: 1,024 / 32,768 / 100,000 / 150,000 / 190,000 / 200,000 / 204,000 / 204,500 文字は、長さと SHA-256 が一致して完了（各 1 回）。204,700 / 204,900 / 205,200 文字と、262,144 / 1,048,576 / 4,194,304 文字は届かなかった（各 1 回）。境界は 204,500〜204,700 文字の間。
- 失敗時の様子: `resume` の RPC が `ItemTooLargeException: Item size has exceeded the maximum allowed size of 400 KB (got 524594 bytes)`（262,144 文字のとき）で失敗する。`createChat` は `onError` を呼ぶが、`error` チャンクは来ず、`done` も来ない（ページは `loading` が戻るだけで、完了待ちはタイムアウトした）。ハンドラーには届かない。
- 原因（【ソース】と開発ログから）: `Agent.resume` が応答を `approval` 行（`content` と `metadata.response`）に保存するとき、行がローカルの DistributedTable の 400 KB 上限を超える。応答が 1 行に 2 回入るので、応答は約 200 KB（UTF-8、エスケープ後のバイト数）が上限になる。測ったのは ASCII の英数字（1 文字 1 バイト、エスケープなし）で、境界は 204,500 / 204,700 文字の間【実行】。この境界と 400 KB（409,600 バイト）の関係は計算上の一致を見ただけで、行のバイト数は測っていない。実際の応答は JSON 文字列で、`"` は保存時に `\` が付いて 2 バイトになり、日本語は UTF-8 で 1 文字 3 バイトなので、文字数での上限はこれより低い（目安 約 6.8 万〜20 万文字、内容による）【推定】。動かしていない。
- 範囲: ローカルの開発サーバーだけの結果。デプロイ後の転送上限（API Gateway、WebSocket など）は未確認（Task 0.6）。ツールの戻り値が大きい場合は `tool-result` 行の `toolOutput` も同じ種類の上限に当たりうるが、動かしていない（未確認）。

#### 二重送信（`loading` の戻り）

- 【ソース】`createChat` の `sendMessage` は `if (loading) return false` で始まる。一方、前のターンの購読を消費するループは `finally` で無条件に `setLoading(false)` を呼ぶ（`index.chat.ts`）。
- 【実行】`onInterrupt` の中で即座に返すと（README の書き方）、`loading` は再開の途中で `false` に戻る（ログを見た約 10 回の自動返信すべて）。手動で数秒後に返した場合は `true` のままだった。
- 【実行】この `loading: false` になった瞬間に（`onLoadingChange` の中から）2 回目の `sendMessage` を呼んだ（canned、各 1 回）:
  - 新しいユーザーメッセージ: 戻り値は `true`（弾かれない）。サーバーは両方を処理し、履歴には 1 回目の再開の完了（`tool-result` と `assistant` 行）の後に 2 つ目の `user` と `assistant` 行が並んだ。しかしページには 1 回目の再開の `tool-result` と本文のチャンクが届かず（`tool-result` 0 個）、画面には空の `assistant` の吹き出しが残った。
  - 同じ ID への 2 回目の `interruptResponses`: 戻り値は `true`。サーバーで 2 回目の再開が走り、canned では新しいツール呼び出しと新しい `interrupt`（別の ID）が出て、自動返信で完了した。`tool-call` は 3 個、履歴に `approval` が 3 行（`approval` 行は応答ごと、2 回目は `{"layer":"second",…}`）。参考: 実モデルで、すでに保留でない ID を後から送って再開した場合は `assistant message prefill` エラーだった（「再読み込み」）。条件が違う（実モデル・後から・保留なし / canned・再開中・同じ ID）ので、並べただけでモデル間の違いとは言えない。
- 範囲: 各 1 回の観察。タイミングは `onLoadingChange` を起点にしたので再現性はあるが、通常の画面操作（クリックなど）で同じ窓に当たるかは確かめていない。

### 判断

- 往復 1 回の追加時間: 中央値の差 938 ms で、3 秒以内。合格（`jp.anthropic.claude-haiku-5-5`、ローカルの開発サーバー、各 10 回）。デプロイ後（AgentCore Runtime + 実 WebSocket、Task 0.6）は中央値の差 1,010 ms（各 10 回、下の「デプロイ環境での再計測」）で、これも 3 秒以内。
- 結果が欠けずに届く: 合格（ローカル。応答は約 200 KB まで、ASCII で測定）。canned 30 回と Haiku 5 回で、ブラウザが返した JSON とハンドラーの戻り値が完全一致（35/35）し、`tool-result` チャンクは 1 呼び出しにつき 1 個だった。条件: 応答は約 200 KB（UTF-8、エスケープ後）以内（ASCII 英数字で 204,500 文字まで一致を確認。JSON・日本語ではこれより少ない文字数で上限に達する【推定】。超えると `resume` が `ItemTooLargeException` で失敗し、完了待ちが止まる）。デプロイ後の転送上限は未確認（Task 0.6 では再実行していない）。ブラウザが返事を返さない場合も未確認。
- 総合: 合格。一方通行のコマンドへの切り替えは不要。

設計への影響（コントローラーが決める材料。決めてはいない）:

1. 名前: `interrupt()` の `name` は固定でよい（`id` に `toolUseId` が入るので並列・連続の重複は衝突しなかった【実行】）。ブラウザ側は `name` ではなく `interruptId` で返事と対応させる。同じハンドラーの中で複数回 `interrupt()` を出すのは避ける（`id` が同じになり衝突する見込み【ソース】、動かしていない）。
2. 二重送信の防止: `onInterrupt` の中で即座に返すと、再開中の `loading` が `false` になり、`sendMessage` の入り口の `false` 返しが効かない。2 回目の `sendMessage`（新しいメッセージも、同じ ID への返事も）は弾かれず、1 回目の再開のチャンクが画面に届かなくなったり、再開が二重に走ったりした【実行、canned 各 1 回】。UI は独自の処理中状態を持ち、入力を自分でブロックする必要がある。
3. 並列の返し方: `interrupt` は 1 チャンクに配列で来る。全部を 1 回の `sendMessage({ interruptResponses })` にまとめて返す。ブラウザでの実行は並列にしてよいが、返事は全部そろってから 1 回で送る。片方だけ返すと残りだけが再度届く。
4. 結果の渡し方: `response` はサーバーで `String()` 化される。JSON 文字列で返し、ハンドラーで `JSON.parse` する。応答は `approval` 行に 2 回保存され、行の上限は 400 KB なので、応答は約 200 KB が上限（ローカルの値。デプロイ後は未確認）。ブラウザから返す結果はこれよりかなり低い上限を設ける必要があり、その値は設計（Task 0.7）で決める（決めていない）。それを超える結果は別の経路（例: ファイルとして置く）が要る。
5. 再読み込み: ページは会話 ID を保持し（URL など）、開き直したら `loadConversation(id)` を呼ぶ。`onInterrupt` が再通知されるので、保留中の呼び出しをブラウザで再実行して返す。`onInterrupt` は ID で重複を除く。
6. 再開時の挙動: ハンドラーは再開のたびに最初から再実行される【実行、カウンターで確認】。ハンドラーは `interrupt()` だけにして副作用を持たせない。
7. E2E テスト: canned でツール呼び出し → interrupt → 再開まで通る（Bedrock 不要）。ただし 1 ターンに 1 往復、入力は placeholder（`cannedExamples` で変更可）、結果の後は固定文。順番に複数回のツールを要するシナリオは実モデルが要る。
8. 上限: カウントは再開をまたぐので、1 ターンの往復の数が上限になる（既定 20）。地図の操作が多いターンは `maxLlmCalls` / `maxToolIterations` を上げる必要がある。

未決の論点（実装前に決める必要があるが、このスパイクでは決めない）:

- 保留中の interrupt を捨てる方法（cancel / abort の方針）: 保留中に新しいメッセージを送るとエラーになり、`getPendingInterrupts` から消えるが、古い ID で返せば再開できる（見えないが生きている）【実行】。破棄の手段は観察していない。
- 本物の API では `conversationId` を必須にし、`getPendingInterrupts` / `resume` で所有者を確認する必要がある（Agent BB は確認しない【ソース】。このスパイクの `resume` は `conversationId` がなければ確認を飛ばす）。
- ブラウザが返事を返さない場合（タイムアウト）の挙動: 未確認。

### デプロイ環境での再計測（Task 0.6）

実施日 2026-11-17。サンドボックスにデプロイしたバックエンドの 2 つのエージェント（`spike-a-int`、`spike-a-ctl`。どちらも `jp.anthropic.claude-haiku-5-5`）を、ホスト型プレビュー上の `/spike/agent/interrupt` から呼んだ（AgentCore Runtime + 実 WebSocket の Realtime）。手順はローカルの「往復の追加時間」と同じ: 固定プロンプト（`getLayerInfo ツールを layer="schools" で 1 回だけ呼び、結果を報告してください。`）、毎回新しい会話、interrupt 版（`int`）と対照（`ctl`）を 10 ペア、答えは `onInterrupt` 内で即座に定数で返す。実行順は各ペアで `int` が先、`ctl` が後（固定。順序の効果は分けていない）。モデル呼び出しはデプロイ済みのエージェントを通した 1 ターン 2 回の見積もりで、スモーク 1 ターン + 20 ターン = 約 42 回（呼び出し数そのものは数えていない）。

- **デプロイ済みのロールから `jp.anthropic.claude-haiku-5-5` を呼べる**。拒否（SCP など）は出なかった【実行】。
- 20 回とも `done` で終了。`int` は `tool-call` チャンク 2（再送含む）/ interrupt 1 / 内容の照合は 10/10 一致（`match: true`）。`ctl` は `tool-call` 1 / interrupt 0。

| 項目 | デプロイ後（10 ペア） | ローカル（10 ペア、参考） |
|---|---|---|
| `int` の完了時間 中央値（最小〜最大） | 5,998 ms（5,278〜6,442） | 3,955 ms（3,539〜4,912） |
| `ctl` の完了時間 中央値（最小〜最大） | 4,988 ms（4,494〜5,778） | 3,017 ms（2,706〜3,436） |
| 往復の追加時間（中央値の差） | **1,010 ms** | 938 ms |
| 隣り合う 2 回ずつの差（中央値、最小〜最大） | 1,009 ms（306〜1,266） | 426〜1,809 |
| 送信 → `interrupt` チャンク（`int`）中央値 | 4,099 ms（3,676〜4,664） | 2,008 |
| 送信 → `tool-call` チャンク（`ctl`）中央値 | 3,679 ms（3,433〜4,693） | 2,027 |
| 応答を送る → 続きの最初のチャンク（`int`）中央値 | 584 ms（492〜1,564） | 538 |
| 応答を送る → 再開 RPC の開始（`int`）中央値 | 222 ms（201〜1,240） | 約 6（購読の確立） |
| 再開 RPC（`resume`）の所要（`int`）中央値 | 251 ms（198〜426） | 4 |
| `tool-result` → 最初のテキスト 中央値 | `int` 866 ms / `ctl` 953 ms | `int` 1,262 / `ctl` 964 |
| 最初のテキストまで 中央値（送信から） | `int` 5,787 ms / `ctl` 4,738 ms | - |

- 全値（ms、実行順）: `int` 5880 / 5305 / 5278 / 6213 / 5931 / 5648 / 6065 / 6194 / 6442 / 6304。`ctl` 5246 / 4747 / 4971 / 5004 / 5049 / 4494 / 4910 / 4928 / 5778 / 5169。
- 往復の追加時間は 1,010 ms で、合格の目安（中央値 3 秒以内）に収まる。範囲は重なる（`int` 5,278〜6,442、`ctl` 4,494〜5,778）。ペアごとの差は 306〜1,266 ms。
- デプロイ後は両方とも、ローカルより約 2 秒遅い（`ctl` +1.97 秒、`int` +2.04 秒。中央値）。差の大半は、送信から最初のツール呼び出しまでの区間（+約 1.7〜2.1 秒）で、1 回目のモデル呼び出しの前に AgentCore Runtime の起動・呼び出しの時間が入っているように見える【推定。内訳は切り分けていない】。追加の往復の中身は、再開の RPC（約 250 ms。ローカルは 4 ms）と、その前の購読のやり直し（約 220 ms。ローカルは約 6 ms）が大きく増え、それ以外（再開後の最初のチャンクまで）は 584 ms でローカルの 538 ms と同程度。
- **コールドスタート**: ベンチの前に、スモークとして `int` を 1 ターン（会話の新規作成から）流した。完了は 6,463 ms で、`stream` の RPC が返るまでに約 2.6 秒かかった（ベンチ中の 20 ターンでは `stream` の RPC の所要を記録していない）。ベンチの最初のペアの `int`（5,880 ms）も、中央値（5,998 ms）の範囲内で、コールドスタートの影響は 1 回の観察では切り分けられなかった。アイドル後の最初のターンだけが遅いかどうかは未確認。
- Realtime の購読の確立: スモークの 1 回目で約 330 ms（`subscribe:start` +129 ms → `established` +455 ms）。再開のたびに購読を張り直す（ローカルでは約 6 ms で、デプロイ後は約 220〜300 ms）。
- 条件・制限: 1 台の Mac・1 回線、各 10 回。`int` / `ctl` の実行順は固定で `int` が先。Realtime の再接続（接続断からの回復）や、ブラウザが返事を返さない場合は測っていない（未確認）。
- 応答サイズの上限（ローカルで 204,500 文字まで）は、デプロイ前にプローブ用のツールを削除したので、デプロイ後は再実行していない → 未確認のまま。

## スパイク B: DuckDB-WASM

### B-1 ローカル

#### 確かめること

- 行政区域と駅を、ネイティブ DuckDB で粗く GeoParquet に変換できるか
- Vite の `?url` インポートでの初期化時間。`INSTALL spatial; LOAD spatial;` までの時間を初回と 2 回目で測る。`SELECT version()` を記録する
- `read_parquet` が GeoParquet のジオメトリ型を自動判定するか
- ローカルの開発用ファイルサーバーから全体を取得し、`registerFileBuffer` で読めるか
- 市区町村 × 駅の空間結合の時間。属性結合（`muni_code`）との差
- 全国の学校（数万点）と市区町村（約 1,900 面）を `ST_AsGeoJSON` で取り出し、MapLibre に描く時間とデータ量
- `conn.cancelSent()` でクエリを止められるか
- `SET lock_configuration = true` の後も、ビューの追加登録ができるか
- `npm run build` が通り、MapLibre の `ViteAdapter` と DuckDB の Worker が静的ビルドで動くか

#### 合格の目安

- 初期化 10 秒以内
- 市区町村 × 駅の空間結合が 10 秒以内

だめな場合の代替: 全体取得に統一し、空間結合は属性結合へ誘導する。

#### 結果

実施日 2026-11-17。コードは `scripts/spike/`、`src/routes/spike/duckdb/`、`aws-blocks/index.ts` の `SPIKE` ブロック（すべて Task 0.7 で削除）。時間はすべてブラウザ内の `performance.now()` で、各 3 回測った（括弧内が全値、ms）。

| 項目 | 結果 | 備考 |
|---|---|---|
| GeoParquet への変換 | 成功。市区町村 1,898 行 / 1.64 MB、駅 10,534 行 / 260 KB、学校 56,807 行 / 1.88 MB（zstd、行グループ 2,048 行） | 市区町村は先に 0.001 度で簡素化 → `muni_code` で統合 → 面積 1e-5 度²未満の島を除去 → 0.002 度で再簡素化。詳細は下の「変換の記録」 |
| 初期化〜spatial 読み込み（初回） | 中央値 3,147 ms（2,591 / 3,147 / 5,405） | 新規ブラウザコンテキスト 3 つで測定。内訳は wasm の instantiate が 991〜3,255、`INSTALL`+`LOAD spatial` が 1,600〜2,150。Vite の開発サーバー経由 |
| 初期化〜spatial 読み込み（2 回目） | 中央値 2,369 ms（2,485 / 2,369 / 2,292） | 同じコンテキストでの再読み込み。同一ページで terminate → 再初期化を 3 回繰り返すと 1,917 ms（1,917 / 1,860 / 1,928）。`INSTALL`+`LOAD spatial` は約 1.0〜1.3 秒（両者を合わせて計っており、内訳と拡張のキャッシュの効果は確かめていない） |
| `SELECT version()` | `v1.4.3` | `getVersion()` も `v1.4.3`。`eh` バンドルが選ばれた（`mvp` ではない） |
| ジオメトリ型の自動判定 | 判定する。`read_parquet` の結果列が `GEOMETRY` 型 | 4 ファイルとも `DESCRIBE` で `geom:GEOMETRY`。ネイティブ DuckDB 1.2.1 が書いた GeoParquet 1.1.0 の `geo` メタデータ（キーは 1 つ）を読んで判定した。`ST_Within` や `ST_AsGeoJSON` が型変換なしで使えた |
| `registerFileBuffer` での読み取り | 成功。4 ファイルとも `CREATE VIEW ... read_parquet(...)` で全行を読めた | ローカルの `FileBucket`（`npm run dev`）の署名付き URL を `fetch` した。取得はファイルあたり 5〜26 ms、登録は 0〜2 ms（この登録時間には `slice()` での複製を含む）。`registerFileBuffer` は渡した `ArrayBuffer` を転送（detach）するため、再登録用に控えを残すなら複製を渡す必要がある |
| 空間結合の時間 | 中央値 106 ms（169 / 106 / 102）。10,534 駅 × 1,898 面の `ST_Within`、結果 10,506 行 | 市区町村別の件数集計を付けると中央値 120 ms（133 / 117 / 120）、結果 1,425 件 |
| 属性結合の時間 | 中央値 11 ms（24 / 5 / 11）。結果 10,515 行 | 集計付きは中央値 5 ms（5 / 4 / 7）。空間結合との差は約 10〜24 倍だが、絶対値はどちらも小さい。結果行数の差（10,506 と 10,515）の中身は次のとおり（ネイティブ DuckDB で `data/spike/*.parquet` から再計算）。空間結合の 10,506 組は、異なる駅 10,481 件 + 2 つの面に当たった駅 25 件の重複 25 組。組の内訳は、`muni_code` と一致 10,428、`muni_code` が NULL の駅が面に入った 8、`muni_code` と空間結合の結果が食い違う 70。さらに、`muni_code` があるのにどの簡素化後の面にも入らない駅が 42 件、`muni_code` が NULL でどの面にも入らない駅が 11 件ある。差がちょうど 9 件なのは、これらが相殺した偶然で、2 つの結合は同じ結果ではない。市区町村を個別に簡素化したため、隣り合う面が重なったり隙間ができたりすることが主な要因とみられる（内訳は未確認）。面積の小さな島を `MIN_AREA` で除去してから再簡素化しているため、面に入らない 42 件の一部は除去された島の上にある可能性もあり、第 2 の候補要因として挙げる |
| `ST_AsGeoJSON` と MapLibre 描画（時間 / データ量） | 下の別表 | 市区町村 1,898 面（1.64 MB の parquet）は GeoJSON で約 4.5M 文字。学校 56,807 点は約 9.3M 文字（`JSON.stringify` の文字数。日本語を含むため UTF-8 のバイト数はこれより大きい） |
| `conn.cancelSent()` | `send()` で投げたクエリは止まるが、反応が遅い。`query()` のクエリは止まらない | 下の「キャンセル」。キャンセル後の接続は使える |
| `lock_configuration` 後のビュー登録 | できる | 下の「`lock_configuration`」。設定の変更（`SET`）は全部拒否される。`LOAD` は通る |
| `npm run build` と静的ビルドでの動作 | `npm run build` は成功。Worker の起動、`SELECT version()`、`LOAD spatial`、MapLibre の描画を確認 | 下の「静的ビルド」。`svelte-maplibre-gl` 2.2.1 には `ViteAdapter` クラスがなく、`import 'svelte-maplibre-gl/vite'`（副作用 import）が相当する。開発サーバーでは `vite.config.ts` に `optimizeDeps.exclude` が必要 |

##### ジオメトリを GeoJSON にして MapLibre に描く

全国の学校 56,807 点と市区町村 1,898 面。空のスタイル（タイルを取らない）で描き、データを設定してから MapLibre の `idle` イベントまでを計った。市区町村は粗い版（面積 1e-4 度²未満の島を除去、0.01 度で簡素化、32,689 頂点）も参考に測った。

| 項目 | 中央値 | 全値 | データ量 |
|---|---|---|---|
| 市区町村 1,898 面（146,340 頂点）の `ST_AsGeoJSON` クエリ | 68 ms | 103 / 60 / 68 | GeoJSON 4,510,639 文字 |
| 同、JS で `FeatureCollection` にする | 29 ms | 39 / 29 / 26 | |
| 同、MapLibre 描画（設定 → `idle`） | 1,315 ms | 1,349 / 1,315 / 1,024 | 1 回目の計測では 935 ms（1,002 / 885 / 935） |
| 粗い市区町村 1,898 面（32,689 頂点）のクエリ | 34 ms | 1,074 / 34 / 30 | GeoJSON 1,195,475 文字 |
| 同、MapLibre 描画 | 316 ms | 351 / 316 / 268 | |
| 学校 56,807 点の `ST_AsGeoJSON` クエリ | 124 ms | 115 / 124 / 665 | GeoJSON 9,305,292 文字 |
| 同、JS で `FeatureCollection` にする | 395 ms | 395 / 345 / 466 | |
| 同、MapLibre 描画 | 2,102 ms | 2,520 / 2,102 / 1,852 | 1 回目の計測では 1,535 ms（1,585 / 1,351 / 1,535） |
| 市区町村 + 学校を同時に描画 | 2,401 ms | 2,804 / 2,401 / 2,320 | 1 回目の計測では 1,986 ms（1,952 / 1,986 / 2,318） |

- 描画された地物数は `queryRenderedFeatures` で確認した（面 1,862、点 55,713。画面外や重なりで元の件数とは一致しない）。
- 学校の点は、行の数に比例して JS の変換（`JSON.parse` と配列作り）が支配的になる。クエリ側は 100 ms 台だった。
- 測定は他の作業（開発サーバーの稼働など）と同じマシンで行った。同じ操作でも 1 回目と 2 回目の計測で 3〜5 割ぶれた。目安として読むこと。

##### キャンセル（`conn.cancelSent()`）

遅いクエリは `SELECT count(*) FROM schools s, municipalities m WHERE ST_Distance(s.geom, m.geom) < 0.00001`（約 1.08 億組の距離計算）。キャンセルなしで完走すると 71,652 ms かかった。

| 操作 | 結果 |
|---|---|
| `conn.send(sql)` で開始、1 秒後に `cancelSent()` | `cancelSent()` は `true`。`send()` の Promise は `query was canceled` で reject された。`cancelSent()` が返るまで 16,150 / 12,615 / 16,954 / 13,183 ms（4 回、中央値 14,667 ms）、クエリ開始からの reject は 17,164 / 13,620 / 17,957 / 14,188 ms |
| キャンセル後の接続 | そのまま使える。`SELECT 42` が 5〜40 ms で返った（4 回とも） |
| `conn.query(sql)` で開始、1 秒後に `cancelSent()` | 止まらない。`cancelSent()` は 20 秒待っても返らず、元のクエリは 62,417 ms で完走（resolve）した。完走後は接続を使えた |
| フォールバック: `worker.terminate()` + 再初期化 | `terminate()` は 0.0〜0.1 ms。再初期化（wasm の instantiate + `INSTALL`/`LOAD spatial`）は中央値 1,400 ms（1,645 / 1,351 / 1,400）。取得済みバッファの再登録 + 4 ビュー作成は中央値 171 ms（154 / 189 / 171）。再初期化後に学校 56,807 行を読めた |

- 遅いクエリを止める即効性のある手段は `worker.terminate()` で、再開まで約 1.6 秒（再初期化 + 再登録）。
- `cancelSent()` は効くが、止まるまで 12〜18 秒かかった（遅いクエリの長さ 71 秒に対して 2 割弱）。ワーカーが同期的に処理を進める間、キャンセル要求を処理できないとみられる。今回試した遅いクエリは 1 種類だけで、別の形のクエリでは反応が変わる可能性がある。

##### `lock_configuration`

ブラウザ内の新規インスタンスで実行した。事前に `read_parquet` のビュー（`v_pre`）を作り、`SET lock_configuration = true` の後に別のバッファ（`post.parquet`）を `registerFileBuffer` して試した。

| 操作（lock の後） | 結果 |
|---|---|
| `registerFileBuffer('post.parquet', ...)`（JS API） | 成功 |
| `CREATE VIEW v_post AS SELECT * FROM read_parquet('post.parquet')`、`SELECT count(*) FROM v_post` | 成功（56,807）。既存の `v_pre` も読める |
| `CREATE OR REPLACE VIEW`、`CREATE TABLE`、`ST_AsGeoJSON` を使うクエリ | 成功 |
| `LOAD spatial`（ロード済み）、`LOAD json`、`INSTALL httpfs` | 成功。lock は拡張の読み込みを止めない |
| `SET threads`、`SET memory_limit`、`SET enable_external_access`、`SET lock_configuration = false` | すべて失敗。`Cannot change configuration option "..." - the configuration has been locked` |
| `COPY (SELECT 1) TO 'out.csv'` | 成功（ブラウザ内の仮想ファイルへの書き込み） |
| `read_csv('https://example.com/')` | DuckDB の権限エラーではなく、ブラウザの `XMLHttpRequest` が失敗した（接続先の CORS が理由）。lock は外部 URL への読み取りを止めない |

`SET enable_external_access = false` を lock の前に入れた場合:

| 操作 | 結果 |
|---|---|
| `CREATE VIEW ... read_parquet('post.parquet')`（登録済みバッファ） | 失敗。`Permission Error: Cannot access file "post.parquet" - file system operations are disabled by configuration` |
| 事前に作った `v_pre` の読み取り | 失敗（同じ権限エラー）。登録済みバッファは全く読めなくなる |
| `LOAD json`、`COPY ... TO`、`read_csv('https://...')` | 失敗（権限エラー）。`LOAD spatial`（ロード済み）と `CREATE TABLE` は成功 |

`SET disabled_filesystems = 'HTTPFileSystem'` を lock の前に入れた場合は、ビュー登録・読み取りは成功し、`read_csv('https://example.com/')` は上と同じ `XMLHttpRequest` の失敗になった。この設定が HTTP を止めたとは確認できなかった（失敗の原因は CORS のため判別できない）。

- 結論: lock だけなら、後から登録したファイルバッファの `CREATE VIEW` はできる。設定は変えられなくなる。
- `enable_external_access = false` を単独で併用するのは使えない（登録済みバッファが読めなくなる）。これと `allowed_paths` / `allowed_directories`（登録したバッファの名前を許可）を組み合わせる案と、`disabled_filesystems` の効果は**未確認**。`allowed_paths` / `allowed_directories` の設定名の文字列が `duckdb-eh.wasm`（v1.4.3）のバイナリに含まれることは、`grep -a -c` で確かめた（`allowed_paths` 2 件、`allowed_directories` 2 件）。ブラウザ内で `duckdb_settings()` を引いたわけではないので、このビルドで設定として使えるか、登録済みバッファに対してどう働くかは未確認。`disabled_filesystems` は、上の表のとおり `SET` を実際に実行できたので存在する。Task 2.2 で確かめる。
- lock の前に、`threads` や `memory_limit` など必要な設定をすべて済ませておく。

##### 静的ビルド

- `npm run build`（`blocks-generate-client`、`typecheck`、`vite build`、`adapter-static`）が成功した。`build/` に DuckDB の wasm（`duckdb-eh` 約 34 MB、`duckdb-mvp` 約 39 MB）とワーカー、MapLibre のワーカーが出力された。
- 配信は、`build/` を配信し、存在しないパスは `index.html` を返す Node 製の最小のサーバー（検証用、リポジトリには置かない）を `127.0.0.1:4173` で起動した。`vite preview` や AWS は使っていない。
- `/spike/duckdb/static`（バックエンドに依存せず SQL で生成したデータだけを使うページ）を新規ブラウザコンテキストで開き、次を確認した: DuckDB の Worker が起動（`eh` バンドル、2,552 ms）、`SELECT version()` が `v1.4.3`、`LOAD spatial` が成功（`ST_AsText(ST_Point(1,2))` が `POINT (1 2)`）、`ST_AsGeoJSON` で作った面 1 件と点 2,400 件を MapLibre が `canvas` に描いた（スクリーンショットで確認）。コンソールエラーなし。配信ログに DuckDB の `.wasm` と Worker、MapLibre の Worker への取得が出ていた。

##### 変換の記録

`scripts/spike/convert.sh`（`01_union.sql`、`02_export.sql`）。出力は `data/spike/`（git 管理外）。ネイティブ DuckDB 1.2.1 + spatial で、`GEOMETRY` 列を `COPY ... TO parquet` すると GeoParquet 1.1.0 の `geo` メタデータが自動で付く（`KV_METADATA` の手書きは不要）。

- 市区町村（N03、125,130 ポリゴン、15,722,602 頂点）:
  1. `N03_007 NOT LIKE '%000'` で所属未定地を除外（1,905 → 1,898 コード）。
  2. 各ポリゴンを `ST_SimplifyPreserveTopology(geom, 0.001)`（約 100 m）で簡素化（124,989 ポリゴン、766,505 頂点、27 秒）。
  3. `N03_007` ごとに `ST_Union_Agg`（445 秒、1,898 行、702,541 頂点、島の分離したパート 103,926）。
  4. 統合結果を `ST_Dump` で分解し、面積が `MIN_AREA` 未満のパートを捨て（市区町村ごとの最大パートは残す）、残りを `ST_SimplifyPreserveTopology(geom, TOLERANCE)` して `ST_Collect` + `ST_Multi` で戻す。
  - 採用値: `MIN_AREA = 1e-5` 度²（約 0.1 km²）、`TOLERANCE = 0.002` 度（約 200 m）→ パート 2,773、146,340 頂点、1.64 MB（1 行グループ）。`ST_IsValid` が偽の行が 10 件ある（簡素化の結果。修復していない）。
  - 粗い版: `MIN_AREA = 1e-4`、`TOLERANCE = 0.01` → パート 2,250、32,689 頂点、420 KB。
  - 先に統合してから簡素化する順は、ネイティブで約 20 分走らせても終わらず取りやめた（`work.duckdb` に段階 1 の結果を残す方式に変更）。簡素化後の頂点数は、0.002 / 0.005 / 0.01 度でも、島を捨てない限り 55 万〜45 万頂点のままだった（島が頂点の大半を占める）。
  - 注: 段階 1（簡素化と統合）は、`01_union.sql` と同じ SQL を単発のスクリプトで実行した結果を `work.duckdb` に取り込んでおり、`01_union.sql` 自体は通しで再実行していない。
- 駅（S12、10,534 行）: `ST_Centroid` で点にし、`muni_code` は N03 の統合結果（段階 3 の面）との空間結合で 1 回だけ付けた。境界ボックスの範囲結合で候補を絞ってから `ST_Within`。重なりで複数の面に当たった 11 件は 1 件に絞った。`passengers_per_day` は `S12_058 = 1 AND S12_059 = 1` のときだけ（7,770 行）。`muni_code` が NULL の駅は 19 件（面に入らない沿岸・島）。6 行グループ。
  - 参考値: 同じ種類の結合を境界ボックスの絞り込みなしでネイティブ 1.2.1 で実行したら 390 秒かかった（空間インデックスなし）。ブラウザ内の 0.1 秒とは、エンジンの版（1.2.1 と 1.4.3）も、結合した面（統合結果の 702,541 頂点と、簡素化後の 146,340 頂点）も違うので、速度の比較にはならない。変換時は絞り込み版を使った。
- 学校（P29、56,807 行）: 点のまま。`muni_code` は `P29_001` で、N03 にないコード（浜松市の旧区）が 411 件ある。28 行グループ。
- 行グループは 2,048 行、圧縮は zstd。市区町村は 1,898 行なので 1 行グループにしかならない。

#### 判断

**合格（ローカル配信の条件下）。** 初期化は初回の中央値 3.1 秒（最大 5.4 秒）、2 回目は 2.4 秒で、目安の 10 秒以内に収まる。ただしこの値は、約 34 MB の `duckdb-eh.wasm` を localhost から配信して測ったもので、wasm の実際の回線転送（圧縮を含む）は含まない。プレビュー上での初回初期化は B-2 で測った（プレビュー上、wasm はバケットの署名付き URL から・圧縮なし。中央値 2,575 ms。アプリのオリジンからの配信ではなく、CloudFront からの配信は未確認）。外部の拡張配信（`INSTALL spatial`）への依存は未測定。市区町村 × 駅の空間結合は中央値 106 ms で、目安の 10 秒に大きく余裕がある。「だめな場合の代替」（全体取得に統一、空間結合は属性結合へ誘導）に切り替える必要はない。

後続のタスクへの影響:

- **データの大きさ（Task 1.3、1.4）**: 市区町村は、小さな島の除去（約 0.1 km²未満）と 0.002 度の簡素化で 1.6 MB の parquet、GeoJSON で約 4.5M 文字に収まった。描画は約 1〜1.3 秒。簡素化だけでは頂点が減らない（島が多い）ので、島の除去が必須。全国の学校 56,807 点は GeoJSON で約 9.3M 文字、描画に約 1.5〜2.5 秒かかる。設計の上限（100,000 地物、GeoJSON の合計サイズ）は、点 5.7 万・約 9.3M 文字が通るので維持できる。面約 4.5M 文字と点約 9.3M 文字（合計約 14M 文字）を同時に描いても約 2〜2.8 秒だった（これより大きい合計サイズは未測定）。ここでの大きさは `JSON.stringify` の文字数（UTF-16 の単位数）で、日本語の属性を含むため UTF-8 のバイト数はこれより大きい。表示を軽くしたければ、粗い版（約 1.2M 文字、描画 0.3 秒）を選べる。
- **データ取得（Task 1.3）**: ローカルの全体取得 + `registerFileBuffer` は問題なく動いた。`registerFileBuffer` は渡したバッファを転送するので、再登録（`terminate` 後の復旧）用には複製を渡すこと。
- **結合の誘導**: 空間結合も 0.1 秒で通るため、属性結合への誘導は性能上は不要。属性結合は 10 倍以上速いが、絶対値の差は 0.1 秒程度。一方、正しさの面では結果が違う。個別に簡素化した面での空間結合は、約 1% の駅（`muni_code` との食い違い 70 組 + 面に入らない 42 件 + 重複 25 件）で属性結合と食い違い、重複も生む。このため (a) Task 1.3 では、境界を共有する簡素化（トポロジーを保つ簡素化）が要る。市区町村ごとの `ST_SimplifyPreserveTopology` は 1 つの図形の内側でしかトポロジーを保たないので、これでは足りない。隣り合う面が共有する境界を一緒に簡素化する方式が必要。できなければ未解決として記録すること。(b) 属性結合に誘導する理由は、性能ではなく正しさにもある。ただし `muni_code` が NULL の駅（19 件）や、N03 にない学校のコード（411 件）では属性結合が欠ける。
- **クエリのキャンセル（Task 2.2）**: `cancelSent()` は `send()` で開始したクエリにだけ効き、止まるまで 12〜18 秒かかった（遅いクエリ 1 種類だけでの測定で、別の形のクエリでは変わる可能性がある）。`query()` のクエリには効かない。30 秒のタイムアウトで確実に止めるには、`send()` 経由で `cancelSent()` を呼んだうえで、一定時間内に返らなければ `worker.terminate()` + 再初期化 + 再登録（約 1.6 秒）にフォールバックする方式がよい。結果の GeoJSON が大きいときは JS 側の変換（約 0.4 秒）も同じスレッドで走る点に注意。
- **`lock_configuration`（Task 2.2）**: 使える。`SET lock_configuration = true` の後でも、`registerFileBuffer` + `CREATE VIEW` ができる。ただし `threads` や `memory_limit` など他の設定は lock の前に済ませる。`enable_external_access = false` の単独の併用は、登録済みバッファが読めなくなるので使えない（`allowed_paths` / `allowed_directories`、`disabled_filesystems` との組み合わせは未確認で、Task 2.2 で確かめる）。lock は `LOAD`、`INSTALL`、外部 URL の読み取り、`COPY TO` を止めない。ユーザーが書く SQL の防御は lock だけに頼れず、SQL 側の検証（許可する文の種類の制限）も要る。
- **静的ビルドの設定**: `vite.config.ts` に `optimizeDeps: { exclude: ['svelte-maplibre-gl'] }` を足した（開発サーバーで `svelte-maplibre-gl/vite` が esbuild の事前バンドルに失敗するため）。`ViteAdapter` は、導入済みのパッケージ（2.2.1。`npm view svelte-maplibre-gl version` でも 2.2.1）に存在しない。動く代替は、副作用 import の `svelte-maplibre-gl/vite`（`exports["./vite"]`。`setWorkerUrl(...?worker&url)` を呼ぶ）。この `optimizeDeps.exclude` は、実アプリが開発サーバーでこの import を使う限り本番用の設定にも必要なので、残す前提とし、Task 0.7 で確認する。開発サーバーのエラーは 1 回だけ観測し、ログは残していない。見たメッセージは `✘ [ERROR] Cannot read file: .../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url`（`node_modules/svelte-maplibre-gl/dist/vite.js:2:22`）。

制限: 計測は 1 台のマシン、Chrome 1 種、開発サーバー経由（`INSTALL spatial` は拡張リポジトリから取得）。S3 の署名付き URL と Range 読み取りは B-2 で確かめる。

### B-2 S3（署名付き URL での Range 読み取り）

#### 確かめること

- `FileBucket`（CORS 設定つき）を含むバックエンドをサンドボックスにデプロイできるか
- 署名付き URL に `Range: bytes=0-0` を送って 206 が返るか
- `registerFileURL` と `reliableHeadRequests: false` で、ブラウザから Range 読み取りができるか。CORS のプリフライトの有無、リクエスト数、転送量、クエリ時間
- 行グループの大きさと並び順を変えて、絞り込みクエリの転送量が減るか
- バックエンドが `aws-blocks/` の外にある `shared/` を取り込んでデプロイできるか
- 以降の作業でサンドボックスを残すか、いったん破棄するか（ユーザーに確認）

#### 合格の目安

`.tmp/design.md` と `.tmp/tasks.md` に数値の目安はない。完了条件は、Range 読み取りの成否と計測値、`shared/` の置き場所の判定が記録されていること。

だめな場合の代替: 全体取得に統一する。

#### 条件と手順

実施日 2026-11-17。コードは `aws-blocks/index.ts` の `SPIKE` ブロック、`shared/spike-files.ts`、`src/routes/spike/duckdb/range/`、`src/routes/spike/duckdb/net-probe.ts`、`scripts/spike/variants.sh`（すべて Task 0.7 で削除）。

- **環境**: AWS サンドボックス（`AWS_PROFILE=training`、ap-northeast-1）に `npm run sandbox:preview` でデプロイしたバックエンドとホスト型プレビュー。プレビューの前面は API Gateway HTTP API で、フロントは SvelteKit の静的ビルド（`framework: 'spa'`）。計測はプレビューの URL を、手元の Mac から Chrome for Testing 149.0.7827.55（headless shell。Playwright から操作）で開いて行った。ネットワークの記録は CDP（`Network.requestWillBeSent` などを、ページと Worker の両方に自動アタッチして取得。プリフライトの OPTIONS も見える）と、ページ側の Worker 内 XHR の記録（`net-probe.ts`）の 2 系統。
- **デプロイ**: 最初のデプロイは 118.72 秒（合計 123.25 秒）。`AssetExceedsProxyLimit` の警告が 2 件。その後、ページのコード（`src/routes/spike/**`）だけを変えて `npm run sandbox:preview` を 3 回再実行した（各 約 64〜65 秒）。再実行でプレビューの URL は変わらなかった。バックエンド（`aws-blocks/index.ts`、`index.cdk.ts`、`shared/`）は、最初のデプロイと同一の内容のまま。
- **バケット**: `FileBucket('spike-data')`、CORS は GET / HEAD、許可オリジン `*`（プレビューの URL はデプロイ前に分からず、synth 時に参照するとバケットと API が循環する見込みのため）、許可ヘッダー `Range`、公開ヘッダー `Content-Range` / `Content-Length` / `Accept-Ranges` / `ETag`、`maxAge` 3000。署名付き URL の有効期間は 3600 秒。ファイルは AWS CLI で置いた（検証データ 13 本と `duckdb-eh.wasm`）。
- **ユーザー**: 乱数のユーザー名でプレビュー上でサインアップしてから、そのユーザー名だけを許可リスト（SSM パラメーター）に入れた。サインアップ前の許可リストは空（`[]`）。
- **データ**: Task 0.5 の 4 ファイル（市区町村、粗い市区町村、駅、学校）と、`schools.parquet` から作った行グループ違いの 9 本（行グループ 2,048 / 8,192 / 16,384 行 × 並び順なし / `muni_code` 順 / 重心のヒルベルト順。`bbox_xmin` などの列を追加。作り方は `scripts/spike/variants.sh`）。
- **クエリ**（`range/queries.ts`）: 全件数、全件スキャン（図形列の長さの合計。参照）、1 都道府県（東京都。`muni_code` の範囲、市区町村は `pref_name`）、境界ボックス（東京付近、`bbox_*` 列）。いずれも `octet_length(geom)` を集計して図形列まで読ませる。各クエリを 3 回、毎回新しい署名付き URL と新しい仮想ファイル名で登録して測った。署名付き URL は `X-Amz-Date` が秒単位なので、同じ秒に 2 回作ると同じ URL になり HTTP キャッシュに当たる。このため署名は 1.1 秒以上あけ、さらに CDP でブラウザのキャッシュを無効にした。DuckDB の読み取りキャッシュは、既定で無効にした回と、残した回の両方を測った。

#### 結果

| 項目 | 結果 | 備考 |
|---|---|---|
| サンドボックスへのデプロイ | 成功（118.72 秒。警告は 2 件で、どちらも `AssetExceedsProxyLimit`） | 警告の内容は下の「配信の上限」 |
| デプロイ済みバックエンドのガード | 未サインインは 401、サインイン済みで許可リスト前は 403（`spikeApi.listNames`、`downloadUrl`、`spikeAApi.createConversationId` の 3 つで確認）、許可リストに入れた後は通る。固定リスト外のファイル名は 400 | 【実行】。`api`（Todo）は許可リスト前でも通る（`listTodos` が `[]`）。テンプレートのままで、変更していない |
| `shared/` の取り込み | 取り込める。デプロイ済みの `spikeApi.listNames` が固定リストの 14 件を返し、`downloadUrl` の名前検査も `shared/spike-files.ts` の内容で働いた | 下の「判定」 |
| 署名付き URL への `Range: bytes=0-0`（GET） | 206、`Content-Range: bytes 0-0/3452738`、`Accept-Ranges: bytes`、`Content-Length: 1`。curl とブラウザ（CORS 経由、`Content-Range` と `Accept-Ranges` を JS から読めた）の両方で同じ | 【実行】`schools_rg2048_attr.parquet` と `stations.parquet` |
| 署名付き URL への HEAD | **403 Forbidden**（curl、ブラウザとも。`Range` の有無によらず）。ブラウザでも CORS ヘッダーが付くので、ステータスは JS から読める | 【実行】署名付き URL は GET 用で、HEAD は署名が合わない |
| DuckDB-WASM の挙動（署名付き URL。置き換えなし） | **Range 読み取りは一度も行われなかった**。サイズを知るための HEAD が 403 になり、`allowFullHTTPReads` が無効なら open が失敗、有効なら全体を 1 回 GET して読む。原因は 2 つが重なっている: (1) 署名付き GET URL の HEAD が 403、(2) 1.32 の `openFile` が `GET Range: bytes=0-0` の応答の `Content-Range` を読まず（`Content-Length` を `/` で分割している）、そこからサイズを取れない | 下の「DuckDB-WASM の挙動」の表と「原因の読み取り」 |
| CORS プリフライト | Chrome は単一範囲の `Range`（`bytes=a-b`、`bytes=a-`）に対してプリフライトを送らなかった。DuckDB-WASM の全セッション（署名付き URL 約 430 リクエスト、ローカルサーバー約 1,900 リクエスト）で OPTIONS は 0 件 | 下の「CORS プリフライト」 |
| クエリごとのリクエスト数・転送量・時間（署名付き URL） | どのクエリ・どのファイルでも、ファイル全体を 1 回ダウンロード（転送量 ≒ ファイルサイズ）。時間 中央値 約 250〜260 ms（約 4.4 MB のファイルで）。行グループの大きさ・並び順で転送量は変わらない | 下の「署名付き URL での計測」 |
| 行グループの大きさ・並び順と転送量 | 署名付き URL（置き換えなし）では効果なし（全体読み込み）。HEAD と Range に対応した別のサーバー（比較用、ローカル）では、並び順で 1 都道府県の転送量が大きく減った（行グループ 2,048 行: 2,295 KB → 311 KB）。Worker 内の置き換え（経路 (a)）を入れると、S3 の署名付き URL でも同じ転送量で Range 読み取りができた（時間は全体ダウンロードより長い） | 下の「行グループ違いの比較（比較用サーバー）」と「経路 (a)」。比較用サーバーの値は S3 での値ではない |
| DuckDB-WASM の初回読み込み（プレビューのオリジン、wasm はバケットから） | 初回 中央値 2,575 ms（2,665 / 2,513 / 2,624 / 2,526）、同じ URL での再初期化 中央値 1,562 ms。wasm は毎回約 34 MB をダウンロード | 下の「初回読み込み」 |
| 静的アセットの配信上限 | プレビューの前面は 34 MB の `duckdb-eh.wasm` を返せない（HTTP 500。Lambda のログでは `Runtime.OutOfMemory`） | 下の「配信の上限」 |
| 経路 (a): Worker 内で HEAD を `GET Range: bytes=0-0` に置き換える | **動いた**。`allowFullHTTPReads: false` でも open が成功し、Range 読み取りになった。リクエスト数・転送量は比較用サーバーと同一。結果は全体読み込みと全 36 セルで一致。ただし東京都の絞り込みの時間は全体ダウンロードより長い（例: 行グループ 2,048 行・`muni_code` 順で中央値 762 ms 対 291 ms） | 下の「経路 (a)」 |
| 経路 (b) `DuckDBDataProtocol.S3` / (c) 新しい DuckDB-WASM | (b) 未試験。(c) 1.33.1-dev57（`latest` タグ）と 1.33.1-dev118（`next`）も `Content-Length` を `/` で分割するコードが残っている（コードを読んだだけ。測定していない） | 下の「経路 (b) と (c)」 |
| サンドボックスの扱い（ユーザー確認） | 未実施（コントローラーがユーザーに確認する） | |

##### DuckDB-WASM の挙動（署名付き URL。`schools_rg2048_attr.parquet`、全件数クエリ 1 回あたりのリクエスト列）

設定は `db.open({ filesystem })` の値と `registerFileURL` の `directIO`、`DuckDBDataProtocol.HTTP`。全クエリで同じ列になった（各設定 12 回）。表の `Range` は送ったヘッダー、`403` などは応答のステータス。

| 設定 | リクエスト列 | 結果 |
|---|---|---|
| `reliableHeadRequests: false`、`allowFullHTTPReads: false` | HEAD（`Range: bytes=0-`）→ 403 | open が失敗（`Failed to open file`）。`SELECT` が通らない |
| `reliableHeadRequests: true`、`allowFullHTTPReads: false` | HEAD（`bytes=0-`）→ 403 | open が失敗（同上） |
| `reliableHeadRequests: false`、`allowFullHTTPReads: true`（`forceFullHTTPReads` を明示的に `false`） | GET（`bytes=0-0`）→ 206、HEAD（`bytes=0-`）→ 403、GET（`Range` なし）→ 200（3,453,409 B） | 全体を読んで成功。リクエスト 3 回 |
| `reliableHeadRequests: true`、`allowFullHTTPReads: true` | GET（`bytes=0-0`）→ 206、HEAD（`bytes=0-`）→ 403、GET（`Range` なし）→ 200（3,453,429 B）の順。上の行と同じ順序（Worker 内の XHR の記録順と CDP の順が一致。生データ: `reliableHeadRequests` を `true` にしたときの別実行でも同じ順だった） | 全体を読んで成功 |
| `reliableHeadRequests: false`、`allowFullHTTPReads: true`、`directIO: true` | 上と同じ 3 回（順序も同じ） | 全体を読んで成功 |
| `reliableHeadRequests: false`、`allowFullHTTPReads: true`、`forceFullHTTPReads: true` | GET（`Range` なし）→ 200 の 1 回だけ | 全体を読んで成功 |
| `allowFullHTTPReads: true` のみ（`forceFullHTTPReads` を指定しない。ページの前の版で測定） | GET（`Range` なし）→ 200 の 1 回だけ | 全体を読んで成功。`forceFullHTTPReads` を指定しない場合は 1 回の GET だけだった（`forceFullHTTPReads: false` を明示した上の行は 3 回）。ソースの JS だけを読むと未指定でも 3 回になるはずで、未指定の既定値が Worker の外（wasm 側）で決まっている可能性がある【推定。この版では未指定のケースを再測定していない】 |
| `registerFileURL` を使わず `read_parquet('https://…署名付き URL')`、`allowFullHTTPReads: false` | HEAD → 403 | `No files found that match the pattern`（失敗） |
| 同上、`allowFullHTTPReads: true` | HEAD → 403、GET `bytes=0-0` → 206 を 2 回、HEAD（`bytes=0-`）→ 403、GET → 200（全体） | 全体を読んで成功（リクエスト 5 回）。2 回目以降は DuckDB 側が URL をキャッシュして、同じ秒内の再実行は全体読みをしないことがあった |
| `registerFileBuffer`（メインスレッドで全体を `fetch` して登録。最悪ケースの基準） | GET（`Range` なし）→ 200 が 1 回（ページ側の `fetch`） | 成功。クエリ自体は 3〜58 ms |

注: 4 組（`reliableHeadRequests` の真偽 × `allowFullHTTPReads` の真偽）で、`reliableHeadRequests` の値は観測した挙動を変えなかった（`allowFullHTTPReads: false` は両方 HEAD → 403 で失敗、`true` は両方 GET `bytes=0-0` → HEAD → GET）。`openFile` のソースを読むと、`true` なら先頭の HEAD が最初に送られ、2 回目の HEAD は送られないはずだが、実測はそうならなかった。理由は切り分けていない（設定が Worker 内のファイル情報まで届いていない可能性【推定】）。候補の説明【推定。測定では確かめていない】: `openFile` は `reliableHeadRequests` を、wasm が返すファイル情報（`getFileInfo` → `JSON.parse`）から読む。`duckdb-eh.wasm` の文字列を `grep -a` で読み取りのみで見ると、`allowFullHttpReads` と `forceFullHttpReads` は隣り合って `maximumThreads` の近く（約 31,786,500 バイト付近）にあり、`reliableHeadRequests` は 1 か所だけ、SQL の設定名 `reliable_head_requests` の隣（約 31,762,100 バイト付近）にある。ファイル情報にこの項目が含まれないなら、常に `undefined`（偽）になり、観測した 4 組と合う。文字列の位置の観察は確認したが、そこからの推論は未検証。

##### 原因の読み取り（`openFile`。HTTP=4、S3=5。`node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js` の `openFile`、1.32.0。【ソース】を読み、【実行】の記録順と突き合わせた）

1. `forceFullHttpReads` でなく、かつ（`reliableHeadRequests` または `allowFullHttpReads` でない）なら、最初に HEAD（`Range: bytes=0-`）を送る。`Content-Length` があり、かつ**ステータスが 206** のときだけ、そのサイズで開く（200 の HEAD では入らない）。署名付き GET URL の HEAD は 403 なのでここで入れない。`allowFullHttpReads` が無効なら `return 0`（open 失敗）。実測: `allowFullHTTPReads: false` で、どちらの `reliableHeadRequests` でも HEAD が 1 回だけ出て 403 で失敗した。
2. `allowFullHttpReads` が有効なら（`forceFullHttpReads` でなければ）、`GET Range: bytes=0-0` を送る。応答の `Content-Length`（1 のはず）を `/` で分割して 2 つ目をサイズとして取ろうとする（`Content-Range` ではなく `Content-Length` を分割している。コード上のバグに見える）。取れなければ（`reliableHeadRequests` でなければ）もう一度 HEAD を送り、`Content-Length` が 1 より大きければサイズとする。HEAD も失敗すると「falling back to full HTTP read」で `Range` なしの GET になる。実測は、`reliableHeadRequests` の真偽によらず GET `bytes=0-0` → HEAD → GET（Range なし）の順だった（上の注のとおり、ソースの予想と一致しない点がある）。
3. したがって、この版では `Content-Range` からサイズを取る経路が無く、サイズを得る手段は「206 + `Content-Length` の HEAD」だけ。署名付き GET URL のままではどの設定でも入れない。設定は `filesystem` の 3 つ（`reliableHeadRequests`、`allowFullHTTPReads`、`forceFullHTTPReads`）と `directIO`、`read_parquet` に URL を直接渡す方法まで、すべて試した（上の表）。

##### 経路 (a): Worker 内で HEAD を `GET Range: bytes=0-0` に置き換える（フロントエンドだけ。バックエンドは変更なし）

- 方法: `net-probe.ts` が DuckDB の Worker を Blob 経由で起動する（本物の Worker を `importScripts` する前に `XMLHttpRequest` を差し替える）。同じ仕組みで、ページが登録した署名付き URL のオリジン（ページが Worker 起動時に渡す。ホスト名の決め打ちはしない）への HEAD を、`GET`（`Range: bytes=0-0`）に置き換え、`Content-Length` として `Content-Range` の総サイズを返す（ステータスはそのまま 206）。他のリクエスト（データ読み取りの Range GET）には手を加えない。ページのスイッチ「HEAD を GET Range 0-0 に置換」で有効にする（既定はオフ。段階 B のほかの表はオフで測った）。条件は、`reliableHeadRequests: false`、`allowFullHTTPReads: false`、`registerFileURL`（HTTP）、DuckDB のキャッシュは無効、ブラウザのキャッシュも無効（CDP）、毎回新しい署名付き URL と新しい仮想ファイル名（ファイルを開き直す）、各クエリ 5 回。比較の全体ダウンロードは、同じ日にそのすぐ後で、同じ条件の別実行として測った（`allowFullHTTPReads: true`、置き換えなし。同じページ・同じブラウザのセッションではない）。
- **結果【実行】**:
  - open は `allowFullHTTPReads: false` でも成功した。リクエストは GET `bytes=0-0`（置き換えた HEAD。206、本文 1 B）→ ファイル末尾のフッターやメタデータ、必要な列チャンクの `bytes=a-b`（すべて 206）。HEAD は 1 回も外に出ていない。CDP で見たリクエストは全 3,240 件が GET 206 で、OPTIONS（プリフライト）は 0 件、非 206 の GET も 0 件。
  - 各ファイル・クエリのリクエスト数と転送量は、比較用のローカルサーバーの表（「行グループ違いの比較」）と全 36 セルで同一（置き換えた GET `bytes=0-0` が、比較用サーバーでの HEAD 1 回に当たる）。
  - 結果（`n` と `geom_bytes` の集計）は、全体ダウンロード（置き換えなし）と全 36 セルで一致した。
  - 東京都の絞り込みの転送量は、全体（ファイルサイズ）に対し、行グループ 2,048 行で `muni_code` 順 311.6 KB（全体の 9%）、ヒルベルト順 758.1 KB（22%）、並び順なし 2,295.4 KB（53%）。他は下の表のとおり。
  - **時間は、ほとんどのクエリで全体ダウンロードより長い**。1 リクエストあたり約 60〜100 ms（時間 ÷ リクエスト数。実測）かかり、リクエスト数に比例する。原因は、Worker 内の同期 XHR をシーケンシャルに往復しているためと考えられる【推定】（例: `muni_code` 順 2,048 行の東京都は 11 回で中央値 762 ms、全体ダウンロードは 291 ms。全件数は 4 回 / 55.6 KB で 333 ms 対 286 ms とほぼ同じ。フッターだけで済む全件数は、行グループが大きいファイル（2 回）で 144〜206 ms と全体ダウンロード（300〜760 ms）より短かった）。ファイルが 3〜4 MB のこのデータでは、全体ダウンロードのほうが速いか同程度。

| ファイル（schools_…） | クエリ | 置き換えあり: 回数 / 転送量 / 時間 ms（中央値、最小〜最大） | 全体ダウンロード（直後の別実行）: 転送量 / 時間 ms | 結果の一致 |
|---|---|---|---|---|
| rg2048_unsorted | 全件数 | 4 回 / 39.4 KB / 236（218〜572） | 4,291.7 KB / 511（322〜907） | 一致 |
| rg2048_unsorted | 全件スキャン | 60 回 / 2,279.4 KB / 4,280（3,837〜4,311） | 4,291.7 KB / 672（315〜1,102） | 一致 |
| rg2048_unsorted | 1 都道府県 | 61 回 / 2,295.4 KB / 4,527（4,039〜4,992） | 4,291.7 KB / 444（356〜808） | 一致 |
| rg2048_unsorted | 境界ボックス | 19 回 / 8,078.9 KB / 2,307（2,029〜2,885） | 4,291.7 KB / 338（318〜1,637） | 一致 |
| rg2048_attr | 全件数 | 4 回 / 55.6 KB / 333（203〜955） | 3,371.8 KB / 286（233〜374） | 一致 |
| rg2048_attr | 全件スキャン | 59 回 / 2,231.6 KB / 4,573（4,140〜4,749） | 3,371.8 KB / 326（257〜423） | 一致 |
| rg2048_attr | 1 都道府県 | 11 回 / 311.6 KB / 762（673〜779） | 3,371.8 KB / 291（228〜431） | 一致 |
| rg2048_attr | 境界ボックス | 15 回 / 1,911.6 KB / 1,576（1,299〜2,459） | 3,371.8 KB / 349（303〜394） | 一致 |
| rg2048_hilbert | 全件数 | 4 回 / 46.7 KB / 312（229〜555） | 3,415.4 KB / 393（273〜579） | 一致 |
| rg2048_hilbert | 全件スキャン | 60 回 / 2,278.1 KB / 4,235（3,937〜5,907） | 3,415.4 KB / 357（322〜409） | 一致 |
| rg2048_hilbert | 1 都道府県 | 25 回 / 758.1 KB / 2,050（1,656〜2,401） | 3,415.4 KB / 305（249〜340） | 一致 |
| rg2048_hilbert | 境界ボックス | 19 回 / 2,062.7 KB / 1,415（1,345〜1,846） | 3,415.4 KB / 275（260〜369） | 一致 |
| rg8192_unsorted | 全件数 | 2 回 / 13.7 KB / 152（111〜174） | 3,981.7 KB / 306（233〜342） | 一致 |
| rg8192_unsorted | 全件スキャン | 23 回 / 2,155.5 KB / 1,563（1,400〜1,994） | 3,981.7 KB / 370（290〜444） | 一致 |
| rg8192_unsorted | 1 都道府県 | 25 回 / 2,235.5 KB / 2,175（1,684〜2,318） | 3,981.7 KB / 503（329〜908） | 一致 |
| rg8192_unsorted | 境界ボックス | 18 回 / 4,299.5 KB / 1,818（1,478〜2,094） | 3,981.7 KB / 385（293〜531） | 一致 |
| rg8192_attr | 全件数 | 2 回 / 15.5 KB / 192（132〜217） | 3,327.5 KB / 596（295〜1,251） | 一致 |
| rg8192_attr | 全件スキャン | 23 回 / 2,158.9 KB / 1,918（1,723〜2,252） | 3,327.5 KB / 406（371〜584） | 一致 |
| rg8192_attr | 1 都道府県 | 9 回 / 703.5 KB / 790（723〜919） | 3,327.5 KB / 363（250〜441） | 一致 |
| rg8192_attr | 境界ボックス | 14 回 / 1,359.5 KB / 1,328（1,234〜1,469） | 3,327.5 KB / 503（410〜642） | 一致 |
| rg8192_hilbert | 全件数 | 2 回 / 12.9 KB / 167（162〜228） | 3,372.9 KB / 352（335〜412） | 一致 |
| rg8192_hilbert | 全件スキャン | 23 回 / 2,153.8 KB / 2,718（1,928〜2,957） | 3,372.9 KB / 342（291〜647） | 一致 |
| rg8192_hilbert | 1 都道府県 | 16 回 / 1,225.8 KB / 1,405（1,234〜1,820） | 3,372.9 KB / 308（268〜370） | 一致 |
| rg8192_hilbert | 境界ボックス | 25 回 / 2,326.7 KB / 2,419（2,113〜2,500） | 3,372.9 KB / 317（253〜360） | 一致 |
| rg16384_unsorted | 全件数 | 2 回 / 7.8 KB / 206（191〜658） | 3,911.8 KB / 335（253〜424） | 一致 |
| rg16384_unsorted | 全件スキャン | 13 回 / 1,087.5 KB / 1,468（1,210〜2,078） | 3,911.8 KB / 358（315〜794） | 一致 |
| rg16384_unsorted | 1 都道府県 | 15 回 / 1,167.5 KB / 1,662（1,326〜1,999） | 3,911.8 KB / 428（335〜893） | 一致 |
| rg16384_unsorted | 境界ボックス | 13 回 / 3,871.5 KB / 1,575（1,075〜1,776） | 3,911.8 KB / 1,030（501〜1,664） | 一致 |
| rg16384_attr | 全件数 | 2 回 / 9.2 KB / 144（121〜225） | 3,289.2 KB / 760（626〜1,373） | 一致 |
| rg16384_attr | 全件スキャン | 14 回 / 1,138.4 KB / 1,139（954〜1,309） | 3,289.2 KB / 810（422〜1,950） | 一致 |
| rg16384_attr | 1 都道府県 | 9 回 / 697.2 KB / 712（674〜881） | 3,289.2 KB / 514（344〜710） | 一致 |
| rg16384_attr | 境界ボックス | 10 回 / 3,122.4 KB / 901（807〜1,136） | 3,289.2 KB / 1,177（561〜1,556） | 一致 |
| rg16384_hilbert | 全件数 | 3 回 / 18.8 KB / 198（151〜269） | 3,330.8 KB / 436（368〜593） | 一致 |
| rg16384_hilbert | 全件スキャン | 15 回 / 1,141.5 KB / 1,067（968〜1,146） | 3,330.8 KB / 1,225（390〜1,887） | 一致 |
| rg16384_hilbert | 1 都道府県 | 13 回 / 821.5 KB / 1,018（834〜1,187） | 3,330.8 KB / 431（355〜2,671） | 一致 |
| rg16384_hilbert | 境界ボックス | 16 回 / 1,941.5 KB / 1,150（987〜1,226） | 3,330.8 KB / 526（256〜806） | 一致 |

- 比較の値（全体ダウンロード）は、回線の状態でばらつく（最小〜最大の幅が大きいセルがある。例: 東京都の `rg16384_hilbert` は 355〜2,671 ms）。この表の時間は 1 台・1 回線の値。
- 確認していないこと（成立の範囲）:
  - DuckDB-WASM 1.32.0 の `openFile` の内部（HEAD を送り、`status == 206` と `Content-Length` を読む）に依存している。版が変わると動かない可能性がある。1.32.0 以外では試していない。
  - Chrome（Chrome for Testing 149）だけ。他のブラウザは未確認。
  - 署名付き URL の有効期限（3,600 秒）が切れた場合: 登録済みの URL でのデータ読み取りが失敗する。期限前に再署名して再登録する必要があり、その動作は試していない（毎回新しい URL で登録した）。
  - 「リクエスト数 × 往復の遅延」が全体ダウンロードに勝つファイルの大きさ: この 3〜4 MB・回線では負けるか同程度。数十 MB 以上のファイルでは逆転する可能性がある【推定。測っていない】。
  - Service Worker で同じ置き換えをする案は試していない（Worker 内の同期 XHR を Service Worker が横取りするかも未確認）。

##### 経路 (b) と (c)（測定していない）

- (c) 新しい DuckDB-WASM が `Content-Range` を読むか【ソース。コードを読んだだけで、測定していない】: npm のタグは `latest` = 1.33.1-dev57.0、`next` = 1.33.1-dev118.0（どちらも開発ビルド）。安定版で最も新しいのは 1.32.0（今使っているもの）。`npm pack` で別ディレクトリに取り出して `openFile` を読んだ（実行・import・ビルドはしていない）。1.33.1-dev57.0（`duckdb-browser-eh` / `mvp` / `coi` の各 Worker）と 1.33.1-dev118.0（`duckdb-browser-base` と `threads` の Worker）のどちらにも、`GET Range: bytes=0-0` の後に `Content-Length` を `split("/")[1]` する同じコードが残っており、`Content-Range` を読む箇所は近くに無い。Context7 のドキュメントにも、この点の記述は無かった。つまり新しい版でも、サイズを得る手段は HEAD（206 + `Content-Length`）のままに見える。
- (b) `DuckDBDataProtocol.S3` + `s3Config`（未試験の提案）: Worker が SigV4 で HEAD と GET を自分で署名するので、署名付き URL の HEAD 問題は起きない。ただしブラウザに一時的な AWS 認証情報（アクセスキー、シークレット、セッショントークン。たとえばバックエンドが STS で発行する、対象バケットの読み取りだけの短命な資格情報）を渡す必要があり、その発行 API、権限の絞り方（バケット・プレフィックス）、有効期限、漏えい時の影響のセキュリティ評価が要る。実装も試験もしていない。

##### 署名付き URL での計測（全体読み込みのとき）

`reliableHeadRequests: false`、`allowFullHTTPReads: true`、`forceFullHTTPReads: false`、DuckDB のキャッシュは無効、ブラウザのキャッシュも無効。各ファイル・各クエリ 3 回ずつ、リクエスト 3 回（GET `bytes=0-0` + HEAD + 全体 GET）、転送量はレスポンス本文の合計（HEAD の 403 本文約 0.5 KB と `bytes=0-0` の 1 B を含み、ファイルサイズより少し大きい）。

| ファイル | サイズ (B) | 転送量 (KB) | 時間 中央値 (ms)。全件数 / 全件スキャン / 1 都道府県 / 境界ボックス |
|---|---|---|---|
| schools_rg2048_unsorted | 4,394,714 | 4,291.7 | 261 / 274 / 269 / 303 |
| schools_rg2048_attr | 3,452,738 | 3,371.8 | 289 / 285 / 223 / 398 |
| schools_rg2048_hilbert | 3,497,338 | 3,415.4 | 249 / 249 / 298 / 255 |
| schools_rg8192_unsorted | 4,077,301 | 3,981.7 | 263 / 226 / 263 / 222 |
| schools_rg8192_attr | 3,407,331 | 3,327.5 | 275 / 277 / 215 / 248 |
| schools_rg8192_hilbert | 3,453,850 | 3,372.9 | 263 / 261 / 245 / 233 |
| schools_rg16384_unsorted | 4,005,642 | 3,911.8 | 262 / 260 / 265 / 252 |
| schools_rg16384_attr | 3,368,138 | 3,289.2 | 219 / 202 / 247 / 205 |
| schools_rg16384_hilbert | 3,410,689 | 3,330.8 | 293 / 251 / 242 / 189 |
| municipalities | 1,641,500 | 1,603.0 | 175 / 192 / 159（`pref_name`）/ - |
| municipalities_coarse | 420,379 | 410.5 | 141 / 175 / 181（`pref_name`）/ - |
| stations | 260,089 | 254.0 | 173 / 184 / 176 / - |
| schools | 1,884,180 | 1,840.0 | 244 / 258 / 220 / - |

- 9 本の派生ファイルでクエリごとの時間は 189〜398 ms（4 クエリの中央値の範囲）で、クエリの種類・並び順・行グループの大きさによる系統的な差は見えない。時間はほぼ全体のダウンロード時間（この Mac のネットワークから、約 4.4 MB で約 200〜300 ms）。1 台・1 回線での値で、回線によって大きく変わる。
- 3 回の各回のばらつきは約 20〜100 ms（例: 全件数の 3 回 `[327, 251, 261]`）。コールド（新しいページ）とウォームの系統的な差は、署名付き URL の全体読み込みでは見分けられなかった（毎回別の URL でダウンロードするため）。

##### 行グループ違いの比較（HEAD と Range に対応した比較用サーバー）

署名付き URL では Range 読み取りに入れないので、「HEAD と Range が通るなら DuckDB-WASM はどう読むか」を、同じページ・同じブラウザ・同じ `reliableHeadRequests: false`、`allowFullHTTPReads: false` の設定で、ローカルの小さなサーバー（`127.0.0.1:8099`。HEAD、Range、CORS に対応し、同じファイルを返す）を指して測った。**S3 の値ではない**（ネットワーク遅延がほぼ 0 なので時間は参考にならず、リクエスト数と転送量だけが意味を持つ）。このサーバーを使うと、リクエスト列は「HEAD（`Range: bytes=0-`）→ 206、続いてファイルの末尾 12 KB、メタデータ、必要な列チャンクの `bytes=a-b`」になり、プリフライトは送られなかった。

DuckDB のキャッシュを無効にした回と残した回で、リクエスト数・転送量は全セルで同じだった。表はリクエスト数 / 転送量 / 時間の中央値（3 回、ms）。

| ファイル（schools_…） | 行グループ数 | サイズ (B) | 全件数 | 全件スキャン（参照。図形列だけ） | 1 都道府県 | 境界ボックス |
|---|---|---|---|---|---|---|
| rg2048_unsorted | 28 | 4,394,714 | 4 回 / 39.4 KB / 7 ms | 60 回 / 2,279.4 KB / 70 ms | 61 回 / 2,295.4 KB / 72 ms | 19 回 / 8,078.9 KB / 57 ms |
| rg2048_attr | 28 | 3,452,738 | 4 回 / 55.6 KB / 8 ms | 59 回 / 2,231.6 KB / 53 ms | 11 回 / 311.6 KB / 13 ms | 15 回 / 1,911.6 KB / 19 ms |
| rg2048_hilbert | 28 | 3,497,338 | 4 回 / 46.7 KB / 6 ms | 60 回 / 2,278.1 KB / 54 ms | 25 回 / 758.1 KB / 26 ms | 19 回 / 2,062.7 KB / 23 ms |
| rg8192_unsorted | 7 | 4,077,301 | 2 回 / 13.7 KB / 3 ms | 23 回 / 2,155.5 KB / 28 ms | 25 回 / 2,235.5 KB / 30 ms | 18 回 / 4,299.5 KB / 30 ms |
| rg8192_attr | 7 | 3,407,331 | 2 回 / 15.5 KB / 4 ms | 23 回 / 2,158.9 KB / 28 ms | 9 回 / 703.5 KB / 11 ms | 14 回 / 1,359.5 KB / 16 ms |
| rg8192_hilbert | 7 | 3,453,850 | 2 回 / 12.9 KB / 3 ms | 23 回 / 2,153.8 KB / 24 ms | 16 回 / 1,225.8 KB / 18 ms | 25 回 / 2,326.7 KB / 27 ms |
| rg16384_unsorted | 4 | 4,005,642 | 2 回 / 7.8 KB / 3 ms | 13 回 / 1,087.5 KB / 16 ms | 15 回 / 1,167.5 KB / 20 ms | 13 回 / 3,871.5 KB / 23 ms |
| rg16384_attr | 4 | 3,368,138 | 2 回 / 9.2 KB / 3 ms | 14 回 / 1,138.4 KB / 16 ms | 9 回 / 697.2 KB / 11 ms | 10 回 / 3,122.4 KB / 21 ms |
| rg16384_hilbert | 4 | 3,410,689 | 3 回 / 18.8 KB / 4 ms | 15 回 / 1,141.5 KB / 18 ms | 13 回 / 821.5 KB / 14 ms | 16 回 / 1,941.5 KB / 18 ms |

読み取れること（この表の範囲）:

- 並び順の効果は大きい。1 都道府県（東京都）の転送量は、行グループ 2,048 行で、並び順なし 2,295 KB → `muni_code` 順 312 KB（86% 減）、ヒルベルト順 758 KB（67% 減）。8,192 行で 2,236 KB → 704 KB（69% 減）/ 1,226 KB（45% 減）。16,384 行で 1,168 KB → 697 KB（40% 減）/ 822 KB（30% 減）。`muni_code` 順は属性（`muni_code` の範囲）で絞るクエリに対して最も効く。
- `muni_code` 順で、行グループを小さくすると 1 都道府県の転送量は 697 / 704 / 312 KB（16,384 / 8,192 / 2,048 行）と小さくなる（16,384 行と 8,192 行はほぼ同じ）。リクエスト数は 9 / 9 / 11 回、全件スキャンでは 14 / 23 / 59 回に増える。
- 境界ボックス（`bbox_*` 列）は、並び順なしだと全行グループに当たる（2,048 行で 8,079 KB。ファイルサイズ 4.4 MB を超える）。`muni_code` 順は 1,912 KB、ヒルベルト順は 2,063 KB で同程度、行グループ 8,192 行では `muni_code` 順 1,360 KB がヒルベルト順 2,327 KB より小さく、16,384 行ではヒルベルト順 1,942 KB が `muni_code` 順 3,122 KB より小さい。ヒルベルト順が一貫して有利とは言えない（東京という 1 つの領域での 1 回ずつの測定）。
- 転送量がファイルサイズを超えるのは、並び順なしの境界ボックス（2,048 行: 8,079 KB、8,192 行: 4,300 KB、16,384 行: 3,872 KB）。同じ範囲を複数回読んでいるように見えるが、原因は切り分けていない（DuckDB の読み取りキャッシュの有無では変わらなかった）。未確認。
- 全件数は、どの派生でも 8 〜 56 KB で済み（フッターのメタデータだけ）、リクエスト数は 2〜4 回。
- 比較（S3 の署名付き URL では、どのクエリも 3.3〜4.4 MB を全体ダウンロード）。もし HEAD と Range が通る URL が使えれば、東京都 1 つの絞り込みは、`muni_code` 順の行グループ 2,048 行で 312 KB（全体の約 9%）。

##### CORS プリフライト

- Chrome（Chrome for Testing 149）は、単一範囲の `Range`（`bytes=0-0`、`bytes=100-199`、`bytes=0-`）の GET / HEAD ではプリフライトを送らなかった（CDP で OPTIONS が出ない）。DuckDB-WASM が使うのはこの形（絶対位置の範囲）だけで、DuckDB-WASM のセッションでは OPTIONS が 0 件だった（署名付き URL: GET 144 / HEAD 144 / GET 144 で OPTIONS なし。ローカルサーバー: HEAD 108 / GET 1,836 で OPTIONS なし）。
- 接尾辞範囲（`bytes=-100`）と複数範囲（`bytes=0-9,20-29`）は、プリフライト（OPTIONS）を送る。S3 の CORS は `Range` を許可しているので、OPTIONS は 200 で通り、GET は 206（複数範囲は S3 が範囲を無視して 200・全体）。対照として、独自ヘッダー（`X-Spike`）の GET は OPTIONS が 403 になり、`PreflightMissingAllowOriginHeader` で失敗した。
- プリフライトの費用: 接尾辞範囲の OPTIONS は 16〜114 ms（最初の 1 回は TLS の接続を含む 114 ms、以降 16〜19 ms）。同じ署名付き URL で 3 回続けても、新しい署名付き URL でも、毎回 OPTIONS が送られた（`maxAge` 3000 が効いたようには見えなかった）。この計測では CDP の `Network.setCacheDisabled` は使っていない（無効化なし）。CDP を使わずに Chrome の `--log-net-log` だけで、同じ署名付き URL への接尾辞範囲の GET を 3 回続けて数え直しても、OPTIONS は 3 回あった。したがって CDP の影響ではなく、この条件（Chrome for Testing、署名付き URL、`Range` ヘッダー付き）ではプリフライトの結果が再利用されなかった。理由は未確認。
- HEAD（`Range: bytes=0-`）はプリフライトなし。署名付き URL では 403 で、ブラウザは CORS ヘッダー付きのこの 403 をステータスとして読める（そのため DuckDB-WASM の XHR は例外にならず、HEAD の失敗を扱える）。

##### 初回読み込み（プレビューのオリジン。wasm はバケットから）

- 範囲: Worker 起動 + wasm の取得と instantiate + `INSTALL spatial; LOAD spatial;`（B-1 の「初期化〜spatial 読み込み」と同じ範囲）。`duckdb-eh.wasm`（34,242,586 B。S3 から署名付き URL。圧縮なし。CloudFront ではない）と Worker の JS（プレビューから約 189 KB、gzip）を取得。新しいブラウザコンテキストで開いた直後の 1 回目をコールド、同じページでの再初期化を「温かい」とした。拡張（spatial、約 6 MB）は拡張リポジトリの CDN から取得される。
- 結果（ms）:
  - 新しいコンテキストの 1 回目の合計: 2,665 / 2,513 / 2,624 / 2,526（4 コンテキスト）、中央値 2,575。内訳は instantiate 1,367〜1,491、`INSTALL`+`LOAD spatial` 1,068〜1,174。
  - 同じページでの再初期化（同じ署名付き URL）の合計: 1,579 / 2,119 / 1,758 / 1,544 / 1,602 / 1,484 / 1,535 / 1,521（4 コンテキスト × 2 回）、中央値 1,562。instantiate 999〜1,601、`INSTALL`+`LOAD spatial` 485〜520。
  - 同じコンテキストでページを開き直した 1 回目: 1,742（instantiate 1,253 + spatial 489）。署名付き URL が変わるので wasm は再ダウンロードされたが、拡張はキャッシュに当たった。
- wasm の転送: 毎回 34,243,294〜34,243,314 B（CDP の `encodedDataLength`）。ダウンロード時間は 616〜1,259 ms（この Mac のネットワークから）。同じページ内の再初期化でも `fromCache` は false で、再ダウンロードされた。オブジェクトには `Cache-Control: public, max-age=3600` を付けていたが、34 MB のエントリはキャッシュされなかった【推定: ヘッドレスの Chrome のキャッシュの上限による。未確認】。署名付き URL は毎回変わるので、ページを開き直せばどのみちキャッシュに当たらない。拡張の spatial は 1 回目 約 6.0 MB（615〜692 ms）、その後はキャッシュ（0 B）。
- B-1 との比較（ローカル、Vite の開発サーバー）: 初回の中央値 3,147 ms、2 回目 2,369 ms、同一ページでの再初期化 1,917 ms。プレビューでの値は同程度か少し短い（2,575 / 1,562）。ただし B-1 は開発サーバー経由で、今回は S3 から（圧縮なしの約 34 MB を 1 秒弱で取得できる回線）の値で、条件は違う。CloudFront（圧縮あり）から配信した場合の初回読み込みは未確認。
- 目安の「初期化 10 秒以内」は満たす（最大 2,665 ms）。

##### 配信の上限（ホスト型プレビューの前面）

- ビルド出力に `duckdb-eh.*.wasm`（34,242,586 B）と `duckdb-mvp.*.wasm`（39,362,651 B）が出る。デプロイ時の警告（`@aws-blocks/hosting:AssetExceedsProxyLimit`）は、「ファイルは base64 にして（圧縮できる種類は gzip してから）Lambda の応答で返すので、API Gateway 前面では応答が 6 MB（Lambda の応答上限。API Gateway の 10 MB より小さい）に制限され、これらは読み込みに失敗する」という内容で、2 つの wasm を挙げた。「実質 4.5 MB まで」は、Blocks のドキュメント（`node_modules/@aws-blocks/blocks/docs/hosting/README.md`「Size and time limits」の表。API Gateway の「Largest file, about 4.5 MB」）の値で、6 MB を base64 化の 3/4 にした値。synth は警告だけでデプロイは成功する。ALB の前面は試していない（ドキュメントには 1 MB の上限とある）。
- 実測: プレビューから `duckdb-eh.*.wasm` を取得すると HTTP 500（`{"message":"Internal Server Error"}`、約 4.6 秒）。Worker の JS（約 0.77 MB、gzip で約 189 KB）は 200。
- 原因の確認【実行】: 同じ URL をもう一度取得し、asset proxy の Lambda（256 MB）の CloudWatch ログを読んだ。応答の大きさ超過のエラーではなく、`REPORT … Duration: 4745.78 ms … Max Memory Used: 256 MB … Status: error, Error Type: Runtime.OutOfMemory` だった。つまり 500 の直接の原因は、34 MB のファイルを読んで base64 に変換する途中の Lambda のメモリ不足。6 MB の応答上限は、メモリが足りてもこのサイズを通さない上限で、どちらも「このサイズの静的ファイルは asset proxy では配信できない」ことを示す（6 MB 上限そのものでの失敗は、メモリ不足が先に起きたため確認していない）。
- 影響: プレビュー上では、アプリのオリジンから DuckDB-WASM を読み込む B-1 のページ（`/spike/duckdb`、`/spike/duckdb/static`）は動かない（確認は wasm の 500 まで。ページ自体の動作は見ていない）。B-2 のページは wasm をバケットから署名付き URL で読むよう分岐した。CloudFront の前面（静的ファイルは S3 から直接配信）では、この上限はない（ドキュメントの記述。デプロイしていないので未確認）。

#### 判断

- **署名付き URL + `registerFileURL` での Range 読み取り（置き換えなし）: 成立しない。** 原因は 2 つが重なっている: (1) 署名付き GET URL への HEAD が 403 になる、(2) DuckDB-WASM 1.32.0 の `openFile` が `GET Range: bytes=0-0` の応答の `Content-Range` を読まず、サイズを得る手段が「206 + `Content-Length` の HEAD」だけである（上の「原因の読み取り」）。`allowFullHTTPReads` が無効なら open が失敗し、有効なら全体を 1 回ダウンロードする。署名付き URL への Range GET 自体は 206 で成功し、CORS は GET / HEAD + `Range` で通り、プリフライトも DuckDB-WASM の読み取りでは出ない。S3 側の Range と CORS は問題ではない。
- **バックエンドを変えずに試したこと / 試していないこと**:
  - 試して、置き換えなしの設定の組み合わせはすべて全体読み込みか失敗だった（`reliableHeadRequests` の真偽、`allowFullHTTPReads`、`forceFullHTTPReads`、`directIO`、`read_parquet` に URL を直接渡す）。
  - 試して、動いた: 経路 (a)（Worker 内で HEAD を `GET Range: bytes=0-0` に置き換える。フロントエンドだけ）。Range 読み取りになり、転送量は大きく減るが、東京都の絞り込みの時間は全体ダウンロードより長かった（上の「経路 (a)」）。
  - 試していない: Service Worker での置き換え、`DuckDBDataProtocol.S3`（経路 (b)。一時的な認証情報が要る）、新しい DuckDB-WASM（経路 (c)。コードを読んだだけでは、新しい版でも `Content-Range` を読むようにはなっていない）。
- **採用方針の候補（決めてはいない）**:
  - 全体取得に統一する（「だめな場合の代替」）: 動く。今回のデータでは 1 クエリ 約 250〜300 ms、転送量はファイルサイズ（0.3〜4.4 MB）。検証データの 4 ファイルの合計は約 4.2 MB（4,206,148 B）なので、全体取得でもダウンロードは数百 ms〜1 秒程度に収まる見込み【推定。この 4 ファイルを同時に取得した測定はしていない】。ただし、行グループの並び順の効果は得られない。
  - 経路 (a) の置き換えを使う: 転送量は減る（東京都の絞り込みで全体の 9〜53%）が、このファイルの大きさと回線では時間は全体ダウンロードより長い。DuckDB-WASM の内部への依存があり、版が変わると壊れる恐れがある。ファイルが大きい場合は有利になる可能性がある【推定】。
  - 「`Range: bytes=0-` の HEAD に **206** と `Content-Length` で答える」配信経路にする（未検証の提案）: たとえば CloudFront（署名付き URL / Cookie は HTTP メソッドに依存しない。HEAD を 206 で返すかは設定とオリジン次第）、または HEAD に 206 で答える Lambda のプロキシ。HEAD に 200 で答える経路では Range 読み取りに入らない。比較用サーバー（HEAD に 206 で答える）の測定では、DuckDB-WASM は期待どおり Range で読み、東京都の絞り込みは 312 KB（`muni_code` 順、行グループ 2,048 行）で済んだ。これは S3 や CloudFront 上の測定ではない。
  - HEAD 用と GET 用の署名付き URL を別々に渡す案は、DuckDB-WASM が 1 つの URL に HEAD と GET を送るので、そのままでは使えない（Worker 内で HEAD の宛先を差し替える経路 (a) と同じ仕組みを使えば成立しうるが、試していない）。
- **行グループの大きさ・並び順**: 置き換えなしの署名付き URL では効果なし（全体読み込みのため）。Range 読み取りが使える場合（経路 (a)、または比較用サーバーのような HEAD に 206 で答える経路）は、並び順（絞り込みに使う列で並べる）の効果が大きい（上の「行グループ違いの比較」と「経路 (a)」）。この比較用ローカルサーバーと経路 (a) の測定での目安は、行グループ 2,048 行・`muni_code`（絞り込みに使う属性）順。
- **`shared/` の置き場所: `aws-blocks/` の外のルート直下 `shared/` でよい。** サンドボックスのデプロイ（Lambda のバンドル）が `shared/spike-files.ts` を取り込み、デプロイ済みの `spikeApi.listNames` と `downloadUrl` がその内容で動いた。フロント（SvelteKit のビルド）からも相対 import で取り込め、`tsconfig`、`vite.config.ts`、`svelte.config.js` の変更は要らなかった。バックエンドとフロントの両方が `shared/` から値と型を import できる。型検査（`npm run typecheck`）、ビルド（`npm run build`）、ローカルの開発サーバー、デプロイのすべてで通った。

設計への影響:

1. **ファイル配信**: 署名付き URL のまま DuckDB-WASM 1.32.0 に Range 読み取りをさせることはできない（HEAD が 403 で、`Content-Range` からはサイズを取れない）。全体取得に統一するか、Worker 内の置き換え（経路 (a)。転送量は減るが、このデータの大きさでは時間は全体ダウンロードより長い。DuckDB-WASM 1.32.0 の内部実装に依存しており、版が変わると動かなくなる恐れがある）を使うか、`Range: bytes=0-` の HEAD に 206 と `Content-Length` で答える配信経路（CloudFront など。未検証）を用意するかを決める必要がある。全体取得なら、全体を取得して `registerFileBuffer`（B-1 で確認済み）でよい。`allowFullHTTPReads: true` で全体読み込みにフォールバックさせる場合は、`forceFullHTTPReads: false` を明示するか `true` を明示して、挙動（3 回のリクエストか 1 回の GET か）を固定する。未指定だと 1 回の GET になる実測があった。
2. **wasm の配信**: DuckDB-WASM の wasm（約 34 MB）は、API Gateway の前面では返せなかった（実測は HTTP 500、原因は Lambda のメモリ不足。ALB は試していない）。CloudFront の前面か、バケットからの署名付き URL が要る。wasm は毎回ダウンロードされ（この環境ではキャッシュされなかった）、署名付き URL にすると、ページを開き直すたびに約 34 MB を取り直す。CloudFront から配信するなら通常のキャッシュが効く見込み【推定】。
3. **CORS**: 署名付き URL でバケットを読む場合、`FileBucket` の CORS に GET / HEAD と許可ヘッダー `Range`、公開ヘッダー `Content-Range` / `Content-Length` / `Accept-Ranges` / `ETag` が要る。実アプリでは `*` ではなく、正確なオリジン（CloudFront のドメインなど）を書く。DuckDB-WASM の読み取りではプリフライトは出ない（単一範囲の `Range` は Chrome ではシンプルリクエスト扱い）が、他のブラウザは未確認。
4. **許可リスト・所有確認のパターン**: サインアップが開放のアプリでは、デプロイ前に全メソッドに許可リスト + 所有確認を付ける必要がある。デプロイ済みで、未サインイン 401 / 許可前 403 / 許可後に通る、が確認できた。`AppSetting`（SSM パラメーター）は、再デプロイなしで `aws ssm put-parameter --overwrite` で書き換えられ、次の呼び出しから効いた。
5. **署名付き URL の秒単位の重複**: 同じ秒に作った署名付き URL は同じ文字列になり、ブラウザのキャッシュや DuckDB の読み取りキャッシュに当たる。計測や、キャッシュを避けたい場合は注意。

#### 未確認

- 本番の前面（CloudFront）からの配信（wasm の初回読み込み、圧縮、キャッシュ、静的ファイルの上限）。
- HEAD に 206 と `Content-Length` で答える配信経路（CloudFront、プロキシ）での Range 読み取り。比較用のローカルサーバーでしか測っていない。
- 経路 (a) の、DuckDB-WASM 1.32.0 以外の版、Chrome 以外のブラウザ、署名付き URL の期限切れをまたぐ読み取り、数十 MB 以上のファイルでの時間。Service Worker での置き換え。
- 経路 (b) `DuckDBDataProtocol.S3` + 一時的な認証情報。経路 (c) 新しい版の動作（コードを読んだだけで、測定していない）。
- Chrome 以外のブラウザでの CORS（`Range` のプリフライト）と DuckDB-WASM の動作。
- プリフライトの結果が再利用されなかった理由（CDP なしの `--log-net-log` でも毎回 OPTIONS が出た。`maxAge` 3000 が効かない原因は未確認）。
- 並び順なしの境界ボックスの転送量がファイルサイズを超える原因。
- `forceFullHTTPReads` を指定しない場合の既定の挙動を、ページの現在の版で再測定していない（前の版では全体読み込みの 1 回だけだった）。`reliableHeadRequests` の値が挙動を変えなかった理由。
- 大きなデータ（全国の市区町村など、1 行グループにしかならないファイル）での Range 読み取り。派生の測定は `schools` のみ（`municipalities` は 1,898 行で行グループが 1 つにしかならない）。

## スパイク C: ローカルから Bedrock

### 確かめること

- `Agent` ブロックの文書（`bb-agent` の `README.md`、`API.md`）で `model.local` と `createChat` の配線
- ツールなしの最小の Agent を作り、`npm run dev` で応答が流れる（トークンまたはその塊ごとに複数回届く）か
- 発話の送信から最初のトークンまでの時間と、応答完了までの時間

### 合格の目安

- ローカルで応答が流れる

だめな場合の代替: サンドボックスで検証する。流れない原因を記録する。

### 結果

実施日 2026-11-17。コードは `aws-blocks/index.ts` の `SPIKE C/A` ブロックと `src/routes/spike/agent/`（Task 0.4 でも使う。Task 0.7 で削除）。経過は次のとおり。

1. Blocks 既定の Sonnet 4.6（`BedrockModels.BALANCED` = `global.anthropic.claude-sonnet-4-6`）: 拒否された。
2. 利用者の判断で Haiku に切り替えた。`BedrockModels.FAST`（`global.anthropic.claude-haiku-4-5-20251001-v1:0`）: 拒否された。
3. `jp.anthropic.claude-haiku-5-5`（明示の文字列）: 呼べた。以降の計測はこのモデルのもの。プロジェクトが使うと決めたモデルでもある（下の「判断」）。設計の当初の前提だった Sonnet 4.6 の値ではない。
4. 後から、Blocks を通さず SDK で `jp.anthropic.claude-sonnet-4-6` を 1 回呼んだ（下の「`jp.` の Sonnet 4.6 の単発確認」）: 呼べた。

Blocks（dev サーバー）経由の Bedrock 呼び出しは合計 9 回（Sonnet 1 回、`FAST` 1 回、`jp.` の Haiku 7 回 = 短い発話 1 回 + 計測 6 回）。上の 4 の SDK 呼び出し 1 回は、これに含まれない。

| 項目 | 結果 | 備考 |
|---|---|---|
| `model.local` と `createChat` の配線 | 動いた。送信 → Realtime 経由で `text-delta` / `done` がページに届き、`createChat` のメッセージ一覧に assistant の返答が入った | 文書とコードの読み取りで配線し、実行で確認した（下の「配線の記録」） |
| Sonnet 4.6（`global.`）を呼べるか | **呼べない**（1 回試行して拒否） | 下の「エラー」 |
| Haiku 4.5（`global.`、`BedrockModels.FAST`）を呼べるか | **呼べない**（1 回試行して拒否） | 下の「エラー」 |
| Haiku 5.5（`jp.anthropic.claude-haiku-5-5`）を呼べるか | **呼べた**（計 7 回すべて成功） | 下の「使ったモデルと認証情報」 |
| ストリーミング | 流れた（Haiku 5.5） | 下の「ストリーミングの証拠」。1〜8 文字の `text-delta` が約 150 ms ごとの塊で複数回に分かれて届いた。短い返答（約 11 文字）でも `text-delta` は 2 つに分かれて届いた |
| 送信から最初のトークンまで | 中央値 1,855 ms（2,196 / 2,102 / 1,849 / 1,858 / 1,852 / 1,784） | Haiku 5.5、6 回。下の「計測」 |
| 応答完了まで | 中央値 2,896 ms（2,934 / 2,967 / 2,571 / 2,858 / 2,951 / 2,493） | 同上 |

#### エラー

どちらも dev サーバーのログとページの `error` チャンクに同じ内容で届いた（`name` は `AccessDeniedException`、HTTP 403）。

Sonnet 4.6（`global.`）:

```
User: arn:aws:sts::<アカウント ID>:assumed-role/<SSO ロール名>/<SSO ユーザー名> is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-4-6 with an explicit deny in a service control policy: arn:aws:organizations::<管理アカウント ID>:policy/<組織 ID>/service_control_policy/<SCP ID>
```

Haiku 4.5（`global.`）:

```
User: arn:aws:sts::<アカウント ID>:assumed-role/<SSO ロール名>/<SSO ユーザー名> is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0 with an explicit deny in a service control policy: arn:aws:organizations::<管理アカウント ID>:policy/<組織 ID>/service_control_policy/<SCP ID>
```

- このアカウントでは、`global.` 経由で試した 2 モデル（Sonnet 4.6、Haiku 4.5）が、同じ SCP `<SCP ID>` の明示的な拒否で呼べなかった。
- 拒否では、リソースのリージョン部が空（`arn:aws:bedrock:::foundation-model/...`）だった。
- IAM 側（ロールは AdministratorAccess）では SCP の明示的な拒否を解消できない。AWS の評価規則による説明で、試してはいない。
- 成功した `jp.anthropic.claude-haiku-5-5` は、プロファイルの対象が ap-northeast-1 と ap-northeast-3 のモデル（2026-11-17 に `aws bedrock get-inference-profile --inference-profile-identifier jp.anthropic.claude-haiku-5-5 --profile training --region ap-northeast-1` で確認。`models` に両リージョンの `anthropic.claude-haiku-5-5`、`status` は `ACTIVE`、`type` は `SYSTEM_DEFINED`）。
- Haiku の結果だけでは、拒否の条件がプロファイル（`global.` か `jp.` か）なのかモデルなのかを区別できなかった（失敗した 2 件と成功した Haiku 5.5 は、プロファイルもモデルも違う）。下の Sonnet 4.6 の単発確認は、Sonnet 4.6 についてだけこれを切り分ける。SCP の本文は読んでいないので、拒否の条件そのものは**未確認**。
- 文書が挙げる 3 つの原因（利用目的フォームの未提出、Marketplace の購読、モデルが利用不可）とは別の原因。

読み取り専用の確認（`aws bedrock list-inference-profiles --profile training --region ap-northeast-1`）で見えた、ACTIVE の `SYSTEM_DEFINED` プロファイル（Sonnet 4.6 と Haiku のみ絞った一覧）:

- Sonnet 4.6: `global.anthropic.claude-sonnet-4-6`、`jp.anthropic.claude-sonnet-4-6`
- Haiku: `global.anthropic.claude-haiku-4-5-20251001-v1:0`、`jp.anthropic.claude-haiku-4-5-20251001-v1:0`、`global.anthropic.claude-haiku-5-5`、`jp.anthropic.claude-haiku-5-5`、`apac.anthropic.claude-3-haiku-20240307-v1:0`

`GetFoundationModelAvailability` は、インストール済みの AWS CLI にサブコマンドが無く、AWS MCP も別の認証情報で期限切れだったため、実行できていない（未確認）。

#### `jp.` の Sonnet 4.6 の単発確認（Blocks を通さない）

- 条件: `@aws-blocks` を通さず、リポジトリの `node_modules` にある `@aws-sdk/client-bedrock-runtime` の `ConverseStreamCommand` を 1 回。プロファイル `training`、リージョン `ap-northeast-1`、モデル ID `jp.anthropic.claude-sonnet-4-6`（`aws bedrock list-inference-profiles` で見えた ID）、プロンプト「Reply with the single word OK.」、`maxTokens` 16。アカウント所有者の承認のもとで実施。
- 結果: 成功。テキストは「OK」、使用トークンは入力 14 / 出力 4、最初の delta まで 1,392 ms、全体で 1,400 ms。1 回だけの値で、時間にはクライアントの準備と SSO 認証情報の解決を含むため、このセクションのページ計測とは比べられない。
- ストリーミング呼び出しは、`global.` で拒否された IAM アクション（`bedrock:InvokeModelWithResponseStream`）と同じものを使う。
- このマシンの AWS CLI には `bedrock-runtime` のストリーミング用サブコマンドが無いので、SDK を使った。
- わかったこと: Sonnet 4.6 では、同じモデルが `global.` では拒否され、`jp.` では許可された。したがって、このモデルについては拒否がプロファイルに依存する。
- わかっていないこと: SCP の本文は未読なので、他のモデルやプロファイル（例: `jp.` の Haiku 4.5 は未試行）については何もわからない。Blocks の `Agent` 経由の Sonnet 4.6 は未試験。デプロイ後の実行ロールも未試験。

#### 使ったモデルと認証情報

- モデル ID は `jp.anthropic.claude-haiku-5-5`。`BedrockModels` に Haiku 5.5 や `jp.` のプリセットは無く（`FAST` は `global.…haiku-4-5-20251001-v1:0` を指す。`models.d.ts` で確認）、`{ provider: 'bedrock', modelId: 'jp.anthropic.claude-haiku-5-5' }` を明示の文字列で渡した。`model.deployed` と `model.local` に同じ値を書いた。デプロイしたアプリでも同じ指定が要る（デプロイ側の実行ロールが呼べるかは**未確認**。SCP が全プリンシパルに及ぶなら同じ拒否・許可になるはずだが、確かめていない）。
- 選んだ理由は、`list-inference-profiles` に出た Haiku の `jp.` のうち、世代が新しい方だったこと（利用者の指示）。`jp.…haiku-4-5-…` は試していない。
- リージョンは、コードで指定しておらず、AWS SDK がプロファイル `training`（ap-northeast-1）から決めたはず。実際に使われたリージョンは確認していない。
- 認証情報は、`AWS_PROFILE=training npm run dev` で起動した dev サーバーが AWS SDK の既定の認証情報の連鎖から取る。エラーメッセージのロールが `AWSReservedSSO_AWSAdministratorAccess_*` だったので、dev サーバーにプロファイルは届いている。

#### ストリーミングの証拠

- 短い発話（「日本の首都を一文で答えてください。」）を 1 回送った。`text-delta` が +2,491 ms（8 文字）と +2,493 ms（3 文字）の 2 つ届き、`done` が +2,507 ms。返答は「日本の首都は東京です。」。
- 計測用の発話（下記）の最後の 1 回（run 6）: `text-delta` 36 個（1〜8 文字）、`done` の本文は 124 文字（`text-delta` の文字数の合計と一致）。到着時刻（送信からの ms）は、最初が +1,784、そのあと +1,877〜1,884 に 9 個、+2,077〜2,084 に 8 個、+2,228〜2,237 に 8 個、+2,377〜2,389 に 8 個、+2,462〜2,469 に 3 個、`done` が +2,493。1 つの塊のように届くのではなく複数回に分かれて届いた。なお、この内訳（最初の 1 個 + 9 + 8 + 8 + 8 + 3）の合計は 37 で、`text-delta` 数は 36 と記録している。生のログは残していないので、どちらが正しいかは判断できない（どちらの数字も変えていない）。計測の表の `text-delta` 数は run 1〜6 の順に 37 / 41 / 36 / 48 / 53 / 36 で、run 6 は最小値（run 3 と同値）。run 6 が 37 だったとしても、中央値（39）は変わらず、範囲の下端も run 3 の 36 のままで、判断への影響はない。ただし約 150 ms ごとに数個まとまって届いており、モデルの出力の粒度なのか、Realtime のバッチなのかは切り分けていない（未確認）。

#### 計測

- 条件: モデルは `jp.anthropic.claude-haiku-5-5`、`streamingMode: 'token'`、ローカルの `npm run dev`（Realtime とデータはローカルのモック。Bedrock だけが実物）、1 台のマシン（Apple M2。今回 `sysctl -n machdep.cpu.brand_string` で確認）、Chrome（Playwright MCP）、回線の種類は未確認。発話は「東京の魅力を3文で紹介してください。」で、毎回新しい会話（`newConversation()`）で連続 6 回。計測はページの `performance.now()` で、各回の送信処理の開始（`chat.sendMessage` 直前の `performance.now()`）から、最初の `text-delta` チャンク到着、`done` チャンク到着まで。
- この時間には、会話の作成（`createConversationId`）、Realtime channel の取得と購読、`stream` 呼び出しの往復が含まれる（Bedrock だけの時間ではない。内訳は未計測）。
- 返答の長さは、124〜188 文字（中央値 140）。

| run | 最初のトークン ms | 完了 ms | `text-delta` 数 | 返答の文字数 |
|---|---|---|---|---|
| 1 | 2,196 | 2,934 | 37 | 138 |
| 2 | 2,102 | 2,967 | 41 | 142 |
| 3 | 1,849 | 2,571 | 36 | 135 |
| 4 | 1,858 | 2,858 | 48 | 143 |
| 5 | 1,852 | 2,951 | 53 | 188 |
| 6 | 1,784 | 2,493 | 36 | 124 |
| 中央値 | 1,855 | 2,896 | 39 | 140 |

- 6 回とも成功。run 1 は 6 回の中で最初のトークンが最も遅い（2,196 ms）が、他の回との差は 100〜400 ms で、これが初回のオーバーヘッドかどうかは 1 回の観測では言えない（dev サーバーとページは、この計測の前に別の呼び出しを済ませていた）。
- 値のばらつきは、最初のトークンが 1,784〜2,196 ms、完了が 2,493〜2,967 ms。6 回、1 種類のプロンプトでの値なので、一般化はしない。

#### `model.local` の切り替え（文書で読んだだけ。ここでは試していない）

- `model.local` を省略すると、ローカルでは `canned`（キーワードで返すモック）が自動で使われる。Bedrock を呼ぶのは、`local` に `{ provider: 'bedrock', ... }` を書いたときだけ。
- `local` には配列も書け、先頭から順に使えるものが選ばれる。`canned` は暗黙で最後に足される。
- `{ provider: 'canned', cannedResponses: { 'キーワード': '返す文' } }` で返答を固定できる（キーは最新の発話に含まれる語句。大文字小文字は区別されず、辞書の最初に一致した項目が使われる）。JSON ファイルのパスも指定できる。これを E2E テストに使えるかは Task 0.4 で確かめる。

#### 配線の記録

- バックエンド（文書で読み、実行で確認）: `new Agent(scope, id, { model: { deployed, local }, systemPrompt, streamingMode: 'token' })`。`streamingMode` の既定は `'block'`（完成した塊ごとに配信）で、`'token'` にするとより細かく配信される、と文書にある（`'block'` の挙動は文書の記述で、実行していない）。今回は `'token'` だけで試し、返答は 1〜8 文字の小さな `text-delta` が多数に分かれて届いた。`'block'` との比較はしていない。
- RPC は `ApiNamespace`（`spikeAgentApi`）に `createConversationId`、`stream`、`getChannel`、`getConversation` を置いた。`stream` は `agent.stream(message, { conversationId, channelId, userId })` を呼んで `channelId` だけ返す。応答のチャンクは Realtime の channel に流れる。
- フロントエンド: `@aws-blocks/bb-agent/client` の `createChat` と `realtimeTransport`。`getChannel` が返す `{ channel }` に `channel.subscribe(...)` を呼ぶ。`onChunk` で `text-delta` / `done` / `error` を 1 つずつ受ける。`sendMessage` は送信が済むと返り、応答の完了は返らない。完了は `done` / `error` のチャンクで待つ（最初の実装は `sendMessage` の返りを完了と見て、時間が空になった）。
- `@aws-blocks/bb-agent` は `package.json` の直接の依存ではなく、`@aws-blocks/blocks` 経由で入ったもの。文書どおりの import でビルドと型チェックは通った。直接の依存として宣言するかは Task 0.7 で決める。
- ローカルの `stream()` はモック（Realtime の channel にチャンクを流す）で動くが、デプロイ後は AgentCore Runtime を呼ぶ別の実装になる、と文書にある。ローカルの結果がデプロイ後にそのまま当てはまるかは未確認。

制限: 1 台のマシン、Chrome 1 種、ページ計測は Haiku 5.5 の `jp.` プロファイルのみ、計測用の発話は 1 種類（6 回）と短い発話 1 回。Sonnet 4.6 のページ経由の応答時間・品質は未計測（上の単発確認の時間は比較できない）。Haiku の応答の品質（日本語の指示への従い方、ツール呼び出しの精度）はこのスパイクでは見ていない（返答の内容も数行を見ただけ）。

### 判断

**合格。** 合格の目安「ローカルで応答が流れる」は、`jp.anthropic.claude-haiku-5-5` で満たした。応答は `text-delta` が複数回に分かれて届き、最初の `text-delta` までの中央値は 1.9 秒、完了までは 2.9 秒（上の条件・6 回）。

**決定（アカウント所有者、2026-11-17）: このプロジェクトは全てに Haiku、`jp.anthropic.claude-haiku-5-5` を使う。** この決定は上の結果を見たうえでの所有者の判断で、このスパイクの測定が決めたものではない。このセクションの計測値は、そのモデルについてのものである。設計の当初の前提だった Sonnet 4.6 の値は、ページ経由では取っていない。

決定から生じる、まだ決まっていないこと:

- モデル ID は明示的に書く必要がある。Blocks の定数は `global.` プロファイルを指し（`BALANCED` = Sonnet 4.6、`FAST` = Haiku 4.5）、このアカウントでは拒否されたため、使えない。設定で差し替えられるようにするかどうかは Task 0.7 で決める。
- SQL や地図スタイルの生成での Haiku の回答品質とツール呼び出しの精度は未検証。主題図の生成に足りるかは Task 4.5 で評価する。
- デプロイ後の実行ロールが同じプロファイル（`jp.anthropic.claude-haiku-5-5`）を呼べるかは未確認。サンドボックスのデプロイが必要なので、このスパイクでは試していない。SCP が全プリンシパルに及ぶなら同じ結果になるはずだが、これは推測で、SCP の本文は未読。
- 上の「だめな場合の代替」にある「サンドボックスで検証」も、同じ拒否に当たる可能性がある。SCP はアカウント全体に適用されるはずだが（推測。本文は未読）、確かめていない。サンドボックスが抜け道になるとは言えない。

## まとめ（採用方式と見直した設定値）

記入日 2026-11-17（Task 0.7）。ここに書く方式と値は、ユーザーが承認するまでは**提案**である。ただしモデル（Haiku 5.5）はユーザーの決定で、提案ではない（スパイク C の「判断」）。数値の根拠は各スパイクの節にある。ここでは判断、支える数値、設計への影響だけを書く。計測は 1 台の Mac・Chrome 1 種・各 3〜10 回で、目安として読むこと。

### 採用方式

| 項目 | 採用方式 / 設定値 | 支える数値 | 設計からの変更 |
|---|---|---|---|
| LLM | Claude Haiku 5.5、モデル ID `jp.anthropic.claude-haiku-5-5`（`jp.` 推論プロファイル）。`model.local` と `model.deployed` の両方に明示する（決定） | `global.` の Sonnet 4.6 と Haiku 4.5 は組織の SCP で拒否。`jp.` の Haiku 5.5 は、ローカルでもデプロイ後の実行ロールでも呼べた。ローカルの 6 回で、最初のトークンまで中央値 1,855 ms、完了まで 2,896 ms | Sonnet 4.6（`BedrockModels.BALANCED`）の前提を、要件・設計・タスクから外す。モデル ID は `shared/config.ts` に 1 か所だけ書く |
| ツールの実行 | 方式 A（ブラウザ実行のツールを、Agent の `interrupt()` で往復）で確定 | 往復 1 回の追加時間は中央値の差で、ローカル 938 ms、デプロイ後 1,010 ms（各 10 回。目安は 3 秒以内）。返した結果の照合は 35/35 一致 | 設計の骨格は変わらない。下の「interrupt の運用規則」を設計に取り込む |
| データの読み取り | GeoParquet を**ファイルごとに全体取得**（署名付き URL を `fetch`）し、`registerFileBuffer` で登録する。Range 読み取りは使わない | 検証用ファイルは最大 4,394,714 B（約 4.4 MB）。DuckDB の全体読み込みで、1 クエリ 189〜398 ms（`fetch` での取得もほぼ同じと見込む【推定】） | 設計 2.2 の「Range と全体取得の自動判定」をやめ、全体取得だけにする。`accessMode` は不要 |
| DuckDB-WASM の配信 | wasm（`eh`、約 34 MB）をアプリのバケットに置き、署名付き URL で読み込む（測った経路）。バージョンは 1.32.0 に固定 | プレビューの前面は wasm を返せない（HTTP 500、原因は Lambda のメモリ不足）。バケットから読んだ初回の初期化は中央値 2,575 ms | 設計 2.2 に配信経路を追加。CloudFront 前面からの配信は未確認 |
| クエリの取り消し | `send()` で投げて `cancelSent()`。猶予内に返らなければ `worker.terminate()` + 再初期化 + 再登録 | `cancelSent()` は止まるまで 12〜18 秒（遅いクエリ 1 種類）。`query()` は止まらない。`terminate` 後の復旧は約 1.6 秒 | 設計 2.2 の「未検証」を実測に置き換える |
| 設定の固定 | 必要な `SET` をすべて済ませてから `SET lock_configuration = true`。ガードは lock に頼らない | lock 後も `registerFileBuffer` と `CREATE VIEW` はできる。`SET` は拒否され、`LOAD`・`INSTALL`・外部 URL の読み取り・`COPY TO` は止まらない | SQL ガード（設計 2.2）を必須とする。`allowed_paths` などは Task 2.2 で確かめる |
| アクセス制御 | サインアップを不可能にする（ユーザーの指示）。`AuthBasic` のまま、`authApi` を自前の名前空間にしてサインインとサインアウトだけを受け、ユーザーは運用者だけが作る。利用許可ユーザーの一覧（`AppSetting`）は 2 層目として残し、アプリの全 API メソッドを守る（Phase 1 開始前に変更。ユーザーの指示: サインアップ不可） | 一覧は、デプロイ済みで、未サインイン 401、許可前 403、許可後に通る。自前の `authApi` と、デプロイ先のユーザー作成は未確認（Task 1.1、Task 5.3） | 設計 6.1 に手順とリスクを追記 |
| `shared/` | リポジトリ直下のまま。デプロイ済みのバックエンドが設定変更なしで取り込める | 型検査、ビルド、開発サーバー、デプロイのすべてで通った | 設計 2.1 と Task 1.1 から `$shared` の別名を外す |

#### interrupt の運用規則（方式 A を実装に落とすための決まり）

スパイク A の「設計への影響」を、設計に取り込む形にまとめた。

1. ツールのハンドラーは `interrupt()` を呼ぶだけにする。再開のたびに先頭から再実行される【実行】ので、前に副作用を置かない。1 つのハンドラーで `interrupt()` を 2 回呼ばない（`id` が衝突する見込み【ソース】。動かしていない）。
2. `name` はツールごとの固定でよい。`id` に `toolUseId` が入り、同じ入力を順番に 2 回、並列に 2 回呼んでも衝突しなかった。ブラウザは `name` ではなく `interruptId` で応答と対応させる。
3. `response` はサーバーで `String()` にされるので、JSON 文字列で返し、ハンドラーで `JSON.parse` して zod で検証する。
4. `conversationId` は必須にする。`getPendingInterrupts`、`resume`、`stream`、`getChannel`、`getConversation` のすべてで所有者を確認する（Agent ブロックは確認しない【ソース】）。チャンネル名は、サーバーが発行した会話 ID にする。
5. 処理中の状態は UI が持ち、ターンの途中や保留中の interrupt がある間は入力をブロックする。`onInterrupt` の中で即座に返すと、再開中の `loading` が `false` に戻り、`createChat` の二重送信ガードが効かない【実行、canned 各 1 回】。
6. 失敗は `error` チャンクだけでなく `onError` にだけ届くことがある（`resume` の RPC が拒否された場合。`error` も `done` も来ない）。どちらでも処理中の状態を終える。
7. 保留中の interrupt を捨てる手段は観察していない。保留中に新しいメッセージを送ると、`getPendingInterrupts` から見えなくなるが、古い ID では再開できる（見えないが生きている）。方針は、保留があるうちは新しいメッセージを送らせず、捨てたいときは全件に `SESSION_RESET` を返すこと。モデルはエラーのツール結果を受け取るだけで、別のツールを呼ぶ可能性があるので、ターンが終わるかは**未確認**（Task 4.5 で確かめる）。捨てたターンで続けて呼ばれたツールにも、同じく `SESSION_RESET` を返す。会話を作り直すときは新しい会話 ID にする。
8. 並列のツール呼び出しは 1 つの `interrupt` チャンクに配列で届く。ブラウザでの実行は並列でよいが、応答は全部そろえて 1 回の `sendMessage({ interruptResponses })` で返す。片方だけ返すと、残りだけが再度届く。再開で `tool-call` チャンクは再送されるので、実行状況の表示では重複を除く。
9. 往復の回数の上限（`maxLlmCalls`、`maxToolIterations`）は再開をまたいで数えられ、超えると `error` チャンクが届く。順番の単独のツール呼び出しでは、1 回につきどちらも 1 ずつ消費した（並列の呼び出しでの消費は未確認。1 ターンのモデル呼び出しは、ツールの往復の数 + 1 になる）。
10. ブラウザから返す結果は、モデルに渡す要約だけにする。実測した上限は、応答が約 200 KB（UTF-8、エスケープ後。ASCII で 204,500 文字まで一致、204,700 文字以上は `ItemTooLargeException`）。応答は `approval` 行に 2 回保存され、1 行 400 KB が上限になる。クエリの結果そのもの（地物）はブラウザに残し、モデルには列、件数、先頭の行、階級などの要約だけを返す。デプロイ後の転送の上限は**未確認**。ツールの戻り値側（`tool-result` 行の `toolOutput`）にも同種の上限がありうるが、動かしていない。
11. E2E テストは `canned` モデルで、ツール呼び出し → interrupt → 再開 → 完了の 1 往復まで通る（Bedrock は呼ばない）。入力はスキーマの placeholder（`cannedExamples` で変更可）、結果の後は固定文で終わるので、順番に複数回のツールを要するシナリオは実モデルで確かめる。
12. ローカルの開発サーバーは、RPC の引数をそのまま標準出力に出す。開発ログに発話やクエリ結果が残る。

#### データの読み取りを全体取得にする理由

- 検証用ファイルは小さい。市区町村 1,641,500 B、駅 260,089 B、学校 1,884,180 B、粗い市区町村 420,379 B、学校の行グループ違い 9 本は 3,368,138〜4,394,714 B。最大は 4,394,714 B である。署名付き URL からの DuckDB の全体読み込み（`registerFileURL` + `allowFullHTTPReads`。HEAD の 403 を含む 3 リクエスト）は 1 クエリ 189〜398 ms で、ほぼダウンロード時間だった。`fetch` + `registerFileBuffer` での時間は測っておらず、ほぼ同じと見込む【推定】。本番用の 6 ファイル（地価、鉄道、都道府県を含む）の大きさは未測定で、Task 1.3〜1.5 で記録する。
- 署名付き URL では、`registerFileURL` の設定だけでは Range 読み取りに入れない。DuckDB-WASM 1.32.0 は、サイズを知るために `Range: bytes=0-` の HEAD を送り、**206 と `Content-Length`** で答えたときだけ Range 読み取りに入る。署名付き GET URL の HEAD は 403 になる。しかも `bytes=0-0` の GET の応答では `Content-Range` ではなく `Content-Length` を `/` で分割してサイズを読むので、ここからも取れない。設定の全組み合わせで、open の失敗か全体読み込みだった。
- Worker 内で HEAD を `GET Range: bytes=0-0` に置き換える経路 (a) は動いた（転送量は東京都の絞り込みで全体の 9〜53%）が、時間は全体ダウンロードより長かった（`muni_code` 順 2,048 行の東京都で 762 ms 対 291 ms。同期 XHR を 1 リクエストあたり 60〜100 ms で順に往復するため）。1.32.0 の `openFile` の内部に依存し、版が変わると壊れる恐れがある。
- したがって、行グループの大きさと並び順は性能の設定ではなくなる。既定は 2,048 行、点データは属性（`muni_code`）順、zstd のままにする。
- 各ファイルはセッションごとに 1 回だけ取得し、登録したままにする。署名付き URL は発行のたびに違う（同じ秒に作った場合を除く）ので、HTTP キャッシュには頼らない。`registerFileBuffer` は渡したバッファを転送（detach）するので、`terminate` 後の再登録用に複製を控える（再登録とビュー作成は約 171 ms）。

「今は採用しない。ファイルが数十 MB になったら見直す」代替案:

- Worker 内の置き換え（経路 (a)）。ファイルが大きければ、転送量の差が時間の差に勝つ可能性がある【推定。測っていない】。
- `Range: bytes=0-` の HEAD に **206** と `Content-Length` で答える配信経路（CloudFront や Lambda のプロキシなど）。比較用のローカルサーバー（HEAD に 206 で答える）では Range 読み取りが期待どおりに働いた。S3 や CloudFront 上では**未検証**。

#### DuckDB-WASM の配信と初期化

- 事実: `duckdb-eh.wasm` は 34,242,586 B。ホスト型プレビューの前面（API Gateway）は返せず HTTP 500（asset proxy の Lambda の `Runtime.OutOfMemory`）。バケットから署名付き URL で読むと、初回の初期化（Worker 起動 + wasm + `INSTALL`/`LOAD spatial`）は中央値 2,575 ms（4 コンテキスト）、同じページでの再初期化は 1,562 ms。wasm はキャッシュされず毎回約 34 MB（この回線で 616〜1,259 ms。ヘッドレスの Chrome での観察で、原因は【推定】）。ローカルの開発サーバーでは初回の中央値 3,147 ms。CloudFront 前面からの配信は**未確認**。
- 提案: wasm を、アプリのバケットに置いて署名付き URL で読み込む（測定済みの経路）。ローカルのモックでも同じ経路にして、コードを 1 本にする（スパイクのローカル計測は Vite の `?url` で、モックのバケットから 34 MB を配信する経路は試していない。ユーザーに確認する点 2）。wasm のオブジェクト名にはバージョンを含め（インストール済みのパッケージの版から導く）、署名付き URL は `getDatasetSources` が返す。アップロードできるファイル名には、wasm をカタログとは別の定数として加える。サンドボックスのプレビューは API Gateway 前面なので、CloudFront の確認には使えない。使う wasm は `eh` のみ（対象は最新の Chrome）。アプリのオリジンからの配信は、本番のホスティング（`npm run deploy`）を最初に行うときに測り直す。
- 設計に残す値: 初期化の実測（上記）、キャンセルの `worker.terminate()`、DuckDB-WASM の版 1.32.0（`@duckdb/duckdb-wasm` の `latest` は開発ビルドなので使わない。エンジンは v1.4.3、`eh` バンドル）。

#### アクセス制御

- 利用許可ユーザーの一覧は `AppSetting`（JSON の文字列配列、既定 `[]`、未設定または不正なら全員拒否）に持つ。アプリの**全 API メソッド**が、`requireAuth` の次に一覧を確認する。再デプロイなしで `aws ssm put-parameter --overwrite` により書き換えられ、次の呼び出しから効く。公開の書き込みメソッドは作らない。サインアップ不可に加わる 2 層目の防御で、ユーザーを削除せずに利用を止める手段でもある（位置づけは Phase 1 開始前に変更。ユーザーの指示: サインアップ不可）。
- サインアップは不可能にする（Phase 1 開始前に変更。ユーザーの指示: サインアップ不可。旧: 開放のサインアップを許可リストだけで守る案）。`AuthBasic` にサインアップを止める設定はない（文書とソースを読んだ範囲。実行はしていない）。`auth.createApi()` は使わず、`authApi` をアプリ自身の `ApiNamespace` として同じ名前で export する。`auth.createApi()` と非推奨の `auth.buildApi()`（`signUp` を公開する名前空間を返す）のどちらの戻り値も export せず、export する API の名前空間は `api` と `authApi` だけにする（Task 1.1 で、生成されたクライアントに他の名前空間が出ていないことを確認する）。メソッドは `getAuthState` と `setAuthState` だけで、`setAuthState` が受けるのはサインインとサインアウトだけ。ほかのアクション（サインアップ、その確認、パスワード再設定、未知のもの）は、何も作らず、セッションもそのままにして、エラー付きで現在の認証状態を返す（未サインインの呼び出しなら、未サインイン状態）。未サインイン状態にはサインインのアクションだけを載せるので、`Authenticator` と `AccountMenuBar` にサインアップのフォームは出ない。ブロックの公開メソッド（`auth.signIn`、`auth.signOut`、`auth.getCurrentUser`）の上に作るので、Cookie とロックアウトはブロックのまま。型は `@aws-blocks/blocks` から取り、`any` / `unknown` は使わない。UI で隠すだけでは、サーバーが手作りの呼び出しを受けてしまう。`hideActions` は `AccountMenuBar` のモーダルに届かない。`auth` のインスタンスは、非 export のモジュールに置くのが望ましい（置けるかは Task 1.1 で確認。フレームワークが要求するなら export してよい）。
- ユーザーは運用者だけが作る。ローカルと E2E は、`auth.signUp` を直接呼ぶスクリプトで、dev サーバーを止めて作る（この方法は未確認。調査では「手段（未検証）」。Task 1.1 で確かめ、動かなければ止めて報告する。Phase 1 開始前に変更。ユーザーの指示: サインアップ不可）。デプロイ先は、運用者が自分の AWS 認証情報でブロックのテーブルにユーザー行を直接書く（bcrypt、コスト 12、パスワードポリシーの検査、既存ユーザーは上書きしない）。デプロイ先の経路は未確認で、Task 5.3 で確かめる。動かなければ止めて再検討する（代替は `AuthCognito` の自己サインアップ無効。ローカルの mock が手作りのサインアップを通すので試験しにくく、ユーザーを削除しても既存のセッションが有効なため、却下した）。
- 手順: ① 運用者がユーザーを作る。② 運用者がそのユーザー名を一覧に入れる。以前の順序の決まり（先にサインアップする）は、他の人が名前を登録できなくなったので不要。ユーザー行を削除しても、次の要求からアクセスを失う（ブロックが要求のたびにユーザーを引く。ソースを読んだ範囲）。
- ユーザー名を、Realtime のチャンネル名の接頭辞に生では使わない。`validateChannelToken` の接頭辞の一致により、ユーザー名 `u` が `u/...` のチャンネルを購読できる（テンプレートの Todo API の場合、公開される内容は操作名と ID だけ）。チャンネルは、サーバーが発行した会話 ID にする。
- 残るリスク: 一覧に入った利用者は、1 ターンの上限（`maxLlmCalls`）以外の回数制限なしで Bedrock を呼べる。署名付き URL は有効期間中は持ち主を問わず使える。デプロイ先のユーザー作成の経路は未確認（Task 5.3）。未確認の点は、自前の名前空間が AWS 上で動くこと、直接書いたユーザー行でサインインできること（どちらも Task 5.3）、`auth` を非 export のモジュールに置けること（Task 1.1）、ローカルのスクリプトから `auth.signUp` でモックの保存先に書け、開発サーバーがそのユーザーでサインインを通すこと（Task 1.1）。（Phase 1 開始前に変更。ユーザーの指示: サインアップ不可。旧: 開放のサインアップが残るリスク）
- 注意: `docs/spikes.md` の識別子（アカウント、管理アカウント、組織、SCP、SSO ロール名、SSO ユーザー名＝メールアドレス）は、`<アカウント ID>` などのプレースホルダーに置き換えた（初めてコミットする前に実施。コミットした履歴は残るため）。公開の前に、`docs/` にアカウント、組織、ユーザーの識別子（メールアドレスを含む）が残っていないことを再度確認する。
- CORS の許可オリジン: スパイク B-2 は、実アプリでは `*` ではなく正確なオリジンを書くことを勧めていたが、**採用しない**。署名付き URL は CORS に関係なく、どの HTTP クライアントからも読める持ち主不問の資格情報で、オリジンを絞ってもデータの保護は増えない。一方、ホスティングのオリジンを書くには 2 段階のデプロイが要り、プレビューの URL が変わるたびに壊れる。`GET`/`HEAD` の全オリジンのままにする（ユーザーに確認する点 8）。

### 見直した設定値（提案）

設計 9.2 の設定表に対する変更。値は `shared/config.ts` に集める。

| 設定 | 設計の値 | 提案 | 根拠 |
|---|---|---|---|
| モデル ID | Blocks の既定（Sonnet 4.6） | `jp.anthropic.claude-haiku-5-5` | 決定（ユーザー、2026-11-17） |
| ツール結果の最大サイズ | 16 KB | 16 KB のまま。単位は応答の JSON 文字列の UTF-8 バイト数。1 回の応答でまとめて返す全件の合計にも上限を置く（初期値 64 KB） | 実測した上限は約 200 KB（ASCII）。日本語（1 文字 3 バイト）や JSON の `"`（保存時に 2 バイト）で文字数の上限はさらに低い。16 KB は実測の約 1/12 で、合計 64 KB でも 2 回保存して 128 KB 前後。並列の応答が 1 行に入るかは未確認なので、合計にも上限を置く |
| `maxLlmCalls` / `maxToolIterations` | 12 / 12 | 24 / 24 | 往復は再開をまたいで数えられ、1 回のツール呼び出しで両方が 1 ずつ減る。調べ物、レイヤー追加、スタイル、視点、SQL エラーの再試行が続くターンで 12 は余裕がない。ライブラリの既定は 20。【推定。Task 5.2 で見直す】 |
| クエリのタイムアウト | 30 秒 | 30 秒のまま。加えて、`cancelSent()` の猶予を 5 秒とし、返らなければ `worker.terminate()` で復旧する | `cancelSent()` は止まるまで 12〜18 秒かかったので、猶予内に返ることはまれとみる。復旧は約 1.6 秒 |
| ブラウザが返事を返さない場合 | （なし） | ブラウザのツール実行は、クエリのタイムアウトで必ず結果を返す。サーバー側の保留の寿命と、タブを閉じた場合の挙動は設定せず、未確認のまま Task 4.5 で確かめる | スパイク A で未確認 |
| 署名付き URL の有効期限 | 12 時間 | 1 時間（3,600 秒） | 測ったのはこの値。データファイルは使うときに取得して登録したままにし、wasm は初期化のたびに取得する。URL は `getDatasetSources` で何度でも再発行できるので、長い期限は要らない。取得の前に、保持している URL が `expiresAt` を過ぎている（または近い）なら再発行し、初期化（再初期化を含む）の前は毎回再発行する（設計 2.2） |
| 行グループの大きさ | （Task 0.6 の結果に従う） | 2,048 行、点データは `muni_code` 順、zstd | 全体取得では性能に効かない。Range 読み取りを使う場合に限り並び順の効果が大きかった（東京都の絞り込みの転送量が 2,295 KB → 312 KB） |
| 地物数の上限 | 100,000 | 100,000 のまま | 学校 56,807 点（GeoJSON 約 9.3M 文字）が通る。面と点を合わせて約 14M 文字を描いて約 2〜2.8 秒。これより大きい合計は未測定 |
| DuckDB-WASM の初期化 | 10 秒以内 | 10 秒以内のまま | 実測は最大 5.4 秒（ローカル、初回）、バケットから 2.7 秒以下 |
| ツール 1 回の依頼 | 15 秒以内（仮の目標） | 15 秒以内のまま | 定数を返すツール 1 回のターンで、デプロイ後は中央値 5,998 ms（対照 4,988 ms）。実際は SQL を書く出力と DuckDB の実行（全体取得を含む）が加わる。ローカルより約 2 秒遅い（AgentCore の起動・呼び出しとみられるが、内訳は未測定【推定】） |

### ユーザーに確認する点

1. **データの読み取り（全体取得に統一）**: 提案は、全体取得 + `registerFileBuffer`。代替は Worker 内の置き換え（Range 読み取りは動くが、このデータの大きさでは遅く、DuckDB-WASM 1.32.0 の内部に依存する）と、HEAD に 206 で答える配信経路（未検証）。費用は、ファイルが数十 MB に育つと再検討になること。
2. **DuckDB-WASM の配信**: 提案は、バケットから署名付き URL（測定済み）で、ローカルのモックも同じ経路にすること。代替は、アプリのオリジン（CloudFront）からの配信、またはローカルは Vite の `?url`・デプロイ後はバケットの 2 経路。
   費用は、署名付き URL では開くたびに約 34 MB を取り直すこと、ローカルでは `.bb-data/` を消すと wasm も消えるので再投入が要ること（モックからの配信は未試験）。
3. **値の提案**: `maxLlmCalls` / `maxToolIterations` を 24 に上げること（課金の上限が緩む）、署名付き URL を 1 時間にすること、結果の合計 64 KB、`cancelSent()` の猶予 5 秒。いずれも実測の外挿を含む。
4. **API の形の変更**: `interruptName` のハッシュをやめて固定名にすること、チャンネル名を会話 ID に固定すること（トランスポートが渡す `_channelId` は使わず、シグネチャから除く）、`conversationId` を必須にすること、`getDatasetSources` が wasm の URL も返すこと。
5. **残るリスクの受け入れ**: サインアップは、ユーザーの指示で不可能にした（上の「アクセス制御」。Phase 1 開始前に変更。ユーザーの指示: サインアップ不可）。残るのは、許可された利用者 1 人が、1 ターンの上限の範囲で Bedrock を繰り返し呼べることと、デプロイ先のユーザー作成の経路が未確認であること（Task 5.3 で確かめる）。
6. **未確認のまま持ち越すもの**（それぞれ担当のタスクで測る）: デプロイ後の応答サイズの上限（Task 5.3）、CloudFront 前面からの初回読み込み（本番のホスティングを最初に行うとき）、Chrome 以外のブラウザ（要件では対象外）、ブラウザが返事を返さない場合とタブを閉じた場合（Task 4.5）、Realtime の再接続（Task 5.3）、アイドル後の最初のターン（Task 5.3）、Haiku の SQL・スタイル生成の品質（Task 4.5、5.1）。
7. **後片付けで残っているもの**: サンドボックスはユーザーの回答を受けて破棄し（Task 0.6）、スパイク用コードは削除した（Task 0.7）。`vite.config.ts` の `optimizeDeps.exclude: ['svelte-maplibre-gl']` は実アプリでも必要なので残した。空の CloudWatch ロググループ 7 件と、ローカルのディレクトリ `.playwright-mcp/`、`data/spike/` は、ユーザーの指示を受けて削除した。ローカルにまだ残っているのは `.blocks-sandbox/`（破棄したサンドボックスのビルド出力。git 管理外）で、ユーザーが指示するまで残す（Phase 1 開始前に変更）。デプロイの後、vitest がサンドボックスのビルド出力にある第三者のテストを収集して `npm run test:unit` が失敗した。今はスクリプトの `--exclude` で除いてあり、きちんとした対応は Task 1.1 で行う。
8. **CORS の許可オリジン（`*` のまま）**: 提案は `GET`/`HEAD`・全オリジン。スパイク B-2 の勧め（正確なオリジン）は採用しない。理由は上の「アクセス制御」。代替は正確なオリジンで、費用は 2 段階のデプロイと、URL が変わるたびの修正。
