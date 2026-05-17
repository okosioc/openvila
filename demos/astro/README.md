# Astro Demo

## Start Demo Website

```bash
cd demos/astro
npm install
npm run dev -- --host 127.0.0.1 --port 4322
```

Pages:
- /
- /pricing
- /faq
- /user-agreement
- /privacy-policy

## Install and Run OpenVila in This Folder

### Using linked CLI (`openvila`)

```bash
cd demos/astro
openvila init
openvila scan
openvila install --apply
openvila run --port 3904
```

### Without link (run local source)

```bash
cd demos/astro
node ../../src/index.js init
node ../../src/index.js scan
node ../../src/index.js install --apply
node ../../src/index.js run --port 3904
```

## Real Project Folder Commands (reference)

```bash
npm install -g openvila
cd /path/to/your-website
openvila init
openvila scan
openvila install --apply
openvila run --port 3800
```
