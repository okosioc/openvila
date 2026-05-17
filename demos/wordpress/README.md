# WordPress-Style Demo (MySQL)

This demo uses PHP pages plus a WordPress-style `wp-config.php` to help OpenVila detect MySQL connection settings.

## Start MySQL

### Option A: Docker

```bash
cd demos/wordpress
docker compose up -d mysql
```

`sql/init.sql` is auto-loaded by MySQL container startup.

### Option B: Local MySQL (No Docker)

```bash
# start local MySQL first (example on macOS)
brew services start mysql

# initialize schema + seed data
mysql -uroot -p < demos/wordpress/sql/init.sql
```

If your local MySQL is not `127.0.0.1:3306` or credentials differ, update `demos/wordpress/wp-config.php`.

If `posts.php` shows `SQLSTATE[HY000] [2054] The server requested authentication method unknown to the client`,
run:

```sql
ALTER USER 'wordpress_user'@'%' IDENTIFIED WITH mysql_native_password BY 'wordpress_pass';
FLUSH PRIVILEGES;
```

## Start Demo Website

```bash
cd demos/wordpress
php -S 127.0.0.1:8090
```

Pages:
- /
- /pricing.php
- /faq.php
- /user-agreement.php
- /privacy-policy.php
- /posts.php (reads from MySQL `wp_posts_demo`)

## Install and Run OpenVila in This Folder

### Using linked CLI (`openvila`)

```bash
cd demos/wordpress
openvila init
openvila scan
openvila install --apply
openvila run --port 3903
```

### Without link (run local source)

```bash
cd demos/wordpress
node ../../src/index.js init
node ../../src/index.js scan
node ../../src/index.js install --apply
node ../../src/index.js run --port 3903
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
