# OpenVila

OpenVila is a local REPL tool for independent site owners.
It supports:
- scanning website content into a markdown knowledge base
- serving a chat widget
- managing vilas
- configuring owner channels (Telegram/Feishu)
- running a local chat service

## Install OpenVila CLI

### Real website project

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
- commands must start with `/`, for example `/scan`, `/run`
- when input starts with `/`, the UI shows command suggestions in real time
- quit with `/exit` or `Ctrl+C`

For a new project, first launch `openvila` (or `openvila ui`) and confirm creation of `.openvila/`. Direct commands such as `openvila scan` and `openvila run` exit with an error until the manager has initialized the directory.

After that, you can run direct commands:

```bash
openvila scan
openvila run
```

### Local source mode (for developing/testing this repo)

In this repository root:

```bash
npm install
npm link
```

In any new target website directory (including demos), first run `openvila` and confirm creation of `.openvila/`. Then run:

```bash
openvila scan
openvila run
```

If you do not want `npm link`, run from this repo root with explicit path:

```bash
node src/index.js scan
node src/index.js run
```

## Commands

```bash
/ui
/scan [--yes] [--dry-run] [--reset] [--no-filesystem] [--no-db] [--no-remote]
/vila list
/vila install demo --file ./demo-vila.json
/channel set telegram --bot-token xxx --chat-id yyy [--endpoint https://...]
/channel set feishu --webhook https://open.feishu.cn/...
/channel test telegram
/run [--port 9394] [--fork]
```

Direct command mode is also supported:

```bash
openvila scan
openvila run
```

## Human-In-Loop Scan

`/scan` uses a human-in-loop workflow:
1. on the first scan, or with `--reset`, LLM identifies framework and knowledge files from candidate file list
2. show scan scope for owner confirmation
3. write the confirmed scope to editable `.openvila/scan-plan`; later scans reuse it without LLM source planning
4. scan selected sources (filesystem / scan-plan database tables / optional sitemap)
5. default incremental diff (`added/changed/deleted/unchanged`) by source hash, unless `--reset`, then LLM batch-compiles only `added/changed` sources into `knowledges/docs/*.md` (including `is_frequently_asked`)
6. update/remove compiled docs for changed/deleted sources, then regenerate `knowledges/index.md` from `index_map` every run:
   - first section lists only frequent customer concern docs
   - all sections are sorted by `docs/*` file name
7. print summary

Before LLM planning, `/scan` follows root `.gitignore`, skips styles (`.css`, `.scss`), and skips multimedia files such as images and videos.

`/scan` requires working LLM settings: `openvila_llm_endpoint`, `openvila_llm_api_key`, `openvila_llm_model`.

### Scan Plan

After the first confirmed scan, OpenVila writes `.openvila/scan-plan`. This plain-text file is the editable scan scope. Later `/scan` runs reuse it without LLM file/table planning, while still using LLM to compile changed sources into knowledge docs. Use `/scan --reset` to regenerate and overwrite it, then fully rebuild the knowledge base.

Every interactive scan confirmation, including scan-plan mode, accepts `e` to edit the plan. OpenVila opens `$VISUAL`, then `$EDITOR`, or `vi`, validates the edited lines, and shows the updated scan scope for a second confirmation. The final `.openvila/scan-plan` is written only after confirmation.

```text
file://www/templates/public/terms-of-service.html
file://www/templates/public/contact.html
file://www/posts/*.md
mongodb://localhost:27017/demo::posts
```

Each non-empty line is one scan source:

- `file://<path-or-glob>`: a file path or glob relative to the project root.
- `<connection_url>::<table>`: one SQL table or MongoDB collection. The final `::` separates the table name, so IPv6 connection URLs work.

The initial plan contains exact LLM-selected file paths. To include future files automatically, manually add a file glob:

- `file://www/posts/*`: matches files directly inside `www/posts/`.
- `file://www/posts/*.md`: matches Markdown files directly inside `www/posts/`.
- `file://www/posts/**`: matches files inside `www/posts/` and every nested directory.
- `file://www/posts/**/*.md`: matches Markdown files inside `www/posts/` and every nested directory.

Patterns still respect `.gitignore` and supported text-file extensions. Use `*` for one path segment and `**` for recursive directories; OpenVila never adds these patterns automatically.

Examples for supported database engines:

```text
sqlite://data/site.db::posts
sqlite://data/site.db::pages
```

SQLite paths use `connection_url`: `sqlite://data/site.db` is relative to the project root, while `sqlite:///data/site.db` is an absolute path.

```text
mysql://openvila:password@127.0.0.1:3306/site::posts
postgresql://openvila:password@127.0.0.1:5432/site::posts
```

A table (MongoDB collection) listed in the scan plan is queried on every scan, so new or changed rows are included automatically. The row limit comes from `scan.db_auto_query_limit` in `config.yaml` (default `80`). Keep connection URLs with passwords in local-only files.

