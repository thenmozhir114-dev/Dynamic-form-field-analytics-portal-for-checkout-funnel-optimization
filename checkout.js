/*
 * Checkout page logic: client-side validation and the live event log.
 * Validation results are reported to the tracker as categories only
 * (required / length / format); field values never leave this file.
 */
(function () {
  'use strict';

  var form = document.getElementById('checkout');
  var logList = document.getElementById('event-log');
  var done = document.getElementById('done');
  var LOG_LIMIT = 40;

  var tracker = FormFlow.init({ form: form, endpoint: '/api/events', onEvent: logEvent });

  function controls() {
    return Array.prototype.slice.call(form.querySelectorAll('input, select'));
  }

  function isTracked(el) {
    return el.dataset.track !== 'off';
  }

  /* Returns null when valid, otherwise the error category. */
  function check(el) {
    var v = (el.value || '').trim();
    if (!v) return el.required ? 'required' : null;
    var min = parseInt(el.getAttribute('minlength'), 10);
    if (min && v.length < min) return 'length';
    if (el.dataset.pattern && !new RegExp(el.dataset.pattern).test(v)) return 'format';
    return null;
  }

  function showError(el, category) {
    var wrap = el.closest('.field');
    var msg = document.getElementById(el.id + '-msg');
    wrap.classList.toggle('has-error', !!category);
    el.setAttribute('aria-invalid', category ? 'true' : 'false');
    msg.textContent = category ? (el.dataset.error || 'Please check this field.') : '';
  }

  function report(el, category) {
    if (!isTracked(el)) return; // payment fields are never reported
    if (category) tracker.error(el.id, category);
    else tracker.fieldComplete(el.id);
  }

  // Validate when the user leaves a field. A required field that was merely
  // tabbed past is not flagged until submit.
  form.addEventListener('focusout', function (e) {
    var el = e.target;
    if (!/^(INPUT|SELECT)$/.test(el.tagName)) return;
    var empty = !(el.value || '').trim();
    var hadError = el.closest('.field').classList.contains('has-error');
    if (empty && !hadError) return;
    var category = check(el);
    showError(el, category);
    if (category || !empty) report(el, category);
  });

  // Clear the message as soon as the value becomes valid. The correction
  // event itself is recorded by the tracker.
  function clearIfFixed(e) {
    var el = e.target;
    if (el.closest('.field.has-error') && !check(el)) showError(el, null);
  }
  form.addEventListener('input', clearIfFixed);
  form.addEventListener('change', clearIfFixed);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    tracker.formSubmit();

    var firstInvalid = null;
    controls().forEach(function (el) {
      var category = check(el);
      showError(el, category);
      if (category) {
        report(el, category);
        firstInvalid = firstInvalid || el;
      }
    });
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    tracker.formComplete();
    form.reset();
    form.closest('.checkout-layout').hidden = true;
    done.hidden = false;
    window.scrollTo(0, 0);
  });

  function logEvent(ev) {
    var li = document.createElement('li');
    var tag = document.createElement('span');
    tag.className = 'tag tag-' + ev.event_type;
    tag.textContent = ev.event_type;
    li.appendChild(tag);
    if (ev.field_id) {
      var code = document.createElement('code');
      code.textContent = ev.field_id;
      li.appendChild(code);
    }
    if (ev.error_category) {
      var cat = document.createElement('span');
      cat.className = 'muted';
      cat.textContent = ' (' + ev.error_category + ')';
      li.appendChild(cat);
    }
    var empty = logList.querySelector('.empty');
    if (empty) empty.remove();
    logList.insertBefore(li, logList.firstChild);
    while (logList.children.length > LOG_LIMIT) logList.removeChild(logList.lastChild);
  }

  var hint = document.createElement('li');
  hint.className = 'muted empty';
  hint.textContent = 'Click into a field to start.';
  logList.appendChild(hint);
})();
