# dsh-affinity-mcp

Affinity by Canva の内蔵 MCP サーバーを DSH につなぐ bundle です。インストールすると
`mcp__affinity__*` というツールが追加され、エージェントからスクリプトの実行や、
ページの画像取得ができるようになります。

## 構成

Host と Client のプラグインコードは含みません。`cordis.patch.yml` で
`@deepseek-ai/dsh-mcp-client` の行を 1 つ追加するだけの、設定のみの bundle です。

```
dsh-affinity-mcp/
├── package.json       # dsh.bundle.patch を宣言
├── cordis.patch.yml   # MCP クライアントの行を insert
├── bridge.mjs         # DSH と Affinity の間を中継する常駐プロセス
├── icon.svg
├── locale/
│   ├── en.json
│   └── ja.json
└── README.md
```

実際に動作するのは同梱の `bridge.mjs` です。DSH と Affinity の間に常駐し、
MCP のメッセージを中継します。

## ブリッジが必要な理由

理由は 2 つあります。

1 つは、Affinity の MCP が SSE 方式で通信するのに対し、DSH の MCP クライアントが
その方式に対応していないことです。直接接続しようとすると、POST /sse が 405 で
拒否されます。

もう 1 つは、Affinity が常時起動ではないことです。DSH は起動時に接続できないと
そのサーバーのツールを登録せず、切断後も 10 回で再接続を諦めます。そのため、
先に Affinity を起動していないと、後から起動しても DSH を再起動するまでツールが
表示されません。

`bridge.mjs` は stdio のプロセスとして常駐し、上流への接続をツール呼び出しのたびに
確立します。DSH から見るとサーバーは常に稼働しているため、ツールの登録は維持
されたまま、Affinity の起動直後から利用できます。

## インストール

DSH のプロファイルに bundle として追加します。

```sh
# GitHub から
dsh plugin --profile web add github:todashuta/dsh-affinity-mcp

# ローカルのディレクトリから
dsh plugin --profile web add link:/path/to/dsh-affinity-mcp

# npm から（公開後）
dsh plugin --profile web add dsh-affinity-mcp
```

`dsh` が PATH に無い環境では、CLI が入っている場所から実行してください。

インストールするとプロファイルの `package.json` に依存が追加され、
`dsh.profile.bundles` に載り、Plugins ページで有効・無効を切り替えられるように
なります。HMR が有効なプロファイルではその場で反映され、そうでない場合は次回
起動時に反映されます。

## アンインストール

```sh
dsh plugin --profile web remove dsh-affinity-mcp
```

または Plugins ページから削除します。

## 更新

- `bridge.mjs` を変更した場合は DSH を再起動してください。MCP の子プロセスは
  起動時に一度だけ起動するため、ファイルの変更だけでは反映されません。bundle の
  再インストールは不要です。
- `cordis.patch.yml` や `package.json` を変更した場合は、インストールし直してから
  DSH を再起動してください。

## 設定

パッチの `args` には `bridge.mjs` の絶対パスを記述していません。パッチの評価時に
`createRequire(baseUrl)` で自身のパッケージを解決し、その中の `bridge.mjs` を
参照しています。プロファイルの場所が変わっても、パスを書き直す必要はありません。

`bridge.mjs` が参照する環境変数は次のとおりです。

| 変数 | 既定値 | 説明 |
|---|---|---|
| `AFFINITY_MCP_URL` | `http://[::1]:6767` | 上流のベース URL |
| `AFFINITY_MCP_TIMEOUT_MS` | `120000` | ツール 1 回のタイムアウト |
| `AFFINITY_MCP_CONNECT_MS` | `10000` | 接続確立のタイムアウト |

`toolCallTimeoutMs` は `AFFINITY_MCP_TIMEOUT_MS` と同じ 120 秒に設定しています。
片方だけ短い場合、呼び出しを中断した後も bridge 側のタイマーが残ります。

## 表示メタデータ

Plugin Manager と Settings は、プラグインを有効化しなくても `locale/en.json` と
`locale/ja.json` の `meta.title` / `meta.description`、および `icon.svg` を読みます。
表示テキストを変更する場合は、2 つの言語を同時に更新してください。

## ライセンス

MIT

