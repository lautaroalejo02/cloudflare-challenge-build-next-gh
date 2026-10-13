/* ARB dashboard UI. Static files, no build step, no external deps.
 * Data flow: /api/ws (snapshot first, then incremental ArbEvents) with
 * reconnect; falls back to polling /api/state every 1s while the socket is down.
 * Mock mode: ?mock=1 or window.__ARB_MOCK__ replays mock.js locally. */
(function () {
  'use strict';

  var A = window.ArbState;
  var MOCK = window.__ARB_MOCK__ === true ||
    /[?&]mock=1\b/.test(location.search) ||
    /mock\.html$/.test(location.pathname);

  var state = A.createState();
  var connMode = 'init'; // init | ws | poll | offline | mock

  /* ---------- DOM skeleton ---------- */

  var el = {};
  function build() {
    document.body.classList.add('arb');
    document.body.innerHTML =
      '<header class="topbar">' +
      '  <div class="brand">AGENT&nbsp;REORDER&nbsp;BUFFER' +
      '    <span class="brand-sub">speculative forwarding · out-of-order agents</span>' +
      (MOCK ? '    <span class="mock-chip">MOCK REPLAY</span>' : '') +
      '  </div>' +
      '  <div class="top-right">' +
      (MOCK ? '    <button id="replay" class="btn">↺ replay</button>' : '') +
      '    <div class="conn"><span id="conn-dot" class="dot"></span><span id="conn-text">connecting</span></div>' +
      '  </div>' +
      '</header>' +
      '<div class="statsbar" id="statsbar">' +
      '  <div class="stat"><span class="stat-num" id="s-squashes">0</span><span class="stat-label">squashes</span></div>' +
      '  <div class="stat"><span class="stat-num" id="s-cutoffs">0</span><span class="stat-label">early cutoffs</span></div>' +
      '  <div class="stat"><span class="stat-num pred" id="s-pred">0 hit / 0 miss</span><span class="stat-label">stub predictions</span></div>' +
      '  <div class="stat"><span class="stat-num" id="s-retired">0</span><span class="stat-label">retired</span></div>' +
      '  <div class="stat"><span class="stat-num" id="s-checks">0</span><span class="stat-label">checks run</span></div>' +
      '  <div class="stat"><span class="stat-num" id="s-pushes">0</span><span class="stat-label">pushes seen</span></div>' +
      '  <div class="stat"><span class="stat-num" id="s-reforkt">—</span><span class="stat-label">re-fork ready</span></div>' +
      '  <div class="controls">' +
      '    <label for="robsize">robSize</label>' +
      '    <input type="range" id="robsize" min="1" max="16" step="1" value="8">' +
      '    <span id="robsize-val" class="mono">8</span>' +
      '  </div>' +
      '</div>' +
      '<main class="main">' +
      '  <section class="pipeline" id="pipeline">' +
      '    <svg id="links" class="links"></svg>' +
      '    <div id="lanes" class="lanes"></div>' +
      '    <div id="trunk" class="trunk">' +
      '      <span class="trunk-label" id="trunk-anchor">TRUNK</span>' +
      '      <span class="mono" id="trunk-repo">arb-trunk</span>' +
      '      <span class="mono dim" id="trunk-commit"></span>' +
      '      <span class="dim" id="trunk-count"></span>' +
      '      <div class="trunk-chips" id="trunk-chips"></div>' +
      '    </div>' +
      '  </section>' +
      '  <aside class="logpanel"><h2>event log</h2><div id="log" class="log"></div></aside>' +
      '</main>';

    el.lanes = document.getElementById('lanes');
    el.links = document.getElementById('links');
    el.pipeline = document.getElementById('pipeline');
    el.log = document.getElementById('log');
    el.trunkChips = document.getElementById('trunk-chips');
    el.trunkCommit = document.getElementById('trunk-commit');
    el.trunkRepo = document.getElementById('trunk-repo');
    el.trunkCount = document.getElementById('trunk-count');
    el.connDot = document.getElementById('conn-dot');
    el.connText = document.getElementById('conn-text');
    el.robsize = document.getElementById('robsize');
    el.robsizeVal = document.getElementById('robsize-val');
    el.stats = {
      squashes: document.getElementById('s-squashes'),
      earlyCutoffs: document.getElementById('s-cutoffs'),
      retired: document.getElementById('s-retired'),
      checksRun: document.getElementById('s-checks'),
      pushesSeen: document.getElementById('s-pushes')
    };
    el.predStat = document.getElementById('s-pred');
    el.reforkT = document.getElementById('s-reforkt');

    el.robsize.addEventListener('input', function () {
      el.robsizeVal.textContent = el.robsize.value;
    });
    el.robsize.addEventListener('change', function () {
      setRobSize(parseInt(el.robsize.value, 10));
    });
    el.lanes.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-veto]');
      if (btn) vetoEntry(btn.getAttribute('data-veto'));
    });
    var replay = document.getElementById('replay');
    if (replay) replay.addEventListener('click', startMock);
    window.addEventListener('resize', scheduleLinks);
    el.pipeline.addEventListener('scroll', scheduleLinks);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(scheduleLinks).observe(el.pipeline);
    }
  }

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function h4(h) { return '#' + A.shortHash(h); }
  function c7(c) { return A.shortCommit(c); }
  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function recent(at, ms) { return at && (Date.now() - at) < ms; }

  /* ---------- render ---------- */

  var prevRects = {}; // entryId -> DOMRect, for FLIP retirement animation

  function render() {
    Object.keys(el.stats).forEach(function (k) {
      el.stats[k].textContent = state.stats[k];
    });
    el.predStat.textContent = state.stats.predictionHits + ' hit / ' + state.stats.predictionMisses + ' miss';
    var rf = A.reforkTiming(state);
    el.reforkT.textContent = !rf ? '—' : (rf.deltaMs / 1000).toFixed(1) + ' s';
    if (document.activeElement !== el.robsize) {
      el.robsize.value = state.robSize;
      el.robsizeVal.textContent = state.robSize;
    }

    prevRects = snapshotRects();
    renderLanes();
    renderTrunk();
    renderLog();
    scheduleLinks();
    animateRetirements();
  }

  function snapshotRects() {
    var out = {};
    var rows = el.pipeline.querySelectorAll('[data-row-id]');
    rows.forEach(function (r) { out[r.getAttribute('data-row-id')] = r.getBoundingClientRect(); });
    return out;
  }

  function liveEntries() {
    return state.entries.filter(function (e) { return e.status !== 'retired'; });
  }
  function retiredEntries() {
    return state.entries.filter(function (e) { return e.status === 'retired'; })
      .sort(function (a, b) { return a.seq - b.seq; });
  }

  function renderLanes() {
    var live = liveEntries();
    var head = A.headEntry(state);
    var lanes = [];
    var byLane = {};
    live.forEach(function (e) {
      if (!byLane[e.lane]) { byLane[e.lane] = []; lanes.push(e.lane); }
      byLane[e.lane].push(e);
    });
    lanes.sort(function (a, b) {
      return Math.min.apply(null, byLane[a].map(function (e) { return e.seq; })) -
        Math.min.apply(null, byLane[b].map(function (e) { return e.seq; }));
    });

    var html = '';
    if (!live.length) {
      html = '<div class="empty">buffer empty — waiting for agents…</div>';
    }
    lanes.forEach(function (lane) {
      html += '<div class="lane"><div class="lane-label">' + esc(lane) + '</div><div class="lane-rows">';
      byLane[lane].forEach(function (e) { html += rowHtml(e, head === e); });
      html += '</div></div>';
    });
    el.lanes.innerHTML = html;
  }

  function rowHtml(e, isHead) {
    var now = Date.now();
    var cls = 'row status-' + e.status;
    if (recent(e._squashAt, 1800)) cls += ' flash-squash';
    if (recent(e._cutoffAt, 1600)) cls += ' pulse-cutoff';
    if (recent(e._hashAt, 1200)) cls += ' pulse-hash';
    if (isHead) cls += ' is-head';

    var stage = A.stageIndex(e);
    var track = '<div class="track">';
    A.STAGES.forEach(function (s, i) {
      var st = i < stage ? 'done' : (i === stage ? 'cur' : 'todo');
      if (e.status === 'failed' && i === stage) st = 'cur fail';
      if (e.status === 'vetoed') st = 'todo';
      track += '<div class="stg ' + st + '"><span class="stg-dot"></span><span class="stg-name">' + s + '</span></div>';
      if (i < A.STAGES.length - 1) track += '<div class="stg-line ' + (i < stage ? 'done' : '') + '"></div>';
    });
    track += '</div>';

    var fwd = '';
    var prod = e.producerId ? A.findEntry(state, e.producerId) : null;
    Object.keys(e.consumes).forEach(function (sym) {
      // Forwarded against the producer's DECLARED stub while predicted[] holds
      // it; the verdict tick lands on the row when the first real push scores it.
      var isPred = !!(prod && prod.predicted && prod.predicted.indexOf(sym) >= 0);
      var tick = e._predTicks && e._predTicks[sym];
      fwd += '<span class="tag fwd' + (isPred ? ' pred' : '') + '" title="' + esc(e.consumes[sym]) +
        (isPred ? ' · predicted from declared stub — unconfirmed' : '') + '">' +
        'forwarded: ' + esc(sym) + '<b>' + h4(e.consumes[sym]) + '</b>' +
        (e.producerId ? '<i>← ' + esc(e.producerId) + '</i>' : '') +
        (isPred ? '<i class="pred-mark">≈ stub</i>' : '') +
        (tick ? '<i class="pred-tick ' + tick + '">' + (tick === 'hit' ? '✓ hit' : '✗ miss') + '</i>' : '') +
        '</span>';
    });

    var exp = '';
    Object.keys(e.exports).forEach(function (sym) {
      var isPred = e.predicted && e.predicted.indexOf(sym) >= 0;
      exp += '<span class="tag exp' + (isPred ? ' pred' : '') + '" title="' + esc(e.exports[sym]) +
        (isPred ? ' · declared stub — unconfirmed' : '') + '">' +
        esc(sym) + '<b>' + h4(e.exports[sym]) + '</b>' + (isPred ? '<i class="pred-mark">≈</i>' : '') + '</span>';
    });

    var diag = '';
    if (e.diagnosis) {
      var reasons = {
        'interface-changed': 'interface changed',
        'producer-vetoed': 'producer vetoed',
        'producer-squashed': 'producer squashed',
        'trunk-overlap': 'trunk overlap',
        'prediction-miss': 'stub prediction miss'
      };
      var reason = reasons[e.diagnosis.reason] || e.diagnosis.reason || 'squashed';
      var baseLabel = e.diagnosis.reason === 'trunk-overlap' ? 'trunk' : 'producer';
      diag += '<div class="diag"><div class="diag-head">SQUASHED · ' + esc(reason) +
        ' · ' + baseLabel + ' @ ' + c7(e.diagnosis.producerCommit) + '</div>';
      (e.diagnosis.changed || []).slice(0, 2).forEach(function (c) {
        diag += '<div class="diag-sym mono">' + esc(c.symbol) + '  ' + h4(c.oldHash) + ' → ' + h4(c.newHash) + '</div>' +
          (c.oldSignature ? '<div class="diag-sig old mono">− ' + esc(c.oldSignature) + '</div>' : '') +
          (c.newSignature ? '<div class="diag-sig new mono">+ ' + esc(c.newSignature) + '</div>' : '');
      });
      if (!(e.diagnosis.changed || []).length) {
        diag += '<div class="diag-sig new mono">' +
          (e.diagnosis.reason === 'trunk-overlap'
            ? 'changed paths overlap trunk — re-apply on a fresh trunk fork'
            : 're-fork against new producer head') + '</div>';
      }
      diag += '</div>';
    }

    var checks = '';
    if (e.checks) {
      var ok = e.checks.failed === 0;
      var total = (e.checks.passed || 0) + (e.checks.failed || 0);
      checks = '<span class="checks ' + (ok ? 'ok' : 'bad') + '">' +
        (ok ? '✓' : '✗') + (total ? ' ' + e.checks.passed + '/' + total : (ok ? ' passed' : ' ' + e.checks.failed + ' failed')) +
        ' · ' + e.checks.durationMs + 'ms</span>';
      if (!ok && Array.isArray(e.checks.results)) {
        var fail = e.checks.results.filter(function (r) { return !r.ok; })[0];
        if (fail) checks += '<span class="checks-detail mono">' + esc(fail.name) + (fail.error ? ' — ' + esc(fail.error) : '') + '</span>';
      }
    }

    return '<div class="' + cls + '" data-row-id="' + esc(e.id) + '" id="row-' + esc(e.id) + '">' +
      '<div class="row-head">' +
      '<span class="eid mono">' + esc(e.id) + '</span>' +
      '<span class="agent">' + esc(e.agent) + '</span>' +
      '<span class="badge">' + esc(e.status.toUpperCase()) + '</span>' +
      '<span class="gen mono">gen ' + e.generation + '</span>' +
      '<span class="repo mono">' + esc(e.repo) + '</span>' +
      (e.headCommit ? '<span class="commit mono" title="' + esc(e.headCommit) + '">@' + c7(e.headCommit) + '</span>' : '') +
      (e.cutoffs ? '<span class="cutoff" title="early cutoff: producer push left the consumed interface unchanged">⚡cutoff ×' + e.cutoffs + '</span>' : '') +
      checks +
      (isHead ? '<span class="headtag">HEAD</span><button class="btn veto" data-veto="' + esc(e.id) + '" title="squash transitive dependents">VETO</button>' : '') +
      '</div>' +
      track +
      '<div class="tags">' + fwd + (fwd && exp ? '<span class="tag-sep"></span>' : '') +
      (exp ? '<span class="tag-label">exports</span>' + exp : '') + '</div>' +
      diag +
      '</div>';
  }

  function renderTrunk() {
    el.trunkRepo.textContent = state.trunk.repo;
    el.trunkCommit.textContent = state.trunk.commit ? '@ ' + c7(state.trunk.commit) : '';
    el.trunkCount.textContent = state.trunk.retiredCount ? '· ' + state.trunk.retiredCount + ' retired' : '';
    var html = '';
    retiredEntries().forEach(function (e) {
      html += '<span class="chip retired mono" data-row-id="' + esc(e.id) + '" data-chip="' + esc(e.id) + '" title="' + esc(e.repo) + '">' +
        esc(e.id) + ' @' + c7(e.headCommit || state.trunk.commit) +
        (e._retireMode ? ' <b class="retire-mode ' + (e._retireMode === 'splice' ? 'splice' : 'ff') + '">' + esc(e._retireMode) + '</b>' : '') +
        '</span>';
    });
    el.trunkChips.innerHTML = html || '<span class="dim">nothing retired yet</span>';
  }

  function animateRetirements() {
    var chips = el.trunkChips.querySelectorAll('[data-chip]');
    chips.forEach(function (chip) {
      var id = chip.getAttribute('data-chip');
      var e = A.findEntry(state, id);
      var from = prevRects[id];
      if (!e || !from || !recent(e._retireAt, 1500)) return;
      var to = chip.getBoundingClientRect();
      var dx = from.left - to.left;
      var dy = from.top - to.top;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      chip.style.transition = 'none';
      chip.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.6)';
      chip.style.opacity = '0.9';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          chip.style.transition = 'transform .7s cubic-bezier(.2,.8,.25,1), opacity .7s';
          chip.style.transform = '';
          chip.style.opacity = '';
        });
      });
    });
  }

  var lastLogLen = -1;
  function renderLog() {
    if (state.log.length === lastLogLen) return;
    lastLogLen = state.log.length;
    var html = '';
    for (var i = state.log.length - 1; i >= 0; i--) {
      var l = state.log[i];
      html += '<div class="log-line t-' + esc(l.type) + (i === state.log.length - 1 ? ' fresh' : '') + '">' +
        '<span class="log-ts mono">' + fmtTime(l.ts) + '</span> ' + esc(l.text) + '</div>';
    }
    el.log.innerHTML = html;
  }

  /* ---------- forwarding arrows ---------- */

  var linksScheduled = false;
  function scheduleLinks() {
    if (linksScheduled) return;
    linksScheduled = true;
    requestAnimationFrame(function () { linksScheduled = false; drawLinks(); });
  }

  /* Orthogonal forwarding connectors: out of the producer row's left rail,
   * into the gutter channel between the lane labels and the cards, down/up
   * vertically, then right into the consumer row's rail. Coordinates are in
   * pipeline CONTENT space (scroll-corrected) so arrows stay glued to rows. */
  function drawLinks() {
    var box = el.pipeline.getBoundingClientRect();
    var w = Math.max(el.pipeline.scrollWidth, box.width);
    var h = Math.max(el.pipeline.scrollHeight, box.height);
    el.links.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    el.links.style.width = w + 'px';
    el.links.style.height = h + 'px';
    var html = '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs>';

    function pt(dom) {
      var r = dom.getBoundingClientRect();
      return {
        x: r.left - box.left + el.pipeline.scrollLeft,
        y: r.top - box.top + el.pipeline.scrollTop,
        w: r.width, h: r.height
      };
    }
    // Rounded orthogonal elbow: M ax ay -> left to channel x -> vertical -> right to bx.
    function elbow(ax, ay, cx, bx, by, cls, arrow) {
      var r = Math.min(7, Math.abs(by - ay) / 2, Math.abs(ax - cx) - 1);
      if (r < 1) r = 1;
      var dir = by >= ay ? 1 : -1;
      var d = 'M ' + ax + ' ' + ay +
        ' L ' + (cx + r) + ' ' + ay +
        ' Q ' + cx + ' ' + ay + ' ' + cx + ' ' + (ay + dir * r) +
        ' L ' + cx + ' ' + (by - dir * r) +
        ' Q ' + cx + ' ' + by + ' ' + (cx + r) + ' ' + by +
        ' L ' + bx + ' ' + by;
      return '<path class="' + cls + '" d="' + d + '"' + (arrow ? ' marker-end="url(#arr)"' : '') + '/>';
    }

    var chanIdx = {};
    var chanN = 0;
    function channel(key) {
      if (!(key in chanIdx)) chanIdx[key] = chanN++;
      return chanIdx[key] % 3;
    }

    var trunk = document.getElementById('trunk');
    var trunkTop = trunk ? pt(trunk).y : h;

    liveEntries().forEach(function (e) {
      var row = document.getElementById('row-' + e.id);
      if (!row) return;
      var to = pt(row);
      var toX = to.x, toY = to.y + to.h / 2;
      var from = null, key = null;
      if (e.producerId) {
        var prow = document.getElementById('row-' + e.producerId);
        if (prow) {
          var pr = pt(prow);
          from = { x: pr.x, y: pr.y + pr.h / 2 };
          key = e.producerId;
        }
      }
      if (!from) {
        // No live producer row: link rises out of the trunk bar.
        var cx0 = toX - 8 - channel(e.producerId || ('trunk:' + e.id)) * 7;
        html += '<path class="link trunk-link" d="M ' + cx0 + ' ' + trunkTop +
          ' L ' + cx0 + ' ' + (toY + 8) +
          ' Q ' + cx0 + ' ' + toY + ' ' + (cx0 + 8) + ' ' + toY +
          ' L ' + toX + ' ' + toY + '" marker-end="url(#arr)"/>';
        return;
      }
      var cx = toX - 8 - channel(key) * 7;
      html += elbow(from.x, from.y, cx, toX, toY, 'link fwd-link', true);
    });
    el.links.innerHTML = html;
  }

  /* ---------- controls ---------- */

  function setRobSize(v) {
    if (MOCK) {
      A.applyEvent(state, { type: 'config', ts: Date.now(), data: { robSize: v } });
      render();
      return;
    }
    fetch('/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ robSize: v })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || r.status); });
    }).catch(function (err) { setConn(connMode, 'config: ' + err.message); });
  }

  function vetoEntry(id) {
    if (MOCK) {
      var res = A.localVeto(state, id);
      if (!res.ok) return;
      render();
      return;
    }
    fetch('/api/entries/' + encodeURIComponent(id) + '/veto', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || r.status); });
      }).catch(function (err) { setConn(connMode, 'veto: ' + err.message); });
  }

  /* ---------- connection indicator ---------- */

  function setConn(mode, note) {
    connMode = mode;
    el.connDot.className = 'dot ' + mode;
    el.connText.textContent = {
      init: 'connecting', ws: 'LIVE · ws', poll: 'polling /api/state',
      offline: 'offline', mock: 'mock replay · no server'
    }[mode] + (note ? ' · ' + note : '');
  }

  /* ---------- networking ---------- */

  var ws = null;
  var pollTimer = null;
  var backoff = 1000;

  function apply(ev) {
    A.applyEvent(state, ev);
    render();
    // The control plane does not broadcast fork completion: an entry's repo,
    // remote, exports and recorded consumes only appear in /api/state once the
    // fork effect lands. Pull one snapshot shortly after creation/refork.
    if (!MOCK && (ev.type === 'entry.created' || ev.type === 'refork')) scheduleStateRefresh();
  }

  var refreshT1 = null, refreshT2 = null;
  function scheduleStateRefresh() {
    if (refreshT1) clearTimeout(refreshT1);
    if (refreshT2) clearTimeout(refreshT2);
    refreshT1 = setTimeout(function () { refreshT1 = null; fetchState(); }, 900);
    refreshT2 = setTimeout(function () { refreshT2 = null; fetchState(); }, 2600);
  }

  function startPolling() {
    if (pollTimer) return;
    setConn('poll');
    pollTimer = setInterval(fetchState, 1000);
    fetchState();
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function fetchState() {
    fetch('/api/state')
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (s) { apply({ type: 'snapshot', ts: Date.now(), data: s }); })
      .catch(function () { if (!ws || ws.readyState !== WebSocket.OPEN) setConn('offline'); });
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try { ws = new WebSocket(proto + '://' + location.host + '/api/ws'); }
    catch (e) { startPolling(); scheduleReconnect(); return; }
    ws.onopen = function () {
      backoff = 1000;
      stopPolling();
      setConn('ws');
    };
    ws.onmessage = function (m) {
      var ev;
      try { ev = JSON.parse(m.data); } catch (e) { return; }
      apply(ev);
    };
    ws.onclose = function () { startPolling(); scheduleReconnect(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function scheduleReconnect() {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  }

  /* ---------- mock ---------- */

  function startMock() {
    state = A.createState();
    lastLogLen = -1;
    setConn('mock');
    if (window.ArbMock) window.ArbMock.run(apply);
    else {
      var s = document.createElement('script');
      s.src = 'mock.js';
      s.onload = function () { window.ArbMock.run(apply); };
      document.body.appendChild(s);
    }
  }

  /* ---------- boot ---------- */

  build();
  setConn(MOCK ? 'mock' : 'init');
  render();
  if (MOCK) startMock();
  else { fetchState(); connect(); }
})();
