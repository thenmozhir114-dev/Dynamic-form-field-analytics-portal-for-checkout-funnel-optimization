"""Analytics engine: turns raw event rows into field-level and funnel metrics.

Definitions (also shown on the dashboard):

* Visit            - one focus on a field, ending at the next blur of that field.
* Duration         - blur time minus focus time. Visits without a blur, with a
                     negative interval or longer than MAX_DURATION_MS are
                     excluded from time metrics (they still count as visits).
* Error rate       - visits with at least one validation error / visits x 100.
                     An error is attributed to the most recent visit of that
                     field; errors raised on submit for a never-visited field
                     count towards total errors only.
* Correction rate  - visits with at least one correction / visits x 100.
* Progression rate - visits after which the session focused a later field in
                     the form order, or submitted the form / visits x 100.
* Drop-off rate    - abandoned sessions whose last visited field was this one
                     / sessions that visited this field x 100.
* Session status   - "completed" if a form_complete event exists; otherwise
                     "abandoned" if idle for ABANDON_WINDOW_MIN minutes;
                     otherwise "in progress".
* Abandonment rate - abandoned / (completed + abandoned) x 100. In-progress
                     sessions are excluded because their outcome is unknown.
"""

import statistics
import time
from collections import defaultdict

import config


def _pct(numerator, denominator):
    return round(numerator / denominator * 100, 1) if denominator else None


def _secs(ms_values, fn):
    return round(fn(ms_values) / 1000, 2) if ms_values else None


class _Visit:
    __slots__ = ("field", "start", "end", "errors", "corrections", "inputs", "progressed")

    def __init__(self, field, start):
        self.field = field
        self.start = start
        self.end = None
        self.errors = 0
        self.corrections = 0
        self.inputs = 0
        self.progressed = False

    @property
    def duration(self):
        if self.end is None:
            return None
        d = self.end - self.start
        return d if 0 <= d <= config.MAX_DURATION_MS else None


class _Session:
    def __init__(self, token):
        self.token = token
        self.visits = []
        self.last_visit = {}  # field -> most recent _Visit
        self.started_at = None
        self.submitted_at = None
        self.completed_at = None
        self.submit_attempts = 0
        self.unattached_errors = 0
        self.last_ts = None
        self.device = None

    def status(self, now_ms):
        if self.completed_at is not None:
            return "completed"
        if now_ms - self.last_ts >= config.ABANDON_WINDOW_MIN * 60 * 1000:
            return "abandoned"
        return "in_progress"


def build_sessions(events):
    """Reconstruct sessions and visits. `events` must be ordered by
    session_token, event_ts, event_id (as database.fetch_events returns them)."""
    sessions = {}
    for e in events:
        s = sessions.get(e["session_token"])
        if s is None:
            s = sessions[e["session_token"]] = _Session(e["session_token"])
        ts, kind, field = e["event_ts"], e["event_type"], e.get("field_id")
        s.last_ts = ts if s.last_ts is None else max(s.last_ts, ts)
        if s.device is None and e.get("device_category"):
            s.device = e["device_category"]

        if kind == "focus":
            visit = _Visit(field, ts)
            s.visits.append(visit)
            s.last_visit[field] = visit
            if s.started_at is None:
                s.started_at = ts
        elif kind == "blur":
            visit = s.last_visit.get(field)
            if visit is not None and visit.end is None:
                visit.end = ts
        elif kind in ("validation_error", "correction", "input"):
            visit = s.last_visit.get(field)
            if visit is None:
                if kind == "validation_error":
                    s.unattached_errors += 1
                continue
            if kind == "validation_error":
                visit.errors += 1
            elif kind == "correction":
                visit.corrections += 1
            else:
                visit.inputs += 1
        elif kind == "form_start":
            s.started_at = ts if s.started_at is None else min(s.started_at, ts)
        elif kind == "form_submit":
            s.submit_attempts += 1
            if s.submitted_at is None:
                s.submitted_at = ts
        elif kind == "form_complete":
            if s.completed_at is None:
                s.completed_at = ts

    order = {f: i for i, f in enumerate(config.TRACKED_FIELD_ORDER)}
    for s in sessions.values():
        _mark_progression(s, order)
    return list(sessions.values())


def _mark_progression(session, order):
    later_events = [(v.start, order.get(v.field, -1)) for v in session.visits]
    for visit in session.visits:
        pos = order.get(visit.field, -1)
        if session.submitted_at is not None and session.submitted_at > visit.start:
            visit.progressed = True
            continue
        visit.progressed = any(ts > visit.start and p > pos for ts, p in later_events)


MAX_TIMELINE_BUCKETS = 120


