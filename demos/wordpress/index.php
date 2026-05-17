<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenVila WordPress Demo</title>
  <link rel="stylesheet" href="./assets/style.css" />
</head>
<body>
  <main class="site">
    <header>
      <h1>OpenVila WordPress Demo</h1>
      <p class="tagline">WordPress-style site demo with MySQL content for /scan testing.</p>
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
      <h2>What this demo covers</h2>
      <ul>
        <li>Policy and pricing pages in PHP templates.</li>
        <li>WordPress-style <code>wp-config.php</code> database constants.</li>
        <li>MySQL table <code>wp_posts_demo</code> with long-form post content.</li>
      </ul>
      <p>
        Suggested flow: run <code>openvila init</code>, then <code>openvila scan</code>, then
        inspect <code>.openvila/knowledges/index.md</code> and <code>docs/</code>.
      </p>
    </section>
  </main>
</body>
</html>
