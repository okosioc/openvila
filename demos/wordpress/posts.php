<?php
require_once __DIR__ . '/wp-config.php';

$posts = [];
$errorText = '';
$errorHint = '';

try {
  $hostParts = explode(':', DB_HOST, 2);
  $host = $hostParts[0] ?: '127.0.0.1';
  $port = isset($hostParts[1]) ? (int) $hostParts[1] : 3306;

  $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $host, $port, DB_NAME);
  $pdo = new PDO($dsn, DB_USER, DB_PASSWORD, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);

  $stmt = $pdo->query('SELECT slug, title, summary, tags, body, published_at FROM wp_posts_demo ORDER BY published_at DESC');
  $posts = $stmt->fetchAll();
} catch (Throwable $error) {
  $errorText = $error->getMessage();
  if (strpos($errorText, "SQLSTATE[HY000] [2054]") !== false) {
    $errorHint = "Auth plugin mismatch. Re-run MySQL init SQL, or execute:\n"
      . "ALTER USER 'wordpress_user'@'%' IDENTIFIED WITH mysql_native_password BY 'wordpress_pass';\n"
      . "FLUSH PRIVILEGES;";
  }
}
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Posts - OpenVila WordPress Demo</title>
  <link rel="stylesheet" href="./assets/style.css" />
</head>
<body>
  <main class="site">
    <header>
      <h1>Posts</h1>
      <p class="tagline">Blog posts are loaded from MySQL table <code>wp_posts_demo</code>.</p>
      <nav>
        <a href="./index.php">Home</a>
        <a href="./pricing.php">Pricing</a>
        <a href="./faq.php">FAQ</a>
        <a href="./user-agreement.php">User Agreement</a>
        <a href="./privacy-policy.php">Privacy Policy</a>
        <a href="./posts.php">Posts</a>
      </nav>
    </header>

    <section>
      <?php if ($errorText): ?>
        <h2>Database not ready</h2>
        <p class="meta"><?php echo htmlspecialchars($errorText, ENT_QUOTES, 'UTF-8'); ?></p>
        <?php if ($errorHint): ?>
          <pre><?php echo htmlspecialchars($errorHint, ENT_QUOTES, 'UTF-8'); ?></pre>
        <?php endif; ?>
        <p>Run MySQL init from README, then refresh this page.</p>
      <?php elseif (count($posts) === 0): ?>
        <h2>No posts</h2>
      <?php else: ?>
        <?php foreach ($posts as $post): ?>
          <article>
            <h3><?php echo htmlspecialchars($post['title'], ENT_QUOTES, 'UTF-8'); ?></h3>
            <p class="meta">
              <?php echo htmlspecialchars($post['published_at'], ENT_QUOTES, 'UTF-8'); ?>
              · <?php echo htmlspecialchars($post['slug'], ENT_QUOTES, 'UTF-8'); ?>
            </p>
            <p><strong>Tags:</strong> <?php echo htmlspecialchars($post['tags'], ENT_QUOTES, 'UTF-8'); ?></p>
            <p><?php echo nl2br(htmlspecialchars($post['summary'], ENT_QUOTES, 'UTF-8')); ?></p>
            <p><?php echo nl2br(htmlspecialchars($post['body'], ENT_QUOTES, 'UTF-8')); ?></p>
          </article>
        <?php endforeach; ?>
      <?php endif; ?>
    </section>
  </main>
</body>
</html>
