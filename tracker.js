/*
 * FormFlow field tracker.
 *
 * Embeds in any form and records field-level interaction events:
 *   focus, blur, input (first edit per visit), validation_error, correction,
 *   field_complete, form_start, form_submit, form_complete.
 *
 * Privacy rules enforced here:
 *   - The tracker never reads an element's value.
 *   - Fields with data-track="off", type="password", type="hidden" or an
 *     autocomplete token starting with "cc-" are never instrumented.
 *   - Only coarse device/browser categories are derived from the user agent.
 *
 * Usage:
 *   const tracker = FormFlow.init({ form: '#checkout', endpoint: '/api/events' });
 *   tracker.error('postal_code', 'format');   // called by your validation code
 *   tracker.fieldComplete('postal_code');
 *   tracker.formSubmit(); tracker.formComplete();
 */
(function (global) {
  'use strict';

  var SESSION_KEY = 'formflow_session';
  var FLUSH_INTERVAL_MS = 2000;
  var MAX_BATCH = 50;
  var MAX_QUEUE = 500;

  function randomId() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function deviceCategory() {
    var ua = navigator.userAgent;
    if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
    if (/Mobi|iPhone|Android/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  function browserCategory() {
    var ua = navigator.userAgent;
    if (/Edg\//.test(ua)) return 'edge';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Chrome\//.test(ua)) return 'chrome';
    if (/Safari\//.test(ua)) return 'safari';
    return 'other';
  }

  function isExcluded(el) {
    if (!el.name && !el.id) return true;
    if (el.dataset.track === 'off') return true;
    var type = (el.type || '').toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'submit' || type === 'button') return true;
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return ac.indexOf('cc-') === 0;
  }

  function fieldId(el) {
    return String(el.id || el.name).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);
  }

  function Tracker(opts) {
    this.form = typeof opts.form === 'string' ? document.querySelector(opts.form) : opts.form;
    if (!this.form) throw new Error('FormFlow: form not found');
    this.endpoint = opts.endpoint || '/api/events';
    this.formId = opts.formId || this.form.dataset.formId || 'form';
    this.onEvent = opts.onEvent || null;
    this.queue = [];
    this.inFlight = false;
    this.device = deviceCategory();
    this.browser = browserCategory();
    this.session = this._loadSession();
    this.fieldState = {}; // fieldId -> { hasError, typedThisVisit }
    this._bind();
  }

  Tracker.prototype._loadSession = function () {
    try {
      var saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (saved && saved.formId === this.formId) return saved;
    } catch (e) { /* storage unavailable: fall through to an in-memory session */ }
    return this._newSession();
  };

  Tracker.prototype._newSession = function () {
    var s = { token: randomId(), formId: this.formId, started: false };
    this._saveSession(s);
    return s;
  };

  Tracker.prototype._saveSession = function (s) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  };

  Tracker.prototype._state = function (id) {
    return this.fieldState[id] || (this.fieldState[id] = { hasError: false, typedThisVisit: false });
  };

  Tracker.prototype._bind = function () {
    if (this.form.dataset.formflowBound) return; // avoid duplicate listeners
    this.form.dataset.formflowBound = '1';
    var self = this;

    function target(e) {
      var el = e.target;
      if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || isExcluded(el)) return null;
      return fieldId(el);
    }

    this.form.addEventListener('focusin', function (e) {
      var id = target(e);
      if (!id) return;
      if (!self.session.started) {
        self.session.started = true;
        self._saveSession(self.session);
        self.record('form_start');
      }
      self._state(id).typedThisVisit = false;
      self.record('focus', id);
    });

    this.form.addEventListener('focusout', function (e) {
      var id = target(e);
      if (id) self.record('blur', id);
    });

    function onEdit(e) {
      var id = target(e);
      if (!id) return;
      var st = self._state(id);
      if (st.hasError) {
        st.hasError = false;
        self.record('correction', id);
      }
      if (!st.typedThisVisit) {
        st.typedThisVisit = true;
        self.record('input', id);
      }
    }
    this.form.addEventListener('input', onEdit);
    this.form.addEventListener('change', function (e) {
      if (e.target.tagName === 'SELECT') onEdit(e);
    });

    this._timer = setInterval(function () { self.flush(); }, FLUSH_INTERVAL_MS);
    // Deliver whatever is queued when the page is hidden or closed.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') self.flush(true);
    });
    global.addEventListener('pagehide', function () { self.flush(true); });
  };

  Tracker.prototype.record = function (type, field, extra) {
    var event = {
      event_uid: randomId(),
      session_token: this.session.token,
      form_id: this.formId,
      event_type: type,
      event_ts: Date.now(),
      device_category: this.device,
      browser_category: this.browser
    };
    if (field) event.field_id = field;
    if (extra && extra.error_category) event.error_category = extra.error_category;

    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.onEvent) { try { this.onEvent(event); } catch (e) { /* never break the form */ } }
    if (this.queue.length >= MAX_BATCH) this.flush();
  };

  // --- hooks for the page's own validation code ---------------------------

  Tracker.prototype.error = function (field, category) {
    this._state(field).hasError = true;
    this.record('validation_error', field, { error_category: category || 'other' });
  };

  Tracker.prototype.fieldComplete = function (field) {
    this._state(field).hasError = false;
    this.record('field_complete', field);
  };

  Tracker.prototype.formSubmit = function () { this.record('form_submit'); };

  Tracker.prototype.formComplete = function () {
    this.record('form_complete');
    this.flush(true);
    // The next journey gets a fresh random token.
    this.session = this._newSession();
    this.fieldState = {};
  };

  // --- delivery ------------------------------------------------------------

  Tracker.prototype.flush = function (unloading) {
    if (!this.queue.length || (this.inFlight && !unloading)) return;
    var batch = this.queue.splice(0, MAX_BATCH);
    var body = JSON.stringify({ events: batch });

    if (unloading && navigator.sendBeacon) {
      var sent = navigator.sendBeacon(this.endpoint, new Blob([body], { type: 'application/json' }));
      if (!sent) this.queue = batch.concat(this.queue);
      else if (this.queue.length) this.flush(true);
      return;
    }

    var self = this;
    this.inFlight = true;
    fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true
    }).then(function (res) {
      // 5xx: server problem, keep the events and retry. event_uid makes the
      // retry idempotent. 4xx: the batch itself is invalid, so drop it.
      if (res.status >= 500) self.queue = batch.concat(self.queue);
    }).catch(function () {
      self.queue = batch.concat(self.queue); // offline: retry on next tick
    }).then(function () {
      self.inFlight = false;
    });
  };

  global.FormFlow = {
    init: function (opts) { return new Tracker(opts || {}); }
  };
})(window);
