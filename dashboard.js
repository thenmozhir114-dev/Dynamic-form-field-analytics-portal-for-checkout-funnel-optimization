/*
 * Dashboard: fetches /api/metrics and renders summary tiles, rule-based
 * insights, HTML bar charts, SVG charts (timeline, outcomes donut, friction
 * map) and the sortable field table.
 * A null metric means "no observations" and is shown as N/A, never 0.
 */
(function () {
  'use strict';

  var LOW_SAMPLE = (window.FORMFLOW_RULES || {}).lowSample || 10;
  var REFRESH_MS = 5000;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    check: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3',
    exit: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    pointer: 'M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z',
    alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  };
  var OUTCOMES = [
    { key: 'completed', label: 'Completed', cls: 's-completed' },
    { key: 'abandoned', label: 'Abandoned', cls: 's-abandoned' },
    { key: 'in_progress', label: 'In progress', cls: 's-progress' },
  ];

  var filters = document.getElementById('filters');
  var tooltip = document.getElementById('tooltip');
  var state = { data: null, sortKey: 'order', sortDir: 1, timer: null };

  // ------------------------------------------------------------ formatting

  function pct(v) { return v == null ? 'N/A' : v + '%'; }
  function secs(v) { return v == null ? 'N/A' : v + ' s'; }
  function num(v) { return v == null ? 'N/A' : Number(v).toLocaleString(); }
  function duration(v) {
    if (v == null) return 'N/A';
    return v >= 60 ? Math.floor(v / 60) + ' min ' + Math.round(v % 60) + ' s' : v + ' s';
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'class') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function svg(tag, attrs, children) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  /* Rounded "nice" axis maximum and tick step for a positive value. */
  function niceScale(max, ticks) {
    if (!(max > 0)) return { max: 1, step: 1 };
    var raw = max / (ticks || 4);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; })
      .filter(function (v) { return v >= raw; })[0];
    return { max: Math.ceil(max / step) * step, step: step };
  }

  /* Bar path with only the top corners rounded (data-end), anchored to the baseline. */
  function topRounded(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z';
  }

  function icon(name) {
    return svg('svg', { class: 'tile-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [svg('path', { d: ICONS[name] })]);
  }

  function showTip(e, anchor, nodes) {
    tooltip.replaceChildren.apply(tooltip, nodes.filter(Boolean));
    tooltip.hidden = false;
    var rect = anchor.getBoundingClientRect();
    var x = e && e.clientX ? e.clientX : rect.left + rect.width / 2;
    var left = Math.min(x + 12, window.innerWidth - tooltip.offsetWidth - 8);
    tooltip.style.left = Math.max(8, left) + 'px';
    var y = e && e.clientY ? e.clientY + 14 : rect.bottom + 6;
    tooltip.style.top = (y + window.scrollY) + 'px';
  }
  function hideTip() { tooltip.hidden = true; }

  function hoverable(node, build) {
    node.setAttribute('tabindex', '0');
    function show(e) { showTip(e, node, build()); }
    node.addEventListener('mousemove', show);
    node.addEventListener('focus', show);
    node.addEventListener('mouseleave', hideTip);
    node.addEventListener('blur', hideTip);
    return node;
  }

  // ------------------------------------------------------------ data

  function query() {
    var params = new URLSearchParams();
    ['device', 'browser', 'days'].forEach(function (k) {
      var v = filters.elements[k].value;
      if (v) params.set(k, v);
    });
    params.set('tz', -new Date().getTimezoneOffset());
    return params.toString();
  }

  function load() {
    var qs = query();
    return fetch('/api/metrics' + (qs ? '?' + qs : ''))
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || 'Request failed (' + res.status + ')');
          return body;
        });
      })
      .then(function (data) {
        document.getElementById('error').hidden = true;
        state.data = data;
        render(data);
      })
      .catch(function (err) {
        var box = document.getElementById('error');
        box.textContent = 'Could not load metrics: ' + err.message;
        box.hidden = false;
      });
  }

  function loadRaw() {
    fetch('/api/events/recent?limit=25').then(function (r) { return r.json(); }).then(function (body) {
      var table = document.getElementById('raw-table');
      table.tHead.replaceChildren(el('tr', {}, body.columns.map(function (c) {
        return el('th', { scope: 'col', text: c });
      })));
      table.tBodies[0].replaceChildren.apply(table.tBodies[0], body.events.map(function (row) {
        return el('tr', {}, body.columns.map(function (c) {
          var v = row[c];
          return el('td', { text: v == null ? '' : String(v) });
        }));
      }));
    }).catch(function () { /* the inspector is optional */ });
  }

  // ------------------------------------------------------------ rendering

  function render(data) {
    var s = data.summary;
    var filtersInfo = data.filters;
    fillSelect(filters.elements.device, filtersInfo.devices, 'All devices');
    fillSelect(filters.elements.browser, filtersInfo.browsers, 'All browsers');

    document.getElementById('updated').textContent =
      data.total_events.toLocaleString() + ' events · updated ' + new Date(data.generated_at).toLocaleTimeString();

    var empty = s.sessions_started === 0;
    document.getElementById('empty').hidden = !empty;
    document.getElementById('content').hidden = empty;
    if (empty) return;

    renderTiles(s, data.timeline);
    renderInsights(data.fields);
    renderSvgCharts(data);

    var fields = data.fields;
    barChart('chart-errors', fields, 'error_rate', pct, 100, function (f) {
      return f.visits_with_errors + ' of ' + f.visits + ' visits had an error (' + f.error_events + ' error events)';
    });
    barChart('chart-time', fields, 'mean_time_s', secs, null, function (f) {
      return 'Median ' + secs(f.median_time_s) + ' · ' + f.valid_durations + ' valid durations of ' + f.visits + ' visits';
    });
    barChart('chart-dropoff', fields, 'dropoff_rate', pct, 100, function (f) {
      return f.dropoffs + ' of ' + f.sessions + ' sessions ended here';
    });
    barChart('chart-error-types', data.error_categories.map(function (c) {
      return { label: c.category[0].toUpperCase() + c.category.slice(1), count: c.count };
    }), 'count', num, null, function (c) {
      return Math.round(c.count / (s.validation_errors || 1) * 1000) / 10 + '% of all error events';
    });
    barChart('chart-devices', data.devices.map(function (d) {
      return Object.assign({ label: d.device[0].toUpperCase() + d.device.slice(1) }, d);
    }), 'completion_rate', pct, 100, function (d) {
      return d.completed + ' of ' + d.sessions + ' sessions completed, ' + d.abandoned + ' abandoned';
    });
    funnelChart(data.funnel);

    renderTable();
    loadRaw();
  }

  function fillSelect(select, values, allLabel) {
    var current = select.value;
    var wanted = [''].concat(values);
    if (current && wanted.indexOf(current) < 0) wanted.push(current);
    var existing = Array.prototype.map.call(select.options, function (o) { return o.value; });
    if (existing.join('|') === wanted.join('|')) return;
    select.replaceChildren.apply(select, wanted.map(function (v) {
      return el('option', { value: v, text: v ? v[0].toUpperCase() + v.slice(1) : allLabel });
    }));
    select.value = current;
  }

  function renderSvgCharts(data) {
    timelineChart(data.timeline);
    outcomesDonut(data.summary);
    frictionChart(data.fields);
  }

  function renderTiles(s, timeline) {
    var tiles = [
      ['Sessions started', num(s.sessions_started), s.in_progress + ' still in progress', 'blue', 'users'],
      ['Completion rate', pct(s.completion_rate), s.completed + ' completed', 'aqua', 'check'],
      ['Abandonment rate', pct(s.abandonment_rate), s.abandoned + ' abandoned (decided sessions)', 'orange', 'exit'],
      ['Field visits', num(s.field_visits), 'focus → blur intervals', 'violet', 'pointer'],
      ['Validation errors', num(s.validation_errors), 'all error events', 'red', 'alert'],
      ['Median checkout time', duration(s.median_checkout_s),
        s.avg_submit_attempts == null ? 'no submits yet' : 'avg. ' + s.avg_submit_attempts + ' submit attempt(s) per session',
        'magenta', 'clock'],
    ];
    document.getElementById('tiles').replaceChildren.apply(document.getElementById('tiles'), tiles.map(function (t, i) {
      return el('div', { class: 'tile tone-' + t[3] }, [
        el('div', { class: 'tile-top' }, [el('span', { class: 'tile-label', text: t[0] }), icon(t[4])]),
        el('span', { class: 'tile-value', text: t[1] }),
        el('span', { class: 'tile-sub', text: t[2] }),
        i === 0 ? sparkline(timeline.points.map(function (p) {
          return p.completed + p.abandoned + p.in_progress;
        })) : null,
      ]);
    }));
  }

  function sparkline(values) {
    if (values.length < 2) return null;
    var w = 120, h = 28, max = Math.max.apply(null, values) || 1;
    var pts = values.map(function (v, i) {
      return (i / (values.length - 1) * w).toFixed(1) + ',' + (h - 2 - v / max * (h - 4)).toFixed(1);
    }).join(' ');
    return svg('svg', { class: 'sparkline', viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      [svg('polyline', { points: pts })]);
  }

  /* Stacked columns: sessions per hour/day split by outcome. */
  function timelineChart(timeline) {
    var box = document.getElementById('chart-timeline');
    var pts = timeline.points;
    var legend = document.getElementById('timeline-legend');
    legend.replaceChildren.apply(legend, OUTCOMES.map(function (o) {
      return el('li', {}, [el('span', { class: 'swatch ' + o.cls }), document.createTextNode(o.label)]);
    }));
    document.getElementById('timeline-sub').textContent =
      'Checkout sessions per ' + timeline.bucket + ' by start time and outcome';
    if (!pts.length) { box.replaceChildren(el('p', { class: 'muted', text: 'No sessions in this period.' })); return; }

    var W = Math.max(box.clientWidth, 280), H = 280, m = { l: 36, r: 8, t: 10, b: 28 };
    var pw = W - m.l - m.r, ph = H - m.t - m.b;
    var totals = pts.map(function (p) { return p.completed + p.abandoned + p.in_progress; });
    var sc = niceScale(Math.max.apply(null, totals), 4);
    var band = pw / pts.length, bw = Math.max(2, Math.min(band * 0.7, 40));
    var y = function (v) { return m.t + ph - v / sc.max * ph; };
    var root = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Sessions per ' + timeline.bucket + ', stacked by outcome' });

    for (var t = 0; t <= sc.max; t += sc.step) {
      root.appendChild(svg('line', { class: t ? 'gridline' : 'axis', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
      root.appendChild(svg('text', { class: 'tick', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end', text: num(t) }));
    }

    var every = Math.ceil(pts.length * 56 / pw);
    pts.forEach(function (p, i) {
      var cx = m.l + band * i + band / 2;
      var hl = svg('rect', { class: 'band-hl', x: m.l + band * i, y: m.t, width: band, height: ph });
      root.appendChild(hl);
      var base = 0, top = OUTCOMES.filter(function (o) { return p[o.key]; }).pop();
      OUTCOMES.forEach(function (o) {
        var v = p[o.key];
        if (!v) return;
        var y0 = y(base + v), h = y(base) - y0 - (base ? 2 : 0);  // 2px surface gap between segments
        if (h > 0) {
          root.appendChild(o === top
            ? svg('path', { class: o.cls, d: topRounded(cx - bw / 2, y0, bw, h, 4) })
            : svg('rect', { class: o.cls, x: cx - bw / 2, y: y0, width: bw, height: h }));
        }
        base += v;
      });
      if (i % every === 0) {
        root.appendChild(svg('text', { class: 'tick', x: cx, y: H - 8, 'text-anchor': 'middle', text: bucketLabel(p.ts, timeline.bucket, true) }));
      }
      var hit = svg('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ph + m.b,
        'aria-label': bucketLabel(p.ts, timeline.bucket) + ': ' + totals[i] + ' sessions' });
      hit.addEventListener('mouseenter', function () { hl.classList.add('on'); });
      hit.addEventListener('mouseleave', function () { hl.classList.remove('on'); });
      root.appendChild(hoverable(hit, function () {
        return [el('b', { text: bucketLabel(p.ts, timeline.bucket) }),
          el('div', { class: 'muted', text: totals[i] + ' sessions started' })].concat(OUTCOMES.map(function (o) {
          return el('div', { class: 'tip-row' }, [el('span', { class: 'swatch ' + o.cls }),
            el('span', { text: o.label }), el('b', { text: String(p[o.key]) })]);
        }));
      }));
    });
    box.replaceChildren(root);
  }

  function bucketLabel(ts, bucket, short) {
    var d = new Date(ts);
    var day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    if (bucket === 'day') return short ? day : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    var hour = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return short ? (d.getHours() === 0 ? day : hour) : day + ', ' + hour;
  }

  /* Part-to-whole of session outcomes, completion rate in the centre. */
  function outcomesDonut(s) {
    var box = document.getElementById('chart-outcomes');
    var total = s.sessions_started, size = 180, r = 70, sw = 24, c = 2 * Math.PI * r;
    var root = svg('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, role: 'img',
      'aria-label': 'Session outcomes: ' + OUTCOMES.map(function (o) { return s[o.key] + ' ' + o.label; }).join(', ') });
    root.appendChild(svg('circle', { class: 'donut-track', cx: size / 2, cy: size / 2, r: r, 'stroke-width': sw }));
    var offset = 0;
    var parts = OUTCOMES.filter(function (o) { return s[o.key] > 0; }).length;
    var legend = el('ul', { class: 'donut-legend' });
    OUTCOMES.forEach(function (o) {
      var v = s[o.key], share = total ? v / total : 0;
      var len = share * c, gap = parts > 1 ? 2 : 0;
      function tip() {
        return [el('b', { text: o.label }), el('div', { text: num(v) + ' sessions (' + pct(Math.round(share * 1000) / 10) + ')' })];
      }
      if (v > 0) {
        var seg = svg('circle', { class: 'donut-seg ' + o.cls, cx: size / 2, cy: size / 2, r: r, 'stroke-width': sw,
          'stroke-dasharray': Math.max(len - gap, 0.5) + ' ' + c, 'stroke-dashoffset': -offset,
          transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')', 'aria-label': o.label + ': ' + v });
        root.appendChild(hoverable(seg, tip));
        offset += len;
      }
      legend.appendChild(hoverable(el('li', {}, [el('span', { class: 'swatch ' + o.cls }),
        el('span', { class: 'lg-label', text: o.label }), el('b', { text: num(v) }),
        el('span', { class: 'muted', text: total ? Math.round(share * 100) + '%' : '' })]), tip));
    });
    root.appendChild(svg('text', { class: 'donut-value', x: size / 2, y: size / 2 + 4, 'text-anchor': 'middle', text: pct(s.completion_rate) }));
    root.appendChild(svg('text', { class: 'donut-label', x: size / 2, y: size / 2 + 24, 'text-anchor': 'middle', text: 'completed' }));
    box.replaceChildren(root, legend);
  }

  /* Scatter: mean time (x) vs error rate (y), bubble area ~ visits. */
  function frictionChart(fields) {
    var box = document.getElementById('chart-friction');
    var rows = fields.filter(function (f) { return f.mean_time_s != null && f.error_rate != null; });
    if (!rows.length) { box.replaceChildren(el('p', { class: 'muted', text: 'Not enough timed visits yet.' })); return; }
    var W = Math.max(box.clientWidth, 280), H = 300, m = { l: 48, r: 16, t: 16, b: 40 };
    var pw = W - m.l - m.r, ph = H - m.t - m.b;
    var xs = niceScale(Math.max.apply(null, rows.map(function (f) { return f.mean_time_s; })), 5);
    var ys = niceScale(Math.max(10, Math.max.apply(null, rows.map(function (f) { return f.error_rate; }))), 4);
    var maxVisits = Math.max.apply(null, rows.map(function (f) { return f.visits; })) || 1;
    var X = function (v) { return m.l + v / xs.max * pw; };
    var Y = function (v) { return m.t + ph - v / ys.max * ph; };
    var R = function (v) { return 5 + Math.sqrt(v / maxVisits) * 13; };
    var root = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Field friction map: mean time versus error rate' });

    for (var t = 0; t <= ys.max; t += ys.step) {
      root.appendChild(svg('line', { class: t ? 'gridline' : 'axis', x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
      root.appendChild(svg('text', { class: 'tick', x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end', text: t + '%' }));
    }
    for (var u = 0; u <= xs.max; u += xs.step) {
      root.appendChild(svg('text', { class: 'tick', x: X(u), y: m.t + ph + 16, 'text-anchor': 'middle', text: u + ' s' }));
    }
    root.appendChild(svg('text', { class: 'axis-title', x: m.l + pw / 2, y: H - 4, 'text-anchor': 'middle', text: 'Mean time on field' }));
    root.appendChild(svg('text', { class: 'axis-title', x: 12, y: m.t + ph / 2, 'text-anchor': 'middle',
      transform: 'rotate(-90 12 ' + (m.t + ph / 2) + ')', text: 'Error rate' }));

    // Median guides split the plot into quadrants.
    function median(a) {
      a = a.slice().sort(function (p, q) { return p - q; });
      var k = a.length >> 1;
      return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2;
    }
    var mx = median(rows.map(function (f) { return f.mean_time_s; }));
    var my = median(rows.map(function (f) { return f.error_rate; }));
    root.appendChild(svg('line', { class: 'guide', x1: X(mx), x2: X(mx), y1: m.t, y2: m.t + ph }));
    root.appendChild(svg('line', { class: 'guide', x1: m.l, x2: W - m.r, y1: Y(my), y2: Y(my) }));
    root.appendChild(svg('text', { class: 'quadrant', x: W - m.r - 4, y: m.t + 12, 'text-anchor': 'end', text: 'Slow & error-prone' }));

    // Largest bubbles first so small ones stay on top and hoverable.
    rows.slice().sort(function (a, b) { return b.visits - a.visits; }).forEach(function (f) {
      root.appendChild(hoverable(svg('circle', { class: 'bubble' + (f.low_sample ? ' low' : ''),
        cx: X(f.mean_time_s), cy: Y(f.error_rate), r: R(f.visits),
        'aria-label': f.label + ': ' + secs(f.mean_time_s) + ', ' + pct(f.error_rate) + ' error rate' }), function () {
        return [el('b', { text: f.label }),
          el('div', { text: 'Mean time ' + secs(f.mean_time_s) + ' · error rate ' + pct(f.error_rate) }),
          el('div', { class: 'muted', text: f.visits + ' visits · drop-off ' + pct(f.dropoff_rate) }),
          f.low_sample ? el('div', { class: 'warn', text: 'Small sample: ' + f.visits + ' visits' }) : null];
      }));
    });

    // Label only the fields furthest into the top-right corner.
    var score = function (f) { return f.mean_time_s / xs.max + f.error_rate / ys.max; };
    rows.slice().sort(function (a, b) { return score(b) - score(a); }).slice(0, 4).forEach(function (f) {
      var cx = X(f.mean_time_s), cy = Y(f.error_rate), r = R(f.visits);
      var right = cx + r + 120 < W;
      root.appendChild(svg('text', { class: 'point-label', x: right ? cx + r + 4 : cx - r - 4, y: cy + 4,
        'text-anchor': right ? 'start' : 'end', text: f.label }));
    });
    box.replaceChildren(root);
  }

  /* Funnel as horizontal bars, plus the loss from the previous stage. */
  function funnelChart(funnel) {
    var box = document.getElementById('chart-funnel');
    var started = funnel[0].sessions || 1;
    box.replaceChildren.apply(box, funnel.map(function (st, i) {
      var prev = i ? funnel[i - 1].sessions : null;
      var loss = prev ? Math.round((prev - st.sessions) / prev * 100) : null;
      var share = Math.round(st.sessions / started * 1000) / 10;
      var bar = el('div', { class: 'bar' });
      bar.style.width = Math.max(share, st.sessions ? 1 : 0) + '%';
      return hoverable(el('div', { class: 'bar-row funnel-row', 'aria-label': st.stage + ': ' + st.sessions + ' sessions' }, [
        el('span', { class: 'bar-label', text: st.stage }),
        el('span', { class: 'bar-track' }, [bar]),
        el('span', { class: 'bar-value', text: num(st.sessions) }),
        el('span', { class: 'funnel-loss', text: loss == null ? '' : loss > 0 ? '−' + loss + '%' : '0%' }),
      ]), function () {
        return [el('b', { text: st.stage }), el('div', { text: num(st.sessions) + ' sessions · ' + share + '% of started' }),
          loss == null ? null : el('div', { class: 'muted', text: (prev - st.sessions) + ' lost since the previous stage (' + loss + '%)' })];
      });
    }));
  }

  function renderInsights(fields) {
    var ok = fields.filter(function (f) { return f.visits >= LOW_SAMPLE; });
    function top(key) {
      return ok.filter(function (f) { return f[key] != null && f[key] > 0; })
        .sort(function (a, b) { return b[key] - a[key]; })[0];
    }
    var items = [];
    var err = top('error_rate');
    if (err) items.push([err.label, 'has the highest error rate (' + pct(err.error_rate) + ').',
      'Check its format hint, example and validation message.', 'red', 'alert']);
    var slow = top('mean_time_s');
    if (slow) items.push([slow.label, 'takes the longest on average (' + secs(slow.mean_time_s) + ').',
      'Compare with fields of similar complexity before changing it.', 'violet', 'clock']);
    var drop = top('dropoff_rate');
    if (drop) items.push([drop.label, 'is where the most abandoned sessions ended (' + pct(drop.dropoff_rate) + ').',
      'Review what the user sees at this point of the form.', 'orange', 'exit']);

    var list = document.getElementById('insights');
    if (!items.length) {
      list.replaceChildren(el('li', { class: 'muted', text: 'Not enough observations yet to rank fields.' }));
      return;
    }
    list.replaceChildren.apply(list, items.map(function (i) {
      return el('li', { class: 'tone-' + i[3] }, [icon(i[4]), el('b', { text: i[0] }), document.createTextNode(' ' + i[1] + ' '),
        el('span', { class: 'muted', text: i[2] })]);
    }));
  }

  /* Horizontal bar chart built from plain HTML so it reflows on any width. */
  function barChart(id, rows, key, fmt, max, detail) {
    var container = document.getElementById(id);
    var values = rows.map(function (r) { return r[key]; }).filter(function (v) { return v != null; });
    var scale = max || Math.max.apply(null, values.concat([0])) || 1;
    container.replaceChildren.apply(container, rows.map(function (r) {
      var v = r[key];
      var bar = el('div', { class: 'bar' + (r.low_sample ? ' hatched' : '') });
      bar.style.width = v == null ? '0' : Math.max(v / scale * 100, v > 0 ? 1 : 0) + '%';
      var row = el('div', {
        class: 'bar-row' + (v == null ? ' na' : ''),
        tabindex: '0',
        'aria-label': r.label + ': ' + fmt(v) + '. ' + detail(r),
      }, [
        el('span', { class: 'bar-label', text: r.label }),
        el('span', { class: 'bar-track' }, [bar]),
        el('span', { class: 'bar-value', text: fmt(v) }),
      ]);
      function show(e) {
        tooltip.replaceChildren(el('b', { text: r.label }), el('div', { text: fmt(v) }),
          el('div', { class: 'muted', text: v == null ? 'No observations' : detail(r) }),
          r.low_sample ? el('div', { class: 'warn', text: 'Small sample: ' + r.visits + ' visits' }) : null);
        tooltip.hidden = false;
        var rect = row.getBoundingClientRect();
        var x = e && e.clientX ? e.clientX : rect.left + rect.width / 2;
        var left = Math.min(x + 12, window.innerWidth - tooltip.offsetWidth - 8);
        tooltip.style.left = Math.max(8, left) + 'px';
        tooltip.style.top = (rect.bottom + window.scrollY + 6) + 'px';
      }
      row.addEventListener('mousemove', show);
      row.addEventListener('focus', show);
      row.addEventListener('mouseleave', function () { tooltip.hidden = true; });
      row.addEventListener('blur', function () { tooltip.hidden = true; });
      return row;
    }));
  }

  function renderTable() {
    var fields = state.data.fields.map(function (f, i) { return Object.assign({ order: i }, f); });
    var key = state.sortKey, dir = state.sortDir;
    fields.sort(function (a, b) {
      var x = a[key], y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1; // N/A always last
      if (y == null) return -1;
      return (x - y) * dir;
    });
    var maxOf = {};
    ['error_rate', 'correction_rate', 'dropoff_rate'].forEach(function (k) {
      maxOf[k] = Math.max.apply(null, fields.map(function (f) { return f[k] || 0; })) || 1;
    });
    function heat(k, f) {
      var td = el('td', { class: 'num heat', text: pct(f[k]) });
      td.style.setProperty('--heat', f[k] == null ? 0 : f[k] / maxOf[k]);
      return td;
    }
    var tbody = document.querySelector('#field-table tbody');
    tbody.replaceChildren.apply(tbody, fields.map(function (f) {
      var name = el('th', { scope: 'row' }, [el('span', { text: f.label }),
        f.low_sample ? el('span', { class: 'badge', text: 'small sample', title: 'Fewer than ' + LOW_SAMPLE + ' visits' }) : null]);
      return el('tr', {}, [name,
        el('td', { class: 'num', text: num(f.visits) }),
        el('td', { class: 'num', text: secs(f.mean_time_s) }),
        el('td', { class: 'num', text: secs(f.median_time_s) }),
        heat('error_rate', f),
        heat('correction_rate', f),
        el('td', { class: 'num', text: pct(f.progression_rate) }),
        heat('dropoff_rate', f),
      ]);
    }));
    document.querySelectorAll('#field-table th[data-key]').forEach(function (th) {
      var active = th.dataset.key === key;
      th.setAttribute('aria-sort', active ? (dir > 0 ? 'ascending' : 'descending') : 'none');
    });
  }

  // ------------------------------------------------------------ wiring

  document.querySelectorAll('#field-table th[data-key]').forEach(function (th) {
    th.tabIndex = 0;
    function sort() {
      var k = th.dataset.key;
      state.sortDir = state.sortKey === k ? -state.sortDir : (k === 'order' ? 1 : -1);
      state.sortKey = k;
      if (state.data) renderTable();
    }
    th.addEventListener('click', sort);
    th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
  });

  function schedule() {
    clearInterval(state.timer);
    if (filters.elements.live.checked) state.timer = setInterval(load, REFRESH_MS);
  }

  filters.addEventListener('change', function (e) {
    if (e.target.name === 'live') schedule();
    else load();
  });
  document.getElementById('refresh').addEventListener('click', load);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') clearInterval(state.timer);
    else { load(); schedule(); }
  });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.data && state.data.summary.sessions_started) renderSvgCharts(state.data);
    }, 150);
  });

  load();
  schedule();
})();
