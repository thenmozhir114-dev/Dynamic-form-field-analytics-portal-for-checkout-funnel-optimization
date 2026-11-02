# Dynamic Form Field Analytics Portal for Checkout Funnel Optimization

A lightweight, privacy-conscious prototype that measures how users interact
with each checkout form field (time, validation errors, corrections,
progression, drop-off) **without ever collecting what they type**.

Stack: HTML, CSS, JavaScript · Python Flask · SQLite

## Run it

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows  (Linux/macOS: source .venv/bin/activate)
pip install -r requirements.txt
python app.py                   # http://127.0.0.1:5000
```

| Page | URL |
|---|---|
| Home | `/` |
| Checkout demo (tracked form) | `/checkout` |
| Analytics dashboard | `/dashboard` |

Optional commands:

```bash
flask --app app seed --sessions 200   # add SYNTHETIC demo journeys (not real results)
flask --app app reset-db              # delete every stored event
python -m pytest                      # run the test suite
```

The database file is `instance/formflow.db` (override with the `FORMFLOW_DB`
environment variable).

## Project structure

| File | Role (report section) |
|---|---|
| `config.py` | Form definition, allowed events/categories, metric rules |
| `static/tracker.js` | Browser event tracking: focus, blur, input, validation_error, correction, field_complete, form_start, form_submit, form_complete (4.4) |
| `static/checkout.js` | Checkout validation, reports error *categories* to the tracker, live event log (4.3) |
| `app.py` | Flask pages and REST API (4.5) |
| `validation.py` | Server-side payload validation and allowlists (4.5, 4.9) |
| `database.py` | SQLite schema and parameterised queries (4.6) |
| `analytics.py` | Analytics engine: visits, durations and rates (4.7) |
| `templates/dashboard.html`, `static/dashboard.js` | Dashboard: tiles, insights, charts, sortable table, filters (4.8) |
| `seed.py` | Synthetic data generator for demonstrations |
| `tests/test_app.py` | Tests TC-01 to TC-10 from Chapter 5, plus extra edge cases |

## API

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/events` | Ingest one event or `{"events": [...]}` (max 100). Returns `accepted`, `stored`, `duplicates`, `rejected` |
| GET | `/api/metrics?device=&browser=&days=&tz=` | Summary, per-field metrics, funnel, sessions over time, error categories and device breakdown (`tz` = minutes east of UTC, for day buckets) |
| GET | `/api/events/recent?limit=25` | Latest stored rows, for privacy inspection (TC-09) |
| GET | `/api/health` | Status and event count |

Example event:

```json
{"event_uid": "c0a8...", "session_token": "5f1e...", "form_id": "checkout",
 "field_id": "postal_code", "event_type": "validation_error",
 "error_category": "format", "event_ts": 1793000000000,
 "device_category": "desktop", "browser_category": "chrome"}
```

Any extra key (for example `value`) causes the event to be rejected.

## Privacy

* The tracker never reads a field's value.
* Payment fields (`card_number`, `card_cvv`) are not instrumented (`data-track="off"`, `type=password`, `autocomplete=cc-*`).
* The server rejects unknown keys, so a value cannot be stored even if a client sends one.
* Only coarse device/browser categories are kept. There is no IP address or user-agent string.
* Logs record counts only, never request bodies.

## Metric definitions

See `analytics.py` or the "Metric definitions" panel on the dashboard. In short:
error rate and correction rate are **per visit**. Durations over 5 minutes or
without a blur are excluded from time metrics. A session is *abandoned* after
30 idle minutes without completing. Empty results show **N/A**, never 0.
