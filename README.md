# OpenVila (MVP)

OpenVila is a local REPL tool for independent site owners.
It supports:
- scanning website content into a markdown knowledge base
- installing a chat widget
- creating and approving owner-only actions
- managing vilas
- configuring owner channels (Telegram/Feishu)
- running a local chat service

## Install OpenVila CLI

### Real website project (recommended, after npm publish)

```bash
npm install -g openvila
```

Then in your website source directory:

```bash
openvila
# or openvila ui
```

In the Ink manager UI, use the keyboard to manage OpenVila:
- header: ASCII logo + version + runtime status
- bottom line: input prompt for text and commands
- press Enter: submit input and show response/logs
- commands must start with `/`, for example `/init`, `/scan`, `/install --apply`
- when input starts with `/`, the UI shows command suggestions in real time
- quit with `/exit` or `Ctrl+C`

You can still run direct commands:

```bash
openvila init
openvila scan
openvila install --apply
openvila run
```

### Local source mode (for developing/testing this repo)

In this repository root:

```bash
npm install
npm link
```

Then in any target website directory (including demos):

```bash
openvila init
openvila scan
openvila install --apply
openvila run
```

If you do not want `npm link`, run from this repo root with explicit path:

```bash
node src/index.js init
node src/index.js scan
node src/index.js install --apply
node src/index.js run
```

## Commands

```bash
/ui
/init [--force]
/scan [--yes] [--dry-run] [--reset] [--no-filesystem] [--no-db] [--no-remote]
/install [--apply] [--all] [--attach-start]
/action list
/action create do_complaint
/action test do_complaint --payload '{"url":"/page/123"}'
/vila list
/vila install demo --file ./demo-vila.json
/channel set telegram --bot-token xxx --chat-id yyy [--endpoint https://...]
/channel set feishu --webhook https://open.feishu.cn/...
/channel test telegram
/run [--port 9394]
```

Direct command mode is also supported:

```bash
openvila init
openvila scan
openvila run
```

## Human-In-Loop Scan

`/scan` uses a human-in-loop workflow:
1. LLM identifies framework and knowledge files from candidate file list
2. show scan scope for owner confirmation
3. scan selected sources (filesystem / configured DB queries / optional sitemap)
4. default incremental diff (`added/changed/deleted/unchanged`) by source hash, unless `--reset`, then LLM batch-compiles only `added/changed` sources into `knowledges/docs/*.md` (including `is_frequently_asked`)
5. update/remove compiled docs for changed/deleted sources, then regenerate `knowledges/index.md` from `index_map` every run:
   - first section lists only frequent customer concern docs
   - all sections are sorted by `docs/*` file name
6. write `knowledges/manifest.json` and print summary

Before LLM planning, `/scan` follows root `.gitignore`, skips styles (`.css`, `.scss`), and skips multimedia files such as images and videos.

`/scan` requires working LLM settings: `openvila_llm_endpoint`, `openvila_llm_api_key`, `openvila_llm_model`.

Database scan behavior:
- if `scan.database_queries` is configured, `/scan` uses configured queries
- if not configured and `scan.db_auto` is true (default), `/scan` auto-discovers SQLite/MySQL/PostgreSQL/MongoDB targets + tables/collections, asks LLM to return `knowledge_tables`, then queries only those selected items
- optional auto knobs: `scan.db_auto_max_tables` (default `6`), `scan.db_auto_query_limit` (default `80`), `scan.db_auto_max_candidate_tables` (default `360`)
- database access uses Node drivers (`sqlite3` / `mysql2` / `pg` / `mongodb`), no external DB CLI requirement

Configured query fields (per item in `scan.database_queries`):
- SQLite: `sqlite_path` + `query`
- MySQL/PostgreSQL: `engine` (`mysql` / `postgresql`) + `connection_url` + `query`
- MongoDB: `engine: mongodb` + `connection_url` + (`query` as JSON string, or `collection` with optional `filter`/`sort`/`projection`)
- Unsupported database engines are skipped; failed queries are logged and scan continues with remaining sources.

Output semantics:
- `knowledges/docs/*.md`: one compiled markdown doc per source file/row/page
- `knowledges/index.md`: index with `Frequent Customer Concerns` + `All Documents`
- `knowledges/manifest.json`: source hashes, doc map, `index_map`, frequent source list, llm call stats
- doc compile batching uses `scan.llm_compile_batch_chars` (default `100000`)
- all CLI logs are written to daily rotated logs: `.openvila/logs/debug-YYYY-MM-DD.log`
- each LLM call logs request input and response output to the same daily log file

