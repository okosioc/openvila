<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FAQ - OpenVila WordPress Demo</title>
  <link rel="stylesheet" href="./assets/style.css" />
</head>
<body>
  <main class="site">
    <header>
      <h1>FAQ</h1>
      <p class="tagline">Common questions from site owners.</p>
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
      <h2>How do I start?</h2>
      <p>Run <code>openvila init</code>, then <code>openvila scan</code>, and finally <code>openvila run</code>.</p>

      <h2>Can OpenVila execute actions directly?</h2>
      <p>Only owner-created actions can run, and sensitive actions should be reviewed by owner first.</p>

      <h2>Does scan include database content?</h2>
      <p>Yes. OpenVila can discover and query SQLite/MySQL/PostgreSQL knowledge tables.</p>
    </section>
  </main>
</body>
</html>
