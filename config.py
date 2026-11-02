"""Central configuration for the Form Field Analytics Portal.

Every rule that affects how metrics are calculated lives here so that the
dashboard, the report and the code all describe the same definitions.
"""

import os

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

# SQLite database file. Override with the FORMFLOW_DB environment variable.
DATABASE = os.environ.get("FORMFLOW_DB", os.path.join(BASE_DIR, "instance", "formflow.db"))

# Largest request body accepted by the ingestion endpoint (bytes).
MAX_CONTENT_LENGTH = 64 * 1024

# Largest number of events accepted in one batch request.
MAX_BATCH_SIZE = 100

# --- Controlled vocabularies -------------------------------------------------

FIELD_EVENTS = {"focus", "blur", "input", "validation_error", "correction", "field_complete"}
FORM_EVENTS = {"form_start", "form_submit", "form_complete"}
ALLOWED_EVENTS = FIELD_EVENTS | FORM_EVENTS

DEVICE_CATEGORIES = {"desktop", "mobile", "tablet", "unknown"}
BROWSER_CATEGORIES = {"chrome", "edge", "firefox", "safari", "other", "unknown"}
ERROR_CATEGORIES = {"required", "format", "length", "other"}

# --- Metric rules ------------------------------------------------------------

# Focus-to-blur intervals longer than this are excluded from time metrics
# (the user probably switched to another task). 5 minutes.
MAX_DURATION_MS = 5 * 60 * 1000

# A session that has not completed and has had no events for this many
# minutes is classified as "abandoned"; before that it is "in progress".
ABANDON_WINDOW_MIN = 30

# Fields with fewer observed visits than this are flagged as a small sample.
LOW_SAMPLE_VISITS = 10

# --- Checkout form definition ------------------------------------------------
# The checkout page is rendered from this list, and the analytics engine uses
# the same order to decide whether a visit progressed to a later field.
# Fields with "track": False are never instrumented (sensitive payment data).

STATES = ["Tamil Nadu", "Karnataka", "Kerala", "Andhra Pradesh", "Telangana", "Maharashtra", "Delhi"]

FORM_SECTIONS = [
    {
        "title": "Contact details",
        "fields": [
            {"id": "full_name", "label": "Full name", "type": "text", "required": True,
             "minlength": 2, "autocomplete": "name",
             "error": "Enter your full name (at least 2 characters)."},
            {"id": "email", "label": "Email address", "type": "email", "required": True,
             "pattern": r"^[^@\s]+@[^@\s]+\.[^@\s]+$", "autocomplete": "email",
             "hint": "We send the order confirmation here.",
             "error": "Enter an email address like name@example.com."},
            {"id": "phone", "label": "Mobile number", "type": "tel", "required": True,
             "pattern": r"^[6-9]\d{9}$", "autocomplete": "tel-national",
             "hint": "10 digits, without +91 or spaces.",
             "error": "Enter a 10-digit mobile number starting with 6, 7, 8 or 9."},
        ],
    },
    {
        "title": "Shipping address",
        "fields": [
            {"id": "address_line", "label": "Address line", "type": "text", "required": True,
             "minlength": 5, "autocomplete": "street-address",
             "hint": "House number, street and area.",
             "error": "Enter your street address (at least 5 characters)."},
            {"id": "city", "label": "City", "type": "text", "required": True,
             "minlength": 2, "autocomplete": "address-level2",
             "error": "Enter your city."},
            {"id": "state", "label": "State", "type": "select", "required": True,
             "options": STATES, "error": "Choose your state."},
            {"id": "postal_code", "label": "PIN code", "type": "text", "required": True,
             "pattern": r"^\d{6}$", "autocomplete": "postal-code", "inputmode": "numeric",
             "error": "Enter a 6-digit PIN code."},
        ],
    },
    {
        "title": "Delivery",
        "fields": [
            {"id": "delivery_method", "label": "Delivery method", "type": "select", "required": True,
             "options": ["Standard (3-5 days)", "Express (1-2 days)", "Store pickup"],
             "error": "Choose a delivery method."},
            {"id": "contact_preference", "label": "Delivery updates via", "type": "select",
             "required": False, "options": ["Email", "SMS", "No updates"]},
            {"id": "promo_code", "label": "Promo code (optional)", "type": "text", "required": False,
             "pattern": r"^[A-Z0-9]{4,10}$",
             "hint": "4-10 capital letters or digits.",
             "error": "Promo codes use 4-10 capital letters or digits, e.g. SAVE10."},
        ],
    },
    {
        "title": "Payment (simulated - not tracked, never sent)",
        "fields": [
            {"id": "card_number", "label": "Card number", "type": "text", "required": True,
             "track": False, "pattern": r"^\d{16}$", "autocomplete": "cc-number",
             "inputmode": "numeric", "hint": "Use a dummy number such as 4111111111111111.",
             "error": "Enter 16 digits."},
            {"id": "card_cvv", "label": "CVV", "type": "password", "required": True,
             "track": False, "pattern": r"^\d{3}$", "autocomplete": "cc-csc",
             "inputmode": "numeric", "error": "Enter 3 digits."},
        ],
    },
]

TRACKED_FIELD_ORDER = [
    f["id"] for section in FORM_SECTIONS for f in section["fields"] if f.get("track", True)
]

FIELD_LABELS = {f["id"]: f["label"] for section in FORM_SECTIONS for f in section["fields"]}
