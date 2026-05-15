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
openvila run --port 3800
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
openvila run --port 3800
```

If you do not want `npm link`, run from this repo root with explicit path:

```bash
node src/index.js init
node src/index.js scan
node src/index.js install --apply
node src/index.js run --port 3800
```

## Commands

```bash
/ui
/init [--force]
/scan
/install [--apply] [--all] [--attach-start]
/action list
/action create do_complaint
/action test do_complaint --payload '{"url":"/page/123"}'
/vila list
/vila install demo --file ./demo-vila.json
/channel set telegram --bot-token xxx --chat-id yyy
/channel set feishu --webhook https://open.feishu.cn/...
/run --port 3800
```

Direct command mode is also supported:

```bash
openvila init
openvila scan
openvila run
```

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
      topics/
      raw/
    actions/
      .venv/
      *.py
    vilas/
    logs/
      review-queue.json
    widget.html
    widget.js
```

`.openvila/.gitignore` ignores local cache/runtime artifacts (logs, action venv, python cache), while keeping editable knowledge and action files available.

## LLM Environment

OpenVila does not proxy model requests. It calls your endpoint directly:

```bash
export openvila_llm_endpoint="https://your-llm-endpoint"
export openvila_llm_api_key="your-api-key"
export openvila_llm_model="deepseek-chat"  # optional
```

When CLI starts, it checks:
- whether `.openvila/` exists (if missing, it asks for `y/n`; `y` creates runtime, `n` exits)
- whether `openvila_llm_endpoint`, `openvila_llm_api_key`, and `openvila_llm_model` are available (env first, then config)

If missing and you are in TTY, OpenVila asks for input and saves values into `.openvila/config.yaml`.

`openvila_llm_endpoint` can be either:
- full path (for example `.../v1/chat/completions`)
- base URL (OpenVila will append `/v1/chat/completions`)

## Demos

Use demo websites under `demos/`:

- `demos/static`: static HTML website
- `demos/flask`: Flask website (`templates/` included)

Both demos include pages for User Agreement, Pricing, FAQ, and Privacy Policy.

## Security Model

- Action files can only be created by owner via CLI (`/action create`).
- User action requests from chat are queued as `pending`.
- Owner must approve requests using owner token APIs.

`/run` prints owner token for:
- `GET /owner/requests`
- `POST /owner/approve`
- `POST /owner/reject`
