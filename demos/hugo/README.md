# Hugo Demo

## Start Demo Website

```bash
cd demos/hugo
hugo server -D --bind 127.0.0.1 --port 1314
```

Pages:
- /
- /pricing/
- /faq/
- /user-agreement/
- /privacy-policy/
- /posts/

## Install and Run OpenVila in This Folder

### Using linked CLI (`openvila`)

```bash
cd demos/hugo
openvila init
openvila scan
openvila install --apply
openvila run --port 3905
```

### Without link (run local source)

```bash
cd demos/hugo
node ../../src/index.js init
node ../../src/index.js scan
node ../../src/index.js install --apply
node ../../src/index.js run --port 3905
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
