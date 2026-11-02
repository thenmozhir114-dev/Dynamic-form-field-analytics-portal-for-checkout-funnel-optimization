"""Synthetic demo journeys for the dashboard.

Run with:  flask --app app seed --sessions 200

The data is simulated. It exists only to demonstrate the dashboard and must
not be reported as measured project results.
"""

import random
import time
import uuid

import config
import database
from validation import split_valid

# Per-field behaviour profile:
# (mean seconds on field, probability a visit raises an error, error category,
#  probability the session gives up on this field)
PROFILE = {
    "full_name":          (4.0, 0.03, "length",   0.01),
    "email":              (6.5, 0.10, "format",   0.02),
    "phone":              (6.0, 0.16, "format",   0.03),
    "address_line":       (11.0, 0.07, "length",  0.04),
    "city":               (3.5, 0.03, "required", 0.01),
    "state":              (3.0, 0.02, "required", 0.01),
    "postal_code":        (5.5, 0.20, "format",   0.05),
    "delivery_method":    (3.2, 0.04, "required", 0.03),
    "contact_preference": (2.5, 0.00, "other",    0.01),
    "promo_code":         (7.0, 0.30, "format",   0.06),
}
DEVICES = [("desktop", 0.55), ("mobile", 0.38), ("tablet", 0.07)]
BROWSERS = [("chrome", 0.6), ("edge", 0.12), ("safari", 0.15), ("firefox", 0.08), ("other", 0.05)]


def _pick(weighted):
    r, acc = random.random(), 0.0
    for value, w in weighted:
        acc += w
        if r <= acc:
            return value
    return weighted[-1][0]


def simulate_session(start_ms):
    token = str(uuid.uuid4())
    device, browser = _pick(DEVICES), _pick(BROWSERS)
    mobile_penalty = 1.35 if device == "mobile" else 1.0
    events, t = [], start_ms

    def emit(kind, field=None, error=None):
        e = {"event_uid": str(uuid.uuid4()), "session_token": token, "form_id": "checkout",
             "event_type": kind, "event_ts": int(t), "device_category": device,
             "browser_category": browser}
        if field:
            e["field_id"] = field
        if error:
            e["error_category"] = error
        events.append(e)

    emit("form_start")
    for field in config.TRACKED_FIELD_ORDER:
        mean_s, p_err, err_cat, p_quit = PROFILE.get(field, (4.0, 0.05, "other", 0.02))
        if field == "promo_code" and random.random() < 0.6:
            continue  # most people skip the optional promo field
        t += random.uniform(300, 1500)
        emit("focus", field)
        emit("input", field)
        t += random.lognormvariate(0, 0.45) * mean_s * 1000 * mobile_penalty
        if random.random() < p_err * mobile_penalty:
            emit("validation_error", field, err_cat)
            if random.random() < p_quit * 4:
                return events  # gave up right after an error, never blurred
            t += random.uniform(1500, 6000)
            emit("correction", field)
        emit("field_complete", field)
        emit("blur", field)
        if random.random() < p_quit:
            return events

    t += random.uniform(5000, 20000)  # untracked payment fields
    emit("form_submit")
    t += random.uniform(500, 2000)
    emit("form_complete")
    return events


def seed(sessions=200, days=7):
    """Insert synthetic sessions. Needs a Flask app context. Returns rows stored."""
    now = int(time.time() * 1000)
    # Keep every journey outside the abandonment window so its outcome is
    # decided rather than "in progress".
    latest = now - (config.ABANDON_WINDOW_MIN + 5) * 60_000
    events = []
    for _ in range(sessions):
        events.extend(simulate_session(random.randint(now - days * 86_400_000, latest)))
    valid, rejected = split_valid(events)
    assert not rejected, rejected[:3]
    return database.insert_events(valid)