Database scan behavior:
- with `.openvila/scan-plan`, `/scan` uses plan mode and its listed tables
- without `.openvila/scan-plan`, `/scan` uses auto mode: it discovers SQLite/MySQL/PostgreSQL/MongoDB targets + tables/collections, asks LLM to return `knowledge_tables`, then writes the selected sources into `.openvila/scan-plan`; `--reset` forces auto mode
- optional auto knobs: `scan.db_auto_max_tables` (default `6`), `scan.db_auto_query_limit` (default `80`), `scan.db_auto_max_candidate_tables` (default `360`)
- database access uses Node drivers (`sqlite3` / `mysql2` / `pg` / `mongodb`), no external DB CLI requirement
- add or remove database tables by adding or removing `<connection_url>::<table>` lines; unsupported database engines and failed table queries are logged while other sources continue

### Knowledges

`knowledges/` is generated from the sources selected by `scan-plan`:

```text
.openvila/knowledges/
  index.md
  manifest.json
  docs/
    fs-*.md
    db_*.md
    remote-*.md
```

- `docs/fs-*.md`: one compiled document per selected filesystem file.
- `docs/db_*.md`: one compiled document per database row. OpenVila reads every field from each returned row, serializes the row as formatted JSON, then sends it to the LLM to compile into a markdown document with normalized title, summary, tags, FAQ flag, and body.
- `docs/remote-*.md`: one compiled document per sitemap page when remote scanning is enabled.
- `index.md`: generated index with `Frequent Customer Concerns` and `All Documents` sections.
- `manifest.json`: generated source hashes, source-to-document mapping, `index_map`, frequent source list, and LLM call stats; do not edit it.

Only added or changed source hashes are sent to the LLM for compilation; unchanged compiled documents are reused. Database rows are limited by `scan.db_auto_query_limit` in `config.yaml` (default `80`). Doc compilation batches use `scan.llm_compile_batch_chars` (default `100000`).

- all CLI logs are written to daily rotated logs: `.openvila/logs/debug-YYYY-MM-DD.log`
- each LLM call logs request input and response output to the same daily log file

Useful flags:
- `--dry-run`: preview plan only, no writes
- `--reset`: regenerate `scan-plan` with LLM and fully rebuild the knowledge base
- `--yes`: skip interactive confirmation and use defaults
- `--no-db`: skip scan-plan database tables and automatic database discovery
- `--no-remote`: skip sitemap planning and crawling

## Chating+

After `/run` starts the local chat service, the widget provides a session-scoped conversation with Vila. A visitor message is accepted by `POST /openvila/chat` with `202 Accepted`; the response is delivered asynchronously through Server-Sent Events (SSE).

For a Linux server, use `openvila run --fork` to detach the chat service from the current terminal. The command prints its PID; use `kill <pid>` to stop it and inspect `.openvila/logs/debug-YYYY-MM-DD.log` for startup and runtime logs.

### Widget

`/run` refreshes the preview assets and serves a live preview at `http://127.0.0.1:<port>/widget`. Open that page to inspect the widget and copy its embed snippet into your website manually.

For a local website on another port, load the script from `/run` directly:

```html
<script src="http://127.0.0.1:9394/openvila/widget.js?color=%230f766e" defer></script>
```

By default, the Widget uses the script URL origin as its chat API destination, so `host` and `port` query parameters are unnecessary. Use `data-host`, `data-port`, or the matching query parameters only to override that destination. Set the launcher and Send button background with `data-color` or `color=%230f766e`; without either setting, the launcher uses the default blue gradient and Send uses blue. `/run` allows CORS only when the website and OpenVila service use the same hostname on different ports, including local loopback aliases such as `localhost` and `127.0.0.1`.

For an HTTPS website, browsers block a direct `http://<host>:9394/...` script as mixed content. `/run` serves HTTP only, so expose it through your HTTPS reverse proxy and use a same-origin script URL:

```html
<script src="/openvila/widget.js?color=%232c7be5" defer></script>
```

For example, an Nginx site for the same domain can proxy the Widget and chat endpoints while preserving their paths:

```nginx
location /openvila/ {
  proxy_pass http://127.0.0.1:9394;
  proxy_set_header Host $host;
}

location = /openvila/chat {
  proxy_pass http://127.0.0.1:9394;
  proxy_set_header Host $host;
}

location /openvila/chat/ {
  proxy_pass http://127.0.0.1:9394;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_set_header Host $host;
}
```

The widget subscribes to `GET /openvila/chat/events?session_id=...`. During knowledge-based answers, OpenVila forwards LLM output chunks through SSE so the widget renders Vila's reply as it is generated, then persists and broadcasts the completed message. Every persisted visitor, Vila, and support message is broadcast to all open widgets for the same session. OpenVila processes each session serially so messages from multiple windows retain a consistent conversation history. The widget also refreshes history every 3 seconds when SSE reconnects or is unavailable.

### Session

Widget sessions are independent of the website's login state, cookies, and user accounts. Loading a page does not create a session. On the first trusted click of the Widget launcher, it generates a random `session-...` identifier and stores it in `localStorage` under `openvila_session_id`, then loads the welcome message and history. The same browser reuses it for the same website origin; clearing site storage, using a private window or another browser, or changing scheme/hostname/port creates a new session. Programmatic launcher clicks are ignored, though browser automation that simulates a real click cannot be reliably distinguished from a visitor.

