import sqlite3
from pathlib import Path
from flask import Flask, abort, render_template

app = Flask(__name__)
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "blog.db"

SEED_POSTS = [
    {
        "slug": "owner-handoff-checklist",
        "title": "Owner Handoff Checklist Before Go-Live",
        "summary": "How to prepare FAQ, pricing, and policy pages before enabling OpenVila in production.",
        "tags": "launch,faq,pricing,policy",
        "created_at": "2026-05-10",
        "body": (
            "Before enabling OpenVila on a production website, owners should verify user-facing business pages are complete.\n\n"
            "1) Pricing clarity: each plan should list price, billing cycle, and refund terms.\n"
            "2) Policy readiness: agreement and privacy pages should include effective date and support contact.\n"
            "3) FAQ grounding: include common questions about onboarding, billing, and cancellation.\n"
            "4) Escalation path: provide a clear manual support channel for owner review cases."
        ),
    },
    {
        "slug": "scan-quality-playbook",
        "title": "Scan Quality Playbook for Flask Sites",
        "summary": "A practical guide to keep /scan output stable when pages change frequently.",
        "tags": "scan,knowledge,maintenance,flask",
        "created_at": "2026-05-12",
        "body": (
            "High quality /scan output depends on source consistency more than prompt tuning.\n\n"
            "Use one source of truth per topic.\n"
            "Prefer explicit headings like Refund Policy, Support SLA, and Billing Cycle.\n"
            "Ship incremental edits instead of rewriting all pages at once.\n"
            "After major policy updates, run /scan and verify knowledges/index.md summaries."
        ),
    },
    {
        "slug": "action-safety-rules",
        "title": "Action Safety Rules for Owner-Approved Automation",
        "summary": "Security rules for action scripts: owner-only creation, review queue, and audit trail.",
        "tags": "action,security,approval,operations",
        "created_at": "2026-05-14",
        "body": (
            "OpenVila actions can change website state, so safety controls must be strict.\n\n"
            "Rule 1: actions are owner-created only.\n"
            "Rule 2: risky actions require manual approval.\n"
            "Rule 3: keep an audit trail of request payload and decision.\n"
            "Rule 4: validate input in action scripts before writing data."
        ),
    },
]


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS posts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              slug TEXT NOT NULL UNIQUE,
              title TEXT NOT NULL,
              summary TEXT NOT NULL,
              tags TEXT NOT NULL,
              body TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
            """
        )
        conn.executemany(
            """
            INSERT OR IGNORE INTO posts (slug, title, summary, tags, body, created_at)
            VALUES (:slug, :title, :summary, :tags, :body, :created_at)
            """,
            SEED_POSTS,
        )
        conn.commit()


def list_posts():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            """
            SELECT slug, title, summary, tags, created_at
            FROM posts
            ORDER BY created_at DESC, id DESC
            """
        ).fetchall()


def get_post_by_slug(slug):
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            """
            SELECT slug, title, summary, tags, body, created_at
            FROM posts
            WHERE slug = ?
            """,
            (slug,),
        ).fetchone()


init_db()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/pricing")
def pricing():
    return render_template("pricing.html")


@app.route("/faq")
def faq():
    return render_template("faq.html")


@app.route("/user-agreement")
def user_agreement():
    return render_template("user_agreement.html")


@app.route("/privacy-policy")
def privacy_policy():
    return render_template("privacy_policy.html")


@app.route("/posts")
def posts():
    return render_template("posts.html", posts=list_posts())


@app.route("/posts/<slug>")
def post_detail(slug):
    post = get_post_by_slug(slug)
    if not post:
        abort(404)
    return render_template("post_detail.html", post=post)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
