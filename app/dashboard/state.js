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
      stats: { squashes: 0, earlyCutoffs: 0, retired: 0, checksRun: 0, pushesSeen: 0 },
      log: []
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
      generation: typeof e.generation === 'number' ? e.generation : 0,
      diagnosis: e.diagnosis || null,
      checks: e.checks || null,
      // local-only presentation fields, never sent by the server
      cutoffs: typeof e.cutoffs === 'number' ? e.cutoffs : 0,
      _squashAt: e._squashAt || 0,
      _retireAt: e._retireAt || 0,
      _cutoffAt: e._cutoffAt || 0,
      _hashAt: e._hashAt || 0
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
        _retireAt: existing._retireAt, _cutoffAt: existing._cutoffAt, _hashAt: existing._hashAt
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

  function shortCommit(c) { return c ? String(c).slice(0, 7) : '—'; }
  function shortHash(h) { return h ? String(h).slice(0, 4) : '????'; }

  function pushLog(state, ev, text) {
    state.log.push({ ts: ev.ts || Date.now(), type: ev.type, entryId: ev.entryId || null, text: text });
    if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
  }

  /* Fold one ArbEvent into state. Defensive: `data` is loosely typed by the
   * contract, so a full `data.entry` is folded whenever present and each
   * event type additionally accepts flat fields. */
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
        if (entry) {
          entry.status = entry.status || 'speculating';
          sortEntries(state);
        }
        pushLog(state, ev, entry
          ? entry.id + ' created · lane ' + entry.lane + (entry.producerId ? ' · forks ' + entry.producerId : ' · forks trunk')
          : 'entry created');
        break;
      }
      case 'push': {
        if (entry) {
          entry.headCommit = data.commit || data.headCommit || entry.headCommit;
          if (entry.diagnosis) entry.diagnosis = null; // contract: cleared when the agent pushes again
          if (entry.status === 'squashed' || entry.status === 'failed') entry.status = 'speculating';
        }
        bump = 'pushesSeen';
        pushLog(state, ev, 'push ' + (entry ? entry.id : ev.entryId || '?') + ' @ ' + shortCommit(entry && entry.headCommit));
        break;
      }
      case 'hash.unchanged': {
        if (entry) { entry.cutoffs += 1; entry._cutoffAt = now; }
        bump = 'earlyCutoffs';
        pushLog(state, ev, 'early cutoff ' + (entry ? entry.id : '?') + (data.symbol ? ' · ' + data.symbol + ' unchanged' : ' · interface unchanged'));
        break;
      }
      case 'hash.changed': {
        var changes = Array.isArray(data.changed) ? data.changed : (data.symbol ? [data] : []);
        if (entry) {
          changes.forEach(function (c) {
            if (c && c.symbol && c.newHash) entry.exports[c.symbol] = c.newHash;
          });
          entry._hashAt = now;
        }
        bump = null;
        var ch0 = changes[0];
        pushLog(state, ev, 'hash.changed ' + (entry ? entry.id : '?') + (ch0 ? ' · ' + ch0.symbol + ' ' + shortHash(ch0.oldHash) + '→' + shortHash(ch0.newHash) : ''));
        break;
      }
      case 'squash': {
        if (entry) {
          entry.status = 'squashed';
          entry._squashAt = now;
          if (data.diagnosis) entry.diagnosis = data.diagnosis;
          if (typeof data.generation === 'number') entry.generation = data.generation;
          else if (!isEntry(data.entry)) entry.generation += 1;
        }
        bump = 'squashes';
        pushLog(state, ev, 'SQUASH ' + (entry ? entry.id : '?') + (entry && entry.diagnosis && entry.diagnosis.changed[0]
          ? ' · ' + entry.diagnosis.changed[0].symbol + ' ' + shortHash(entry.diagnosis.changed[0].oldHash) + '→' + shortHash(entry.diagnosis.changed[0].newHash)
          : ''));
        break;
      }
      case 'refork': {
        if (entry) {
          entry.status = 'speculating';
          if (data.repo) entry.repo = data.repo;
          if (data.remote) entry.remote = data.remote;
          if (typeof data.generation === 'number') entry.generation = data.generation;
          if (data.baseCommit) entry.baseCommit = data.baseCommit;
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
        var result = isCheckResult(data.checks) ? data.checks : (isCheckResult(data) ? data : null);
        if (entry) {
          if (result) entry.checks = result;
          if (entry.status !== 'retired') {
            entry.status = isEntry(data.entry) ? entry.status : (ev.type === 'check.failed' ? 'failed' : 'ready');
          }
        }
        bump = 'checksRun';
        var ok = ev.type === 'check.passed';
        pushLog(state, ev, 'check ' + (ok ? 'PASSED' : 'FAILED') + ' ' + (entry ? entry.id : '?') +
          (result ? ' · ' + result.passed + '/' + (result.passed + result.failed) + ' · ' + result.durationMs + 'ms' : ''));
        break;
      }
      case 'retired': {
        if (entry) { entry.status = 'retired'; entry._retireAt = now; }
        var tCommit = (data.trunk && data.trunk.commit) || data.trunkCommit || data.commit || null;
        if (tCommit) state.trunk.commit = tCommit;
        if (data.trunk && typeof data.trunk.retiredCount === 'number') state.trunk.retiredCount = data.trunk.retiredCount;
        else state.trunk.retiredCount += 1;
        bump = 'retired';
        pushLog(state, ev, 'retired ' + (entry ? entry.id : '?') + ' → ' + state.trunk.repo + ' @ ' + shortCommit(state.trunk.commit));
        break;
      }
      case 'veto': {
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
        if (data.trunk) state.trunk.commit = data.trunk.commit || null;
        pushLog(state, ev, 'reset · buffer cleared');
        return;
      }
      default: {
        pushLog(state, ev, ev.type + (ev.entryId ? ' · ' + ev.entryId : ''));
      }
    }

    if (data.stats) state.stats = Object.assign(createState().stats, data.stats);
    else if (bump) state.stats[bump] += 1;
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

  return {
    STAGES: STAGES,
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
    shortHash: shortHash,
    shortCommit: shortCommit
  };
});
