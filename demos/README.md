# OpenVila Demos

This folder contains five website demos for local testing:

- `static/`: plain HTML pages
- `flask/`: Flask app with template pages
- `wordpress/`: WordPress-style PHP pages with MySQL posts
- `astro/`: Astro site with policy and FAQ pages
- `hugo/`: Hugo site with content pages and blog posts

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

Readme in each demo folder for specific commands.