def _timeline(sessions, now_ms, tz_offset_min):
    """Sessions per hour (data spanning under 2 days) or per local day, split
    by status. Empty buckets between the first and last session are kept so
    gaps show as gaps. `tz_offset_min` is minutes east of UTC."""
    starts = [(s.started_at, s.status(now_ms)) for s in sessions if s.started_at is not None]
    if not starts:
        return {"bucket": "day", "points": []}
    offset = tz_offset_min * 60_000
    first = min(t for t, _ in starts) + offset
    last = max(t for t, _ in starts) + offset
    size = 3_600_000 if last - first < 2 * 86_400_000 else 86_400_000
    lo, hi = first // size, last // size
    lo = max(lo, hi - MAX_TIMELINE_BUCKETS + 1)
    points = {b: {"completed": 0, "abandoned": 0, "in_progress": 0} for b in range(lo, hi + 1)}
    for t, status in starts:
        b = (t + offset) // size
        if b in points:
            points[b][status] += 1
    return {
        "bucket": "hour" if size == 3_600_000 else "day",
        # Bucket start as UTC epoch ms, so the browser can label it directly.
        "points": [dict(ts=b * size - offset, **c) for b, c in sorted(points.items())],
    }


def compute_metrics(events, now_ms=None, tz_offset_min=0):
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    sessions = [s for s in build_sessions(events) if s.started_at is not None or s.visits]

    status_counts = {"completed": 0, "abandoned": 0, "in_progress": 0}
    per_field = defaultdict(list)
    sessions_visiting = defaultdict(set)
    dropoffs = defaultdict(int)
    checkout_times = []
    total_errors = 0

    for s in sessions:
        status = s.status(now_ms)
        status_counts[status] += 1
        total_errors += s.unattached_errors
        for v in s.visits:
            per_field[v.field].append(v)
            sessions_visiting[v.field].add(s.token)
            total_errors += v.errors
        if status == "abandoned" and s.visits:
            dropoffs[max(s.visits, key=lambda v: v.start).field] += 1
        if status == "completed" and s.started_at is not None:
            checkout_times.append(s.completed_at - s.started_at)

    known = config.TRACKED_FIELD_ORDER
    field_ids = known + sorted(f for f in per_field if f not in known)

    fields = []
    for fid in field_ids:
        visits = per_field.get(fid, [])
        n = len(visits)
        durations = [v.duration for v in visits if v.duration is not None]
        fields.append({
            "field_id": fid,
            "label": config.FIELD_LABELS.get(fid, fid),
            "visits": n,
            "sessions": len(sessions_visiting[fid]),
            "valid_durations": len(durations),
            "mean_time_s": _secs(durations, statistics.mean),
            "median_time_s": _secs(durations, statistics.median),
            "visits_with_errors": sum(1 for v in visits if v.errors),
            "error_events": sum(v.errors for v in visits),
            "error_rate": _pct(sum(1 for v in visits if v.errors), n),
            "correction_rate": _pct(sum(1 for v in visits if v.corrections), n),
            "progression_rate": _pct(sum(1 for v in visits if v.progressed), n),
            "dropoffs": dropoffs[fid],
            "dropoff_rate": _pct(dropoffs[fid], len(sessions_visiting[fid])),
            "low_sample": 0 < n < config.LOW_SAMPLE_VISITS,
        })

    started = len(sessions)
    funnel = [{"stage": "Checkout started", "sessions": started}]
    for fid in known:
        funnel.append({"stage": config.FIELD_LABELS.get(fid, fid), "sessions": len(sessions_visiting[fid])})
    funnel.append({"stage": "Submitted", "sessions": sum(1 for s in sessions if s.submitted_at is not None)})
    funnel.append({"stage": "Completed", "sessions": status_counts["completed"]})

    decided = status_counts["completed"] + status_counts["abandoned"]
    summary = {
        "sessions_started": started,
        "completed": status_counts["completed"],
        "abandoned": status_counts["abandoned"],
        "in_progress": status_counts["in_progress"],
        "completion_rate": _pct(status_counts["completed"], started),
        "abandonment_rate": _pct(status_counts["abandoned"], decided),
        "field_visits": sum(len(v) for v in per_field.values()),
        "validation_errors": total_errors,
        "median_checkout_s": _secs(checkout_times, statistics.median),
        "avg_submit_attempts": round(
            statistics.mean([s.submit_attempts for s in sessions if s.submit_attempts]), 2
        ) if any(s.submit_attempts for s in sessions) else None,
    }

    error_categories = defaultdict(int)
    for e in events:
        if e["event_type"] == "validation_error":
            error_categories[e.get("error_category") or "other"] += 1

    by_device = defaultdict(lambda: {"completed": 0, "abandoned": 0, "in_progress": 0})
    for s in sessions:
        by_device[s.device or "unknown"][s.status(now_ms)] += 1
    devices = [{
        "device": d,
        "sessions": sum(c.values()),
        **c,
        "completion_rate": _pct(c["completed"], sum(c.values())),
    } for d, c in sorted(by_device.items(), key=lambda kv: -sum(kv[1].values()))]

    return {
        "summary": summary,
        "fields": fields,
        "funnel": funnel,
        "timeline": _timeline(sessions, now_ms, tz_offset_min),
        "error_categories": [
            {"category": c, "count": n}
            for c, n in sorted(error_categories.items(), key=lambda kv: -kv[1])
        ],
        "devices": devices,
    }
