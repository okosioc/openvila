from flask import Flask, render_template

app = Flask(__name__)


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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
