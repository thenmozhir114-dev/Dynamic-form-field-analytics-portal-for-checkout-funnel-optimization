"""Functional and metric tests. Test names map to the report's functional
test cases (TC-xx, Chapter 5) where one applies."""

import time
import uuid

import pytest

import analytics
from app import create_app

T0 = 1_760_000_000_000  # fixed base time for deterministic metric tests


def ev(kind, field=None, ts=None, session="session-aaaa", **extra):
    e = {"event_uid": str(uuid.uuid4()), "session_token": session, "form_id": "checkout",
         "event_type": kind, "event_ts": ts if ts is not None else int(time.time() * 1000),
         "device_category": "desktop", "browser_category": "chrome"}
    if field:
        e["field_id"] = field
    e.update(extra)
    return e


@pytest.fixture
def client(tmp_path):
    app = create_app({"DATABASE": str(tmp_path / "test.db"), "TESTING": True})
    return app.test_client()


def count(client):
    return client.get("/api/health").get_json()["events"]


def test_tc01_pages_load(client):
    for path in ("/", "/checkout", "/dashboard"):
        assert client.get(path).status_code == 200
    page = client.get("/checkout").get_data(as_text=True)
    assert 'id="postal_code"' in page
    assert 'id="card_number"' in page and 'data-track="off"' in page


def test_tc02_focus_and_blur_are_stored(client):
    r = client.post("/api/events", json={"events": [ev("focus", "email"), ev("blur", "email")]})
    assert r.status_code == 200
    assert r.get_json()["stored"] == 2
    assert count(client) == 2


def test_tc03_validation_error_stores_category_not_value(client):
    r = client.post("/api/events", json=ev("validation_error", "postal_code", error_category="format"))
    assert r.status_code == 200
    row = client.get("/api/events/recent").get_json()["events"][0]
    assert row["error_category"] == "format"
    assert "value" not in row


def test_tc04_completion_event_recorded(client):
    now = int(time.time() * 1000)
    client.post("/api/events", json={"events": [
        ev("form_start", ts=now), ev("focus", "email", now + 10), ev("blur", "email", now + 20),
        ev("form_submit", ts=now + 30), ev("form_complete", ts=now + 40)]})
    assert client.get("/api/metrics").get_json()["summary"]["completed"] == 1


def test_tc05_unsupported_event_type_rejected(client):
    r = client.post("/api/events", json=ev("keystroke", "email"))
    assert r.status_code == 400
    assert "unsupported event_type" in r.get_json()["rejected"][0]["error"]


def test_tc06_missing_field_id_rejected(client):
    r = client.post("/api/events", json=ev("focus"))
    assert r.status_code == 400
    assert "field_id" in r.get_json()["rejected"][0]["error"]


def test_tc07_empty_dashboard_reports_no_observations(client):
    body = client.get("/api/metrics").get_json()
    assert body["summary"]["sessions_started"] == 0
    assert body["summary"]["completion_rate"] is None  # shown as N/A, not 0 %
    assert all(f["error_rate"] is None for f in body["fields"])


def test_tc08_metrics_match_manual_calculation():
    s1, s2 = "session-one1", "session-two2"
    events = [
        # Session 1: email 4 s with one error + correction, then phone 2 s, completes.
        ev("form_start", ts=T0, session=s1),
        ev("focus", "email", T0 + 1000, s1),
        ev("validation_error", "email", T0 + 2000, s1, error_category="format"),
        ev("correction", "email", T0 + 3000, s1),
        ev("blur", "email", T0 + 5000, s1),
        ev("focus", "phone", T0 + 6000, s1),
        ev("blur", "phone", T0 + 8000, s1),
        ev("form_submit", ts=T0 + 9000, session=s1),
        ev("form_complete", ts=T0 + 9500, session=s1),
        # Session 2: email 6 s, no error, then leaves.
        ev("form_start", ts=T0, session=s2),
        ev("focus", "email", T0 + 1000, s2),
        ev("blur", "email", T0 + 7000, s2),
    ]
    events.sort(key=lambda e: (e["session_token"], e["event_ts"]))
    m = analytics.compute_metrics(events, now_ms=T0 + 60 * 60 * 1000)
    email = next(f for f in m["fields"] if f["field_id"] == "email")

    assert email["visits"] == 2
    assert email["mean_time_s"] == 5.0            # (4 + 6) / 2
    assert email["error_rate"] == 50.0            # 1 of 2 visits
    assert email["correction_rate"] == 50.0
    assert email["progression_rate"] == 50.0      # only session 1 moved on
    assert email["dropoff_rate"] == 50.0          # session 2 abandoned on email
    assert m["summary"]["completed"] == 1
    assert m["summary"]["abandoned"] == 1
    assert m["summary"]["abandonment_rate"] == 50.0


