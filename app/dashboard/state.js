/* ARB dashboard: pure state core. No DOM access — testable in Node.
 * Consumes ArbEvent messages (app/CONTRACTS.md "Events") and folds them
 * into a BufferState-shaped local model plus a capped event log.
 * Exposed as window.ArbState in the browser and module.exports in Node. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArbState = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STAGES = ['forked', 'speculating', 'ready', 'checking', 'retired'];
  var LOG_CAP = 200;

  function createState() {
    return {
      trunk: { repo: 'arb-trunk', commit: null, retiredCount: 0 },
      robSize: 8,
      entries: [],
      stats: { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0, predictionHits: 0, predictionMisses: 0 },
      log: [],
      // local-only timing tracking: latest squash -> refork latency
      _lastReforkAt: 0,
      _lastReforkDelta: null
    };
  }

  function isEntry(x) {
    return !!x && typeof x === 'object' && typeof x.id === 'string' &&
      typeof x.seq === 'number' && typeof x.lane === 'string';
  }

  function normalizeEntry(e) {
    return {
      id: e.id,
      seq: e.seq,
      agent: e.agent || '',
      lane: e.lane || 'default',
      status: e.status || 'speculating',
      repo: e.repo || '',
      remote: e.remote || '',
      producerId: e.producerId == null ? null : e.producerId,
      baseCommit: e.baseCommit || '',
      headCommit: e.headCommit || null,
      exports: e.exports || {},
      consumes: e.consumes || {},
      consumesInferred: e.consumesInferred === true,
      forkedExports: e.forkedExports || {},
      bodies: e.bodies || {},
      judging: Array.isArray(e.judging) ? e.judging : [],
      _inferredAt: e._inferredAt || {},
      _undeclared: e._undeclared || [],
      _judgments: e._judgments || {},
      predicted: Array.isArray(e.predicted) ? e.predicted : [],
      generation: typeof e.generation === 'number' ? e.generation : 0,
      diagnosis: e.diagnosis || null,
      checks: e.checks || null,
      // local-only presentation fields, never sent by the server
      cutoffs: typeof e.cutoffs === 'number' ? e.cutoffs : 0,
      _squashAt: e._squashAt || 0,
      _retireAt: e._retireAt || 0,
      _cutoffAt: e._cutoffAt || 0,
      _hashAt: e._hashAt || 0,
      _retireMode: e._retireMode || null,   // "fast-forward" | "splice" (retired events)
      _hcCommit: e._hcCommit || null,       // producer commit that triggered the last hash.changed
      _predTicks: e._predTicks || {}        // symbol -> 'hit' | 'miss' (last prediction verdict)
    };
  }

  function findEntry(state, id) {
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].id === id) return state.entries[i];
    }
    return null;
  }

  function upsertEntry(state, raw) {
    var e = normalizeEntry(raw);
    var existing = findEntry(state, e.id);
    if (existing) {
      var keep = {
        cutoffs: existing.cutoffs, _squashAt: existing._squashAt,
        _retireAt: existing._retireAt, _cutoffAt: existing._cutoffAt, _hashAt: existing._hashAt,
        _retireMode: existing._retireMode, _hcCommit: existing._hcCommit,
        _inferredAt: existing._inferredAt, _undeclared: existing._undeclared,
        _judgments: existing._judgments, _predTicks: existing._predTicks
      };
      Object.assign(existing, e);
      Object.assign(existing, keep);
      return existing;
    }
    state.entries.push(e);
    return e;
  }

  function sortEntries(state) {
    state.entries.sort(function (a, b) { return a.seq - b.seq; });
  }

  function loadSnapshot(state, s) {
    if (!s || typeof s !== 'object') return 0;
    if (s.trunk) {
      state.trunk.repo = s.trunk.repo || state.trunk.repo;
      state.trunk.commit = s.trunk.commit != null ? s.trunk.commit : state.trunk.commit;
      if (typeof s.trunk.retiredCount === 'number') state.trunk.retiredCount = s.trunk.retiredCount;
    }
    if (typeof s.robSize === 'number') state.robSize = s.robSize;
    if (Array.isArray(s.entries)) {
      var seen = {};
      s.entries.forEach(function (raw) {
        var e = upsertEntry(state, raw);
        seen[e.id] = true;
      });
      state.entries = state.entries.filter(function (e) { return seen[e.id]; });
      sortEntries(state);
    }
    if (s.stats) state.stats = Object.assign(createState().stats, s.stats);
    return state.entries.length;
  }

  function probabilityText(p) { return typeof p === 'number' && isFinite(p) ? p.toFixed(2) : '—'; }
  function behaviorDiagnosis(d, symbol) {
    return [symbol, 'signature unchanged · behavior changed', 'Jev p=' + probabilityText(d.judgment && d.judgment.probability)];
  }

  function shortCommit(c) { return c ? String(c).slice(0, 7) : '—'; }
  function shortHash(h) { return h ? String(h).slice(0, 4) : '????'; }

  function pushLog(state, ev, text) {
    state.log.push({ ts: ev.ts || Date.now(), type: ev.type, entryId: ev.entryId || null, text: text });
    if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
  }

  /* Fold one ArbEvent into state. Defensive: the deployed control plane emits
   * flat per-type payloads (no data.entry — see app/control-plane/src/rob.ts),
   * so each case accepts both the flat fields and a full `data.entry`. */
  function applyEvent(state, ev) {
    if (!ev || typeof ev.type !== 'string') return;
    var data = (ev.data && typeof ev.data === 'object') ? ev.data : {};
    var now = ev.ts || Date.now();
    var bump = null;
    var entry = null;

    if (isEntry(data.entry)) entry = upsertEntry(state, data.entry);
    else if (ev.type !== 'snapshot' && isEntry(data)) entry = upsertEntry(state, data);
    if (!entry && ev.entryId) entry = findEntry(state, ev.entryId);

    switch (ev.type) {
      case 'snapshot': {
        var n = loadSnapshot(state, data);
        pushLog(state, ev, 'snapshot · ' + n + ' entr' + (n === 1 ? 'y' : 'ies') + ' · robSize ' + state.robSize);
        return;
      }
      case 'entry.created': {
        // Real payload: { agent, lane, seq, producerId, repo } — no data.entry.
        if (!entry && ev.entryId && (typeof data.seq === 'number' || data.agent || data.lane)) {
          entry = upsertEntry(state, {
            id: ev.entryId,
            seq: typeof data.seq === 'number' ? data.seq : state.entries.length + 1,
            agent: data.agent, lane: data.lane,
            producerId: data.producerId == null ? null : data.producerId,
            repo: data.repo || '',
            exports: data.exports || {},
            consumes: data.consumes || {},
            consumesInferred: data.consumesInferred,
            forkedExports: data.forkedExports,
            bodies: data.bodies,
            judging: data.judging,
            predicted: data.predicted || [],
            status: data.status || 'speculating'
          });
        }
        if (entry) sortEntries(state);
        pushLog(state, ev, entry
          ? entry.id + ' created · lane ' + entry.lane + (entry.producerId ? ' · forks ' + entry.producerId : ' · forks trunk')
          : 'entry created');
        break;
      }
      case 'push': {
        if (data.trunk === true || (ev.entryId == null && data.repo && data.repo === state.trunk.repo)) {
          // Push onto the trunk repo itself (real payload: {repo, commit, trunk:true}).
          if (data.commit) state.trunk.commit = data.commit;
          pushLog(state, ev, 'trunk push @ ' + shortCommit(state.trunk.commit));
          break;
        }
        if (entry) {
          entry.headCommit = data.commit || data.headCommit || entry.headCommit;
          // A push on this entry resolves any declared-stub predictions.
          if (entry.predicted && entry.predicted.length) entry.predicted = [];
          if (entry.diagnosis) entry.diagnosis = null; // contract: cleared when the agent pushes again
          if (entry.status === 'squashed' || entry.status === 'failed' ||
              entry.status === 'ready' || entry.status === 'checking') {
            entry.status = 'speculating';
          }
        }
        bump = 'pushesSeen';
        pushLog(state, ev, 'push ' + (entry ? entry.id : ev.entryId || '?') + ' @ ' + shortCommit(entry && entry.headCommit));
        break;
      }
      case 'hash.unchanged': {
        // Real payload: entryId is the CONSUMER, data = { producerId, commit }.
        if (entry) { entry.cutoffs += 1; entry._cutoffAt = now; }
        bump = 'earlyCutoffs';
        pushLog(state, ev, 'early cutoff ' + (entry ? entry.id : '?') +
          (data.symbol ? ' · ' + data.symbol + ' unchanged' : ' · consumed interface unchanged'));
        break;
      }
      case 'hash.changed': {
        // Real payload: entryId is the consumer, data = { producerId, commit, changed[] }.
        var changes = Array.isArray(data.changed) ? data.changed : (data.symbol ? [data] : []);
        var producer = data.producerId ? findEntry(state, data.producerId) : null;
        var hashOwner = producer || entry;
        if (hashOwner) {
          changes.forEach(function (c) {
            if (c && c.symbol && c.newHash) hashOwner.exports[c.symbol] = c.newHash;
          });
          hashOwner._hashAt = now;
        }
        if (entry) {
          entry._hashAt = now;
          if (data.commit) entry._hcCommit = data.commit; // producer commit for the coming squash diagnosis
        }
        bump = null;
        var ch0 = changes[0];
        pushLog(state, ev, 'hash.changed ' + (hashOwner ? hashOwner.id : '?') + (ch0 ? ' · ' + ch0.symbol + ' ' + shortHash(ch0.oldHash) + '→' + shortHash(ch0.newHash) : '') +
          (entry && producer && entry !== producer ? ' · consumed by ' + entry.id : ''));
        break;
      }
      case 'deps.inferred': {
        var inferred = data.symbols || {};
        if (entry) {
          entry.consumesInferred = true;
          Object.keys(inferred).forEach(function (symbol) {
            entry.consumes[symbol] = inferred[symbol];
            entry._inferredAt[symbol] = now;
          });
        }
        state.stats.inferredDeps = (state.stats.inferredDeps || 0) + Object.keys(inferred).length;
        pushLog(state, ev, 'dependencies inferred ' + (ev.entryId || '?') + ' · ' + Object.keys(inferred).join(', '));
        break;
      }
      case 'deps.undeclared': {
        if (entry) {
          var warning = { fromEntryId: data.fromEntryId, paths: data.paths || [], symbols: data.symbols || [] };
          entry._undeclared = entry._undeclared.filter(function (w) { return w.fromEntryId !== warning.fromEntryId; });
          entry._undeclared.push(warning);
        }
        pushLog(state, ev, 'undeclared dependency ' + (ev.entryId || '?') + ' ← ' + (data.fromEntryId || '?') + ' · ' + (data.symbols || []).join(', '));
        break;
      }
      case 'jev.judged':
      case 'jev.unavailable': {
        var unavailable = ev.type === 'jev.unavailable';
        if (entry && data.symbol) {
          entry.judging = entry.judging.filter(function (symbol) { return symbol !== data.symbol; });
          entry._judgments[data.symbol] = Object.assign({}, data, { verdict: unavailable ? 'unavailable' : data.verdict });
        }
        if (!unavailable) bump = 'judgments';
        pushLog(state, ev, unavailable ? 'semantic check unavailable · ' + (data.symbol || '?') :
          'Jev ' + data.verdict + ' · ' + (ev.entryId || '?') + ' · ' + data.symbol + ' p=' + probabilityText(data.probability));
        break;
      }
      case 'prediction.hit':
      case 'prediction.miss': {
        // entryId is the CONSUMER; data carries the producer + verdict fields.
        var hit = ev.type === 'prediction.hit';
        if (entry && data.symbol) {
          if (!entry._predTicks) entry._predTicks = {};
          entry._predTicks[data.symbol] = hit ? 'hit' : 'miss';
          // On a hit the forwarded hash was confirmed; on a miss the consumer
          // is about to be squashed and reforked onto the actual hash.
          if (hit && data.hash) entry.consumes[data.symbol] = data.hash;
        }
        bump = hit ? 'predictionHits' : 'predictionMisses';
        pushLog(state, ev, (hit ? 'PREDICTION HIT ' : 'PREDICTION MISS ') + (entry ? entry.id : '?') +
          (data.symbol ? ' · ' + data.symbol + ' ' +
            (hit ? shortHash(data.hash) : shortHash(data.predictedHash) + '→' + shortHash(data.actualHash)) : '') +
          (data.producerId ? ' (declared by ' + data.producerId + ')' : ''));
        break;
      }
      case 'squash': {
        if (entry) {
          entry.status = 'squashed';
          entry._squashAt = now;
          // Real payload: { reason, changed, generation, repo } — build the
          // diagnosis from flat fields when data.diagnosis is absent.
          if (data.diagnosis) entry.diagnosis = data.diagnosis;
          else if (data.reason || Array.isArray(data.changed)) {
            entry.diagnosis = {
              reason: data.reason || 'interface-changed',
              changed: Array.isArray(data.changed) ? data.changed : [],
              producerCommit: data.producerCommit || entry._hcCommit || '',
              judgment: data.judgment
            };
          }
          if (data.repo) entry.repo = data.repo;
          if (typeof data.generation === 'number') entry.generation = data.generation;
          else if (!isEntry(data.entry)) entry.generation += 1;
        }
        if (entry && entry.diagnosis && entry.diagnosis.reason === 'behavior-changed') {
          state.stats.semanticSquashes = (state.stats.semanticSquashes || 0) + 1;
        }
        if (entry) entry.judging = [];
        bump = 'squashes';
        pushLog(state, ev, 'SQUASH ' + (entry ? entry.id : '?') + (entry && entry.diagnosis && entry.diagnosis.changed[0]
          ? ' · ' + entry.diagnosis.changed[0].symbol + ' ' + shortHash(entry.diagnosis.changed[0].oldHash) + '→' + shortHash(entry.diagnosis.changed[0].newHash)
          : (entry && entry.diagnosis && entry.diagnosis.reason === 'trunk-overlap' ? ' · trunk overlap' : '')));
        break;
      }
      case 'refork': {
        if (entry) {
          entry.status = 'speculating';
          // Honest latency metric: squash event -> refork event, both stamped
          // server-side (replaces the synthetic push->squash delta, which was
          // ~0ms live because push and squash share a timestamp).
          if (entry._squashAt) {
            state._lastReforkAt = now;
            state._lastReforkDelta = Math.max(0, now - entry._squashAt);
          }
          if (data.repo) entry.repo = data.repo;
          if (data.remote) entry.remote = data.remote;
          if (typeof data.generation === 'number') entry.generation = data.generation;
          if (data.baseCommit) entry.baseCommit = data.baseCommit;
          // Server-side fork.done records the new producer hashes in consumes.
          if (entry.diagnosis && entry.diagnosis.reason !== 'behavior-changed' && Array.isArray(entry.diagnosis.changed)) {
            entry.diagnosis.changed.forEach(function (c) {
              if (c && c.symbol && c.newHash) entry.consumes[c.symbol] = c.newHash;
            });
          }
          // New generation forwards against actual hashes: verdict ticks reset.
          entry._predTicks = {};
          entry._judgments = {};
          entry._undeclared = [];
          entry.judging = [];
        }
        pushLog(state, ev, 'refork ' + (entry ? entry.id : '?') + (entry ? ' → ' + entry.repo + ' · gen ' + entry.generation : ''));
        break;
      }
      case 'ready': {
        if (entry) {
          entry.status = 'ready';
          entry.headCommit = data.commit || entry.headCommit;
        }
        pushLog(state, ev, (entry ? entry.id : '?') + ' ready @ ' + shortCommit(entry && entry.headCommit));
        break;
      }
      case 'check.started': {
        if (entry) entry.status = 'checking';
        pushLog(state, ev, 'check started ' + (entry ? entry.id : '?'));
        break;
      }
      case 'check.passed':
      case 'check.failed': {
        if (ev.type === 'check.failed' && data.infra) {
          // T19: the checker could not run (platform outage) — not a verdict.
          // The control plane keeps the entry checking and retries.
          bump = 'checksRun';
          pushLog(state, ev, 'check INFRA error ' + (entry ? entry.id : '?') +
            (data.splice ? ' (splice candidate)' : '') + (data.error ? ' · ' + data.error : '') + ' · will retry');
          break;
        }
        // Real payload: { commit, durationMs, failed? } — no full CheckResult.
        var ok = ev.type === 'check.passed';
        var result = isCheckResult(data.checks) ? data.checks : (isCheckResult(data) ? data : null);
        if (!result && (data.commit || data.durationMs != null || data.failed != null)) {
          result = {
            commit: data.commit || (entry && entry.headCommit) || '',
            passed: typeof data.passed === 'number' ? data.passed : 0,
            failed: typeof data.failed === 'number' ? data.failed : (ok ? 0 : 1),
            durationMs: typeof data.durationMs === 'number' ? data.durationMs : 0,
            results: Array.isArray(data.results) ? data.results : []
          };
        }
        if (entry) {
          if (result) entry.checks = result;
          if (entry.status !== 'retired') {
            entry.status = isEntry(data.entry) ? entry.status : (ok ? 'ready' : 'failed');
          }
        }
        bump = 'checksRun';
        var total = result ? result.passed + result.failed : 0;
        pushLog(state, ev, 'check ' + (ok ? 'PASSED' : 'FAILED') + ' ' + (entry ? entry.id : '?') +
          (result ? (total ? ' · ' + result.passed + '/' + total : '') + ' · ' + result.durationMs + 'ms' : ''));
        break;
      }
      case 'retired': {
        // Real payload: { commit, seq, mode? } — mode is "fast-forward" | "splice".
        if (entry) {
          entry.status = 'retired';
          entry._retireAt = now;
          if (data.mode) entry._retireMode = data.mode;
          if (data.commit) entry.headCommit = entry.headCommit || data.commit;
        }
        var tCommit = (data.trunk && data.trunk.commit) || data.trunkCommit || data.commit || null;
        if (tCommit) state.trunk.commit = tCommit;
        if (data.trunk && typeof data.trunk.retiredCount === 'number') state.trunk.retiredCount = data.trunk.retiredCount;
        else state.trunk.retiredCount += 1;
        bump = 'retired';
        pushLog(state, ev, 'retired ' + (entry ? entry.id : '?') + ' → ' + state.trunk.repo + ' @ ' + shortCommit(state.trunk.commit) +
          (data.mode ? ' · ' + data.mode : ''));
        break;
      }
      case 'veto': {
        // Real payload: { seq }; dependent squashes arrive as separate squash
        // events with reason "producer-vetoed". data.squashed[] is a mock fallback.
        if (entry) entry.status = 'vetoed';
        var squashed = Array.isArray(data.squashed) ? data.squashed : [];
        squashed.forEach(function (id) {
          var dep = findEntry(state, id);
          if (dep && dep.status !== 'squashed') {
            dep.status = 'squashed';
            dep._squashAt = now;
            if (!dep.diagnosis) {
              dep.diagnosis = { reason: 'producer-vetoed', changed: [], producerCommit: (entry && entry.headCommit) || '' };
            }
          }
        });
        pushLog(state, ev, 'VETO ' + (entry ? entry.id : '?') + (squashed.length ? ' · squashed ' + squashed.join(', ') : ''));
        break;
      }
      case 'config': {
        var rs = typeof data.robSize === 'number' ? data.robSize : (typeof ev.data === 'number' ? ev.data : null);
        if (rs != null) state.robSize = rs;
        pushLog(state, ev, 'robSize → ' + state.robSize);
        break;
      }
      case 'reset': {
        state.entries = [];
        state.stats = createState().stats;
        state.trunk.retiredCount = 0;
        state._lastReforkAt = 0;
        state._lastReforkDelta = null;
        if (data.trunk) state.trunk.commit = data.trunk.commit || null;
        pushLog(state, ev, 'reset · buffer cleared');
        return;
      }
      case 'recover': {
        // T19 recovery narration: { kind, repo?, reason?, attempt? }.
        pushLog(state, ev, 'RECOVER ' + (data.kind || '?') + (ev.entryId ? ' ' + ev.entryId : '') +
          (data.repo ? ' → ' + data.repo : '') + (data.reason ? ' · ' + data.reason : ''));
        break;
      }
      default: {
        pushLog(state, ev, ev.type + (ev.entryId ? ' · ' + ev.entryId : ''));
      }
    }

    if (data.stats) state.stats = Object.assign(createState().stats, data.stats);
    else if (bump) state.stats[bump] = (state.stats[bump] || 0) + 1;
    if (entry) sortEntries(state);
  }

  function isCheckResult(x) {
    return !!x && typeof x === 'object' && typeof x.passed === 'number' && typeof x.failed === 'number';
  }

  /* Head of the reorder buffer: lowest-seq entry still in flight. */
  function headEntry(state) {
    var head = null;
    state.entries.forEach(function (e) {
      if (e.status === 'retired' || e.status === 'vetoed') return;
      if (!head || e.seq < head.seq) head = e;
    });
    return head;
  }

  /* Transitive dependents of id (entries that forked from it, directly or not). */
  function dependentsOf(state, id) {
    var out = [];
    var changed = true;
    var seen = {};
    seen[id] = true;
    while (changed) {
      changed = false;
      state.entries.forEach(function (e) {
        if (!seen[e.id] && e.producerId && seen[e.producerId]) {
          seen[e.id] = true;
          out.push(e);
          changed = true;
        }
      });
    }
    out.sort(function (a, b) { return a.seq - b.seq; });
    return out;
  }

  /* Mock-mode-only veto simulation: veto the head, squash its transitive
   * dependents the way the control plane would report it. */
  function localVeto(state, id) {
    var e = findEntry(state, id);
    if (!e || headEntry(state) !== e) return { ok: false, error: 'not the head entry' };
    var now = Date.now();
    e.status = 'vetoed';
    var deps = dependentsOf(state, id).filter(function (d) { return d.status !== 'retired'; });
    deps.forEach(function (d) {
      d.status = 'squashed';
      d._squashAt = now;
      d.diagnosis = { reason: 'producer-vetoed', changed: [], producerCommit: e.headCommit || '' };
      state.stats.squashes += 1;
    });
    state.log.push({ ts: now, type: 'veto', entryId: id, text: 'VETO ' + id + ' · squashed ' + deps.map(function (d) { return d.id; }).join(', ') });
    return { ok: true, squashed: deps.map(function (d) { return d.id; }) };
  }

  /* Latency of the latest re-fork: squash event -> refork event for that
   * entry, in ms. Both events carry the control plane's own timestamp, so the
   * value is real (the old push->squash delta collapsed to ~0ms live because
   * the DO stamps both in one apply). Returns null until the first refork. */
  function reforkTiming(state) {
    if (!state._lastReforkAt) return null;
    return { at: state._lastReforkAt, deltaMs: state._lastReforkDelta };
  }

  /* Map an entry status onto the 5-stage pipeline track (index into STAGES,
   * or -1 for off-track statuses). */
  function stageIndex(e) {
    switch (e.status) {
      case 'squashed': return 0;
      case 'speculating': return 1;
      case 'ready': return 2;
      case 'checking': return 3;
      case 'retired': return 4;
      case 'failed': return 3;
      case 'vetoed': return -1;
      default: return 1;
    }
  }

  /* T19 admin key: protected controls (VETO, robSize) only render and send
   * when the page URL carries ?key=<admin key>. */
  function adminKeyFromSearch(search) {
    var m = /[?&]key=([^&#]*)/.exec(search || '');
    if (!m || !m[1]) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  function adminHeaders(key) {
    var h = { 'content-type': 'application/json' };
    if (key) h['x-arb-key'] = key;
    return h;
  }

  return {
    STAGES: STAGES,
    probabilityText: probabilityText,
    behaviorDiagnosis: behaviorDiagnosis,
    adminKeyFromSearch: adminKeyFromSearch,
    adminHeaders: adminHeaders,
    LOG_CAP: LOG_CAP,
    createState: createState,
    applyEvent: applyEvent,
    loadSnapshot: loadSnapshot,
    upsertEntry: upsertEntry,
    findEntry: findEntry,
    headEntry: headEntry,
    dependentsOf: dependentsOf,
    localVeto: localVeto,
    stageIndex: stageIndex,
    reforkTiming: reforkTiming,
    shortHash: shortHash,
    shortCommit: shortCommit
  };
});