Useful flags:
- `--dry-run`: preview plan only, no writes
- `--reset`: force full rebuild instead of incremental update
- `--yes`: skip interactive confirmation and use defaults
- `--no-db`: skip database planning and queries (configured + auto-discovered)
- `--no-remote`: skip sitemap planning and crawling

## Chating+

After `/run` starts the local chat service, it refreshes the preview assets and serves the widget at `http://127.0.0.1:<port>/widget`; `/install` is not required for this local preview. Use `/install --apply` only when you want to inject the widget script into a website page. The widget provides a session-scoped conversation with Vila. A visitor message is accepted by `POST /chat` with `202 Accepted`; the response is delivered asynchronously through Server-Sent Events (SSE).

Set the launcher and Send button background with `data-color` on the widget script, for example `<script src="/openvila/widget.js" data-color="#0f766e" defer></script>`. You can also use the URL query parameter `color=%230f766e`; without either setting, the launcher uses the default blue gradient and Send uses blue.

The widget subscribes to `GET /chat/events?session_id=...`. During knowledge-based answers, OpenVila forwards LLM output chunks through SSE so the widget renders Vila's reply as it is generated, then persists and broadcasts the completed message. Every persisted visitor, Vila, and support message is broadcast to all open widgets for the same session. OpenVila processes each session serially so messages from multiple windows retain a consistent conversation history. The widget also refreshes history every 3 seconds when SSE reconnects or is unavailable.

### Human Takeover

When a visitor asks for human support, OpenVila records a handoff and sends the recent conversation to the configured Telegram chat. This requires a configured Telegram channel and an active `/run` process:

1. Reply directly to the OpenVila handoff notification in Telegram to begin manual support for that visitor.
2. While manual support is active, later visitor messages are forwarded to the same Telegram reply thread, and owner replies are delivered to the widget in real time.
3. Reply `/close` to the handoff thread to end manual support and allow Vila to answer the visitor again.

Handoff state is stored under `.openvila/chats/`:

- `<session-id>.json`: conversation, manual-support state, and handoff events
- `telegram.json`: Telegram long-polling progress (`last_update_id`) and reply-to-session mappings

Use an owner-only Telegram chat or group: anyone who can reply to a handoff notification can answer the linked visitor. A custom Telegram endpoint must support both `sendMessage` and `getUpdates`. Feishu currently receives notifications only and does not support two-way human takeover.

Human-takeover events and Telegram long-polling input logs are written to `.openvila/logs/debug-YYYY-MM-DD.log`. Logs include session and update identifiers, routing status, message lengths, and complete visitor and Telegram reply text; bot credentials are not logged.

## Runtime Directory

`/init` creates runtime files under the current website directory:

```text
my-website/
  ...
  .openvila/
    .gitignore
    config.yaml
    knowledges/
      index.md
      manifest.json
      docs/
    actions/
      .venv/
      *.py
    vilas/
    logs/
      review-queue.json
    chats/
      <session-id>.json
      telegram.json
    widget.html
    widget.js
```

`.openvila/.gitignore` ignores local cache/runtime artifacts (logs, action venv, python cache), while keeping editable knowledge and action files available.

## LLM Environment

OpenVila does not proxy model requests. It calls your endpoint directly:

```bash
export openvila_llm_endpoint="https://your-llm-endpoint"
export openvila_llm_api_key="your-api-key"
export openvila_llm_model="deepseek-chat"
```

When CLI starts, it checks:
- whether `.openvila/` exists (if missing, it asks for `Y/n`; default is `Y` to create runtime)
- whether `openvila_llm_endpoint`, `openvila_llm_api_key`, and `openvila_llm_model` are available (env first, then config)

If missing and you are in TTY, OpenVila asks for input and saves values into `.openvila/config.yaml`.

`openvila_llm_endpoint` can be either:
- full path (for example `.../v1/chat/completions`)
- base URL (OpenVila will append `/v1/chat/completions`)

## Channel Configuration

Channels receive owner notifications when a chat action is waiting for approval.

### Telegram