def test_tc09_values_and_unknown_keys_are_rejected(client):
    r = client.post("/api/events", json=ev("input", "email", value="someone@example.com"))
    assert r.status_code == 400
    assert "unexpected keys: value" in r.get_json()["rejected"][0]["error"]
    assert count(client) == 0


def test_tc10_repeated_journeys_are_separate_sessions(client):
    now = int(time.time() * 1000)
    for token in ("journey-0001", "journey-0002"):
        client.post("/api/events", json={"events": [
            ev("form_start", ts=now, session=token),
            ev("focus", "email", now + 10, token),
            ev("blur", "email", now + 20, token),
            ev("form_submit", ts=now + 30, session=token),
            ev("form_complete", ts=now + 40, session=token),
        ]})
    summary = client.get("/api/metrics").get_json()["summary"]
    assert summary["sessions_started"] == 2 and summary["completed"] == 2


def test_retry_with_same_uid_is_idempotent(client):
    e = ev("focus", "city")
    client.post("/api/events", json=e)
    r = client.post("/api/events", json=e)
    assert r.get_json() == {"accepted": 1, "stored": 0, "duplicates": 1, "rejected": []}


def test_malformed_json_and_bad_filters(client):
    r = client.post("/api/events", data=b"{not json", content_type="application/json")
    assert r.status_code == 400
    assert client.get("/api/metrics?device=fridge").status_code == 400
    assert client.get("/api/metrics?days=0").status_code == 400


def test_partial_batch_stores_valid_events(client):
    r = client.post("/api/events", json={"events": [ev("focus", "city"), ev("bogus", "city")]})
    body = r.get_json()
    assert r.status_code == 200 and body["stored"] == 1 and body["rejected"][0]["index"] == 1


def test_overlong_and_unclosed_visits_excluded_from_time():
    events = [
        ev("focus", "city", T0, "session-long"),
        ev("blur", "city", T0 + 10 * 60 * 1000, "session-long"),  # 10 min > 5 min cap
        ev("focus", "state", T0 + 11 * 60 * 1000, "session-long"),  # never blurred
    ]
    m = analytics.compute_metrics(events, now_ms=T0)
    by_id = {f["field_id"]: f for f in m["fields"]}
    assert by_id["city"]["visits"] == 1 and by_id["city"]["mean_time_s"] is None
    assert by_id["state"]["visits"] == 1 and by_id["state"]["valid_durations"] == 0


def test_seed_command_creates_synthetic_sessions(tmp_path):
    app = create_app({"DATABASE": str(tmp_path / "seed.db"), "TESTING": True})
    result = app.test_cli_runner().invoke(args=["seed", "--sessions", "20"])
    assert "Seeded 20 synthetic sessions" in result.output
    summary = app.test_client().get("/api/metrics").get_json()["summary"]
    assert summary["sessions_started"] == 20 and summary["in_progress"] == 0


def test_chart_data_timeline_error_categories_and_devices():
    hour = 60 * 60 * 1000
    events = [
        ev("form_start", ts=T0, session="s-1"),
        ev("focus", "phone", T0 + 1000, "s-1"),
        ev("validation_error", "phone", T0 + 2000, "s-1", error_category="format"),
        ev("form_complete", ts=T0 + 3000, session="s-1"),
        ev("form_start", ts=T0 + 3 * hour, session="s-2", device_category="mobile"),
        ev("focus", "email", T0 + 3 * hour + 1000, "s-2", device_category="mobile"),
        ev("validation_error", "email", T0 + 3 * hour + 2000, "s-2",
           device_category="mobile", error_category="required"),
        ev("validation_error", "email", T0 + 3 * hour + 3000, "s-2",
           device_category="mobile", error_category="format"),
    ]
    m = analytics.compute_metrics(events, now_ms=T0 + 10 * hour)

    timeline = m["timeline"]
    assert timeline["bucket"] == "hour"
    assert len(timeline["points"]) == 4  # gaps between first and last session are kept
    assert timeline["points"][0]["completed"] == 1
    assert timeline["points"][-1]["abandoned"] == 1

    assert m["error_categories"] == [{"category": "format", "count": 2},
                                     {"category": "required", "count": 1}]
    devices = {d["device"]: d for d in m["devices"]}
    assert devices["desktop"]["completion_rate"] == 100.0
    assert devices["mobile"]["abandoned"] == 1 and devices["mobile"]["completion_rate"] == 0.0


def test_bad_tz_filter_rejected(client):
    assert client.get("/api/metrics?tz=abc").status_code == 400
    assert client.get("/api/metrics?tz=330").status_code == 200
