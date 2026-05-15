# OpenVila Demos

This folder contains two website demos for local testing:

- `static/`: plain HTML pages
- `flask/`: Flask app with template pages

Each demo includes pages for:
- user agreement
- pricing
- FAQ
- privacy policy

## CLI Setup Options

### Option A: linked CLI (recommended for demo testing)

In repo root:

```bash
npm install
npm link
```

Then in each demo folder, use `openvila ...` directly.

### Option B: no link, run local source directly

In demo folders, replace `openvila` with `node ../../src/index.js`.

## Commands Per Demo Folder

### demos/static

```bash
cd demos/static
python3 -m http.server 8080
```

In another terminal:

```bash
cd demos/static
openvila init
openvila scan
openvila install --apply
openvila run --port 3901
```

No-link equivalent:

```bash
cd demos/static
node ../../src/index.js init
node ../../src/index.js scan
node ../../src/index.js install --apply
node ../../src/index.js run --port 3901
```

### demos/flask

```bash
cd demos/flask
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

In another terminal:

```bash
cd demos/flask
openvila init
openvila scan
openvila install --apply
openvila run --port 3902
```

No-link equivalent:

```bash
cd demos/flask
node ../../src/index.js init
node ../../src/index.js scan
node ../../src/index.js install --apply
node ../../src/index.js run --port 3902
```

## Real Project Folder Commands

After you install from npm:

```bash
npm install -g openvila
cd /path/to/your-website
openvila init
openvila scan
openvila install --apply
openvila run --port 3800
```
