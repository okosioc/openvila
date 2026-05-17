CREATE DATABASE IF NOT EXISTS wordpress_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'wordpress_user'@'%' IDENTIFIED BY 'wordpress_pass';
GRANT ALL PRIVILEGES ON wordpress_demo.* TO 'wordpress_user'@'%';
FLUSH PRIVILEGES;

USE wordpress_demo;

CREATE TABLE IF NOT EXISTS wp_posts_demo (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  slug VARCHAR(120) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  summary TEXT NOT NULL,
  tags VARCHAR(255) NOT NULL,
  body LONGTEXT NOT NULL,
  published_at DATETIME NOT NULL
);

INSERT INTO wp_posts_demo (slug, title, summary, tags, body, published_at)
VALUES
  (
    'scan-quality-playbook',
    'Scan Quality Playbook',
    'A practical playbook for keeping compiled knowledge stable when website content changes quickly.',
    'scan,knowledge,index',
    'Reliable scan output depends on consistent source structure.\n\nKeep policy pages explicit and avoid burying pricing details in random snippets.\n\nAfter each release, run /scan and quickly validate index summaries before going live.',
    '2026-04-12 09:30:00'
  ),
  (
    'owner-handoff-checklist',
    'Owner Handoff Checklist',
    'What to prepare before handing a site to another operator with OpenVila enabled.',
    'handoff,operations,safety',
    'Before handoff, review all action scripts and confirm notification channels.\n\nRotate keys and verify that emergency disable workflows are documented.\n\nTest one end-to-end support conversation in review mode.',
    '2026-04-25 14:20:00'
  ),
  (
    'action-safety-rules',
    'Action Safety Rules',
    'A baseline rule set for designing safe owner-approved actions.',
    'actions,safety,review',
    'Never allow user text to be executed directly as code or shell commands.\n\nFor takedown and refund actions, require manual owner approval.\n\nLog both trigger conditions and final execution status for audit.',
    '2026-05-02 10:10:00'
  )
ON DUPLICATE KEY UPDATE
  title = VALUES(title),
  summary = VALUES(summary),
  tags = VALUES(tags),
  body = VALUES(body),
  published_at = VALUES(published_at);
