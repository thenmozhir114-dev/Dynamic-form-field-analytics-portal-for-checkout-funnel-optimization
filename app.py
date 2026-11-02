"""Flask application: serves the checkout form and dashboard, ingests events
and returns aggregate metrics."""

import logging
import sqlite3
import time

import click
from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

import analytics
import config
import database
from validation import split_valid

log = logging.getLogger("formflow")


def create_app(overrides=None):
    app = Flask(__name__)
    app.config.from_mapping(
        DATABASE=config.DATABASE,
        MAX_CONTENT_LENGTH=config.MAX_CONTENT_LENGTH,
        JSON_SORT_KEYS=False,
    )
    if overrides:
        app.config.update(overrides)

    database.init_db(app.config["DATABASE"])
    app.teardown_appcontext(database.close_db)

    # ---------------------------------------------------------------- pages

    @app.get("/")
    def home():
        return render_template("index.html")

    @app.get("/checkout")
    def checkout():
        return render_template("checkout.html", sections=config.FORM_SECTIONS)

    @app.get("/dashboard")
    def dashboard():
        return render_template(
            "dashboard.html",
            max_duration_min=config.MAX_DURATION_MS // 60000,
            abandon_window_min=config.ABANDON_WINDOW_MIN,
            low_sample=config.LOW_SAMPLE_VISITS,
        )

    # ------------------------------------------------------------------ API

    @app.post("/api/events")
    def ingest_events():
        payload = request.get_json(silent=True)
        if payload is None:
            return _error("request body must be JSON", 400)

        if isinstance(payload, dict) and "events" in payload:
            events = payload["events"]
            if not isinstance(events, list):
                return _error("'events' must be a list", 400)
        else:
            events = [payload]

        if not events:
            return _error("no events supplied", 400)
        if len(events) > config.MAX_BATCH_SIZE:
            return _error(f"at most {config.MAX_BATCH_SIZE} events per request", 413)

        valid, rejected = split_valid(events)
        inserted = database.insert_events(valid) if valid else 0
        # Log counts only - never the request body.
        log.info("events received=%d stored=%d rejected=%d", len(events), inserted, len(rejected))

        body = {
            "accepted": len(valid),
            "stored": inserted,
            "duplicates": len(valid) - inserted,
            "rejected": rejected,
        }
        return jsonify(body), (200 if valid else 400)

    @app.get("/api/metrics")
    def metrics():
        device = request.args.get("device") or None
        browser = request.args.get("browser") or None
        if device and device not in config.DEVICE_CATEGORIES:
            return _error("unknown device filter", 400)
        if browser and browser not in config.BROWSER_CATEGORIES:
            return _error("unknown browser filter", 400)

        since_ms = None
        days = request.args.get("days")
        if days:
            try:
                days = int(days)
                if days < 1:
                    raise ValueError
            except ValueError:
                return _error("days must be a positive integer", 400)
            since_ms = int(time.time() * 1000) - days * 86_400_000

        try:
            tz_offset = int(request.args.get("tz", 0))
            if not -840 <= tz_offset <= 840:
                raise ValueError
        except ValueError:
            return _error("tz must be minutes east of UTC (-840 to 840)", 400)

        events = database.fetch_events(device=device, browser=browser, since_ms=since_ms)
        result = analytics.compute_metrics(events, tz_offset_min=tz_offset)
        result["filters"] = {
            "applied": {"device": device, "browser": browser, "days": days or None},
            "devices": database.distinct_values("device_category"),
            "browsers": database.distinct_values("browser_category"),
        }
        result["total_events"] = len(events)
        result["generated_at"] = int(time.time() * 1000)
        return jsonify(result)

    @app.get("/api/events/recent")
    def recent_events():
        """The latest stored rows, unmodified, so anyone can verify that no
        typed values, names or payment data are ever persisted."""
        try:
            limit = int(request.args.get("limit", 25))
            if not 1 <= limit <= 500:
                raise ValueError
        except ValueError:
            return _error("limit must be between 1 and 500", 400)
        return jsonify(
            columns=["event_id", *database.COLUMNS, "created_at"],
            events=database.recent_events(limit),
        )

    @app.get("/api/health")
    def health():
        return jsonify(status="ok", events=database.count_events())

    # -------------------------------------------------------- error handling

    @app.errorhandler(sqlite3.Error)
    def database_error(exc):
        log.error("database error: %s", type(exc).__name__)
        return _error("analytics storage is unavailable, please retry later", 503)

    @app.errorhandler(HTTPException)
    def http_error(exc):
        if request.path.startswith("/api/"):
            return _error(exc.description, exc.code)
        return exc

    @app.cli.command("reset-db")
    def reset_db():
        """Delete every stored event."""
        database.clear_events()
        print("All events deleted.")

    @app.cli.command("seed")
    @click.option("--sessions", default=200, show_default=True, help="Synthetic journeys to add.")
    @click.option("--days", default=7, show_default=True, help="Spread them over this many days.")
    def seed_db(sessions, days):
        """Add synthetic demo journeys (never report these as measured results)."""
        import seed
        stored = seed.seed(sessions, days)
        print(f"Seeded {sessions} synthetic sessions ({stored} events).")

    return app


def _error(message, status):
    return jsonify(error=message), status


app = create_app()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(debug=True)
