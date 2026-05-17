# Flask Demo

## Start Demo Website

```bash
cd demos/flask
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

When the app starts, it auto-creates SQLite database `data/blog.db` and seeds 3 blog posts into the `posts` table.

## Install and Run OpenVila in This Folder

### Using linked CLI (`openvila`)

```bash
cd demos/flask
openvila init
openvila scan
openvila install --apply
openvila run --port 3902
```

### Without link (run local source)

```bash
cd demos/flask
node ../../src/index.js init
node ../../src/index.js scan
node ../../src/index.js install --apply
node ../../src/index.js run --port 3902
```

Flask routes:
- /
- /pricing
- /faq
- /user-agreement
- /privacy-policy
- /posts
- /posts/<slug>

## Real Project Folder Commands (reference)

```bash
npm install -g openvila
cd /path/to/your-website
openvila init
openvila scan
openvila install --apply
openvila run --port 3800
```