1. In Telegram, open `@BotFather`, run `/newbot`, and copy the bot token it returns.
2. Start a chat with the bot, or add it to the target group and send a message there.
3. Get the target `chat_id`:

   ```bash
   curl "https://api.telegram.org/bot<bot-token>/getUpdates"
   ```

   Find `message.chat.id` in the response. Group chat IDs are usually negative numbers.
4. Save the configuration and send a test message:

   ```bash
   openvila channel set telegram --bot-token <bot-token> --chat-id <chat-id>
   openvila channel test telegram
   ```

By default, OpenVila sends requests to `https://api.telegram.org`. If this address is unavailable in your network, configure a compatible Telegram Bot API proxy or gateway as `channels.telegram.endpoint`:

```bash
openvila channel set telegram \
  --bot-token <bot-token> \
  --chat-id <chat-id> \
  --endpoint https://telegram-api.example.com
openvila channel test telegram
```

`--endpoint` must be the API base URL only: do not include `/bot<bot-token>/sendMessage`. OpenVila appends that path automatically. The endpoint is stored at `channels.telegram.endpoint` in `.openvila/config.yaml` and is reused for both notifications and test messages.

### Feishu

1. Open the target Feishu group, add a **Custom Bot**, and copy its webhook URL.
2. If Feishu bot security is enabled, use a keyword rule containing `OpenVila`; OpenVila test and notification messages include this keyword.
3. Save the configuration and send a test message:

   ```bash
   openvila channel set feishu --webhook <webhook-url>
   openvila channel test feishu
   ```

The current Feishu integration sends plain text webhook messages. Webhook signature verification is not supported yet; do not enable signature security for this bot.

You can view configured channels with `openvila channel list` and remove one with `openvila channel remove telegram` or `openvila channel remove feishu`.

## Demos

The `demos/` directory contains five local websites for testing scanning, widget installation, and chat. Every demo includes User Agreement, Pricing, FAQ, and Privacy Policy pages.

Before testing a demo, install and link the local CLI from the repository root:

```bash
npm install
npm link
```

Start the selected website in one terminal. In another terminal, run OpenVila from that demo directory:

```bash
openvila init
openvila scan
openvila install --apply
openvila run
```

If you do not use `npm link`, replace `openvila` with `node ../../src/index.js` in each demo directory. `/scan` requires the LLM configuration described above.

| Demo | Stack and coverage | Start website |
| --- | --- | --- |
| `demos/static` | Plain HTML pages and static assets | `cd demos/static && python3 -m http.server 8080` |
| `demos/flask` | Flask templates plus a seeded SQLite `posts` database | `cd demos/flask && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python app.py` |
| `demos/astro` | Astro pages for a Node-based static site | `cd demos/astro && npm install && npm run dev -- --host 127.0.0.1 --port 4322` |
| `demos/hugo` | Hugo content pages and blog posts | `cd demos/hugo && hugo server -D --bind 127.0.0.1 --port 1314` |
| `demos/wordpress` | PHP pages with WordPress-style MySQL configuration and posts | Start MySQL with `cd demos/wordpress && docker compose up -d mysql`, then run `php -S 127.0.0.1:8090` in `demos/wordpress` |

The Flask demo creates and seeds `data/blog.db` when it starts. The WordPress-style demo loads `sql/init.sql` into MySQL and exposes database-backed posts at `/posts.php`; it is useful for validating database discovery and scanning. See the README in each demo directory for routes, local-MySQL setup, and framework-specific troubleshooting.

## Security Model

- Action files can only be created by owner via CLI (`/action create`).
- User action requests from chat are queued as `pending`.
- Owner must approve requests using owner token APIs.

`/run` prints owner token for:
- `GET /owner/requests`
- `POST /owner/approve`
- `POST /owner/reject`

## Publishing

GitHub Actions publishes npm releases through the Trusted Publishing workflow at `.github/workflows/publish-npm.yml`. npm trusted publishers are configured on an existing package, so publish the first version manually, then configure a trusted publisher for package `openvila` with repository `okosioc/openvila` and workflow file `publish-npm.yml`.

To release, update `package.json` to the target version, commit the change, then push a matching tag such as `v0.1.1`. The workflow runs `npm test`, verifies that the tag matches `package.json`, and publishes with provenance.

## TODO

- Add Feishu two-way human takeover: receive owner replies, map them to visitor sessions, deliver replies to the widget, and support ending manual support.