### Languages

The Widget reads the visitor browser's `navigator.language` and sends it when creating the session. Values starting with `zh` use Chinese (`zh`); all other values use English (`en`). The chosen language is stored with the session.

System prompts use the stored session language, including the welcome message and human-takeover requested, started, notification-failed, forwarded, unavailable, and closed messages. Widget labels such as `System` and `Support` follow the same language.

Vila's knowledge-based answers are generated by the LLM and instructed to use the language of the visitor's message; they do not use the browser language rule above.

When OpenVila first sees a new session, it persists a Vila welcome message before the visitor's first message. It is shown by the Widget history and is not added again when the visitor refreshes or opens another window. Configure both welcome-message languages in `.openvila/config.yaml`:

```yaml
chat:
  welcome_message:
    zh: 您好，我是AI客服Vila，我可以根据网站的知识库回答您的问题。如果不满意我的答案，您可以直接召唤人工客服。
    en: Hello, I'm Vila, your AI customer service assistant. I can answer questions based on this website's knowledge base. If you're not satisfied with my answer, you can ask for human support.
```

Set either message to an empty string to disable the welcome message for that language.

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

On first UI launch, OpenVila asks for confirmation, then creates runtime files in the current website directory. Standalone commands such as `scan` and `run` require these files to exist:

```text
my-website/
  ...
  .openvila/
    .gitignore
    config.yaml
    scan-plan
    knowledges/
      index.md
      manifest.json
      docs/
    vilas/
    logs/
    chats/
      <session-id>.json
      telegram.json
    widget.html
    widget.js
```

`.openvila/.gitignore` ignores local log and Python cache artifacts while keeping editable configuration and knowledge files available.

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

Channels receive owner notifications when a visitor requests human support.

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

The `demos/` directory contains five local websites for testing scanning, widget preview, and chat. Every demo includes User Agreement, Pricing, FAQ, and Privacy Policy pages.

Before testing a demo, install and link the local CLI from the repository root:

```bash
npm install
npm link
```

Start the selected website in one terminal. In another terminal, first run `openvila` from that demo directory and confirm initialization. After exiting the manager, run:

```bash
openvila scan
openvila run
```

Open `http://127.0.0.1:9394/widget` and manually copy the preview page's embed snippet into the demo page you want to test.

If you do not use `npm link`, replace `openvila` with `node ../../src/index.js` in each demo directory. `/scan` requires the LLM configuration described above.

| Demo | Stack and coverage | Start website |
| --- | --- | --- |
| `demos/static` | Plain HTML pages and static assets | `cd demos/static && python3 -m http.server 8080` |
| `demos/flask` | Flask templates plus a seeded SQLite `posts` database | `cd demos/flask && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python app.py` |
| `demos/astro` | Astro pages for a Node-based static site | `cd demos/astro && npm install && npm run dev -- --host 127.0.0.1 --port 4322` |
| `demos/hugo` | Hugo content pages and blog posts | `cd demos/hugo && hugo server -D --bind 127.0.0.1 --port 1314` |
| `demos/wordpress` | PHP pages with WordPress-style MySQL configuration and posts | Start MySQL with `cd demos/wordpress && docker compose up -d mysql`, then run `php -S 127.0.0.1:8090` in `demos/wordpress` |

The Flask demo creates and seeds `data/blog.db` when it starts. The WordPress-style demo loads `sql/init.sql` into MySQL and exposes database-backed posts at `/posts.php`; it is useful for validating database discovery and scanning. See the README in each demo directory for routes, local-MySQL setup, and framework-specific troubleshooting.

## Publishing

GitHub Actions publishes npm releases through the Trusted Publishing workflow at `.github/workflows/publish-npm.yml`. npm trusted publishers are configured on an existing package, so publish the first version manually, then configure a trusted publisher for package `openvila` with repository `okosioc/openvila` and workflow file `publish-npm.yml`.

To release, update `package.json` to the target version, commit the change, then push a matching tag such as `v0.1.1`. The workflow runs `npm test`, verifies that the tag matches `package.json`, and publishes with provenance.

## TODO

- [ ] Add lightweight Markdown rendering in the Widget for bold text, lists, and links.
- [ ] Let the Widget customize visitor-message bubble backgrounds and show message timestamps.
- [ ] Add Feishu two-way human takeover: receive owner replies, map them to visitor sessions, deliver replies to the widget, and support ending manual support.
- [ ] Add scan-plan database filters with `field_comparator` query parameters, such as `postgresql://.../site::posts?status_eq=published&published_gte=2026-01-01`, and translate them into parameterized SQL or MongoDB filters. For example, when WordPress is detected, default its posts source to `post_status_eq=publish`.
- [ ] For documentation frameworks such as Hugo and Astro, infer content directories and add scan-plan glob rules automatically; mark files matched by those rules with `*` in the UI scan-scope list.
- [ ] Let `/run` schedule a daily `/scan --yes` to refresh the knowledge base automatically.
- [ ] Let `/run` send a daily summary report of all visitor questions and Vila answers from that day.
