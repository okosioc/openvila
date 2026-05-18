# Static Demo

## Start Demo Website

```bash
cd demos/static
python3 -m http.server 8080
```

## Install and Run OpenVila in This Folder

### Using linked CLI (`openvila`)

```bash
cd demos/static
openvila init
openvila scan
openvila install --apply
openvila run
```

### Without link (run local source)

```bash
cd demos/static
node ../../src/index.js init
node ../../src/index.js scan
node ../../src/index.js install --apply
node ../../src/index.js run
```

## Real Project Folder Commands (reference)

```bash
npm install -g openvila
cd /path/to/your-website
openvila init
openvila scan
openvila install --apply
openvila run
```
