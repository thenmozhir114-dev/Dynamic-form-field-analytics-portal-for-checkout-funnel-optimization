"""Server-side validation of analytics event payloads.

The browser validates too, but client checks can be bypassed, so every event
is checked here before it reaches the database. Unknown keys are rejected
outright: that is what stops a value, name or card number from ever being
stored, even if a buggy or malicious client sends one.
"""

import re
import time

import config

ALLOWED_KEYS = {
    "event_uid", "session_token", "form_id", "field_id", "event_type", "event_ts",
    "device_category", "browser_category", "error_category",
}
REQUIRED_KEYS = {"event_uid", "session_token", "form_id", "event_type", "event_ts"}

SLUG_RE = re.compile(r"^[a-z0-9_]{1,64}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")

EARLIEST_TS = 1_577_836_800_000  # 2020-01-01, rejects obviously wrong clocks
FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000


class ValidationError(ValueError):
    pass


def validate_event(raw):
    """Return a cleaned event dict or raise ValidationError."""
    if not isinstance(raw, dict):
        raise ValidationError("event must be a JSON object")

    unknown = set(raw) - ALLOWED_KEYS
    if unknown:
        raise ValidationError(f"unexpected keys: {', '.join(sorted(unknown))}")
    missing = REQUIRED_KEYS - set(raw)
    if missing:
        raise ValidationError(f"missing keys: {', '.join(sorted(missing))}")

    event_type = raw["event_type"]
    if event_type not in config.ALLOWED_EVENTS:
        raise ValidationError(f"unsupported event_type: {str(event_type)[:32]}")

    for key, pattern in (("event_uid", TOKEN_RE), ("session_token", TOKEN_RE), ("form_id", SLUG_RE)):
        if not isinstance(raw[key], str) or not pattern.match(raw[key]):
            raise ValidationError(f"invalid {key}")

    field_id = raw.get("field_id")
    if event_type in config.FIELD_EVENTS:
        if not isinstance(field_id, str) or not SLUG_RE.match(field_id):
            raise ValidationError("field events need a valid field_id")
    elif field_id is not None:
        raise ValidationError("form events must not carry a field_id")

    ts = raw["event_ts"]
    if isinstance(ts, bool) or not isinstance(ts, int):
        raise ValidationError("event_ts must be an integer (epoch ms)")
    now_ms = int(time.time() * 1000)
    if not EARLIEST_TS <= ts <= now_ms + FUTURE_TOLERANCE_MS:
        raise ValidationError("event_ts out of range")

    for key, allowed in (("device_category", config.DEVICE_CATEGORIES),
                         ("browser_category", config.BROWSER_CATEGORIES),
                         ("error_category", config.ERROR_CATEGORIES)):
        value = raw.get(key)
        if value is not None and value not in allowed:
            raise ValidationError(f"invalid {key}")

    if raw.get("error_category") is not None and event_type != "validation_error":
        raise ValidationError("error_category is only allowed on validation_error events")

    return {key: raw.get(key) for key in ALLOWED_KEYS}


def split_valid(events):
    """Validate a list of events. Returns (valid_events, rejected) where
    rejected is a list of {"index": i, "error": message}."""
    valid, rejected = [], []
    for i, raw in enumerate(events):
        try:
            valid.append(validate_event(raw))
        except ValidationError as exc:
            rejected.append({"index": i, "error": str(exc)})
    return valid, rejected
