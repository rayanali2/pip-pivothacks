// ---------------------------------------------------------------------------
// BUILD_PLAN part 1: free window, plan items and the deterministic skeleton plan
// (CONTRACT section 4; api/src/ranker/plan.ts is the reference implementation).
// Pure functions over the state object S built in plan_proc.js.
//
// S = { student_id, capture_id, now_ms, now_str, day_ms, now_min, dow,
//       blocks: [{title, start, end, location}]  (minutes of day, sorted by start),
//       fw: free window (pipFreeWindow), eff: effective minutes,
//       rows: pre-rank rows sorted by score desc, rowsById,
//       chronotype, bed_min, money: {cash, until_ms, budget_until, days, daily, cap},
//       extra: {available_minutes, cash_available, question, previous_plan_id, trigger} }
// row = { task_id, raw_text, title, category, due_ms, due_at, money, est, defer_count,
//         hours_open, first_step, r1..r5, guard, fits, at_risk, curve_kind, score, rules_fired }
// ---------------------------------------------------------------------------
var PIP_RULE_WORDS = {
  irreversible_loss: 'an irreversible loss',
  fixed_block_collision: 'a clash with a fixed block',
  basic_needs: 'a basic need',
  fits_window: 'a first step that fits the window',
  academic_deadline: 'a near academic deadline'
};
var PIP_DAY_END_MIN = 23 * 60 + 59;

function pipStableSort(arr, cmp) {
  var tmp = [];
  for (var i = 0; i < arr.length; i++) { tmp.push({ v: arr[i], i: i }); }
  tmp.sort(function (a, b) { var c = cmp(a.v, b.v); return c !== 0 ? c : a.i - b.i; });
  var out = [];
  for (var j = 0; j < tmp.length; j++) { out.push(tmp[j].v); }
  return out;
}

// ws = window start (minutes of day, may be fractional when it is "now"); ws_ms = the same as naive ms.
function pipFreeWindow(nowMs, dayMs, blocks) {
  var nowMin = (nowMs - dayMs) / 60000;
  var ws = nowMin;
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i].start <= ws && blocks[i].end > ws) { ws = blocks[i].end; }
  }
  var next = null;
  for (var j = 0; j < blocks.length; j++) {
    if (blocks[j].start >= ws && blocks[j].start > nowMin) { next = blocks[j]; break; }
  }
  var endMin = next ? next.start : PIP_DAY_END_MIN;
  var minutes = Math.max(0, Math.floor(endMin - ws + 1e-9));
  var wsMs = (ws === nowMin) ? nowMs : dayMs + Math.round(ws * 60000);
  var label;
  if (next) {
    label = minutes + ' min free until ' + next.title + ', ' + pipClock(dayMs + next.start * 60000);
  } else if (minutes >= 60) {
    label = Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min free today';
  } else {
    label = minutes + ' min free today';
  }
  return {
    ws: ws, ws_ms: wsMs, end_min: endMin, minutes: minutes, next: next, label: label,
    json: {
      starts_at: pipFmtTs(wsMs),
      ends_at: pipFmtTs(dayMs + endMin * 60000),
      minutes: minutes,
      next_block_title: next ? next.title : null,
      next_block_starts_at: next ? pipFmtTs(dayMs + next.start * 60000) : null,
      label: label
    }
  };
}

function pipBedMin(chronotype) {
  if (chronotype === 'early_bird') { return 22 * 60 + 30; }
  if (chronotype === 'night_owl') { return 23 * 60 + 30; }
  return 23 * 60;
}
function pipMinTs(S, min) { return pipFmtTs(S.day_ms + min * 60000); }
function pipMinClock(S, min) { return pipClock(S.day_ms + min * 60000); }
function pipBy(desc) { return desc.indexOf('at ') === 0 ? 'by ' + desc.substring(3) : 'by ' + desc; }
function pipIsGrocery(r) { return /grocer/i.test(r.title + ' ' + r.raw_text); }
function pipIsDeepWork(r) { return pipIn(['assignment', 'work', 'class'], r.category); }
function pipRuleWords(r) {
  if (!r.rules_fired.length) { return 'none of the urgency rules'; }
  var w = [];
  for (var i = 0; i < r.rules_fired.length; i++) { w.push(PIP_RULE_WORDS[r.rules_fired[i]]); }
  return w.join(', ');
}

function pipBlockItem(S, b, why) {
  return {
    item_id: 'block:' + S.dow + ':' + pipFmtHmOfDay(b.start), kind: 'fixed_block', task_id: null, title: b.title,
    action: 'Be at ' + (b.location || b.title) + ' by ' + pipMinClock(S, b.start),
    category: null, why: why, starts_at: pipMinTs(S, b.start), ends_at: pipMinTs(S, b.end),
    est_minutes: b.end - b.start, due_at: null, money_at_risk: null, location: b.location || null, flag: null,
    rules_fired: [], evidence: [], curve: [], curve_kind: null
  };
}
function pipTaskItem(r) {
  return {
    item_id: r.task_id, kind: 'task', task_id: r.task_id, title: r.title, action: '', category: r.category, why: '',
    starts_at: null, ends_at: null, est_minutes: r.est, due_at: r.due_at, money_at_risk: r.money, location: null,
    flag: r.at_risk ? 'at_risk' : (r.guard ? 'balance_guard' : null),
    rules_fired: r.rules_fired.slice(0), evidence: [], curve: [], curve_kind: r.curve_kind
  };
}

// ----- sentence templates -----------------------------------------------------------
function pipBeforeNext(S) {
  return S.fw.next ? ' before ' + S.fw.next.title + ' at ' + pipMinClock(S, S.fw.next.start) : ' today';
}
function pipDoNowAction(S, r) {
  if (pipIsGrocery(r)) { return 'Buy groceries with a ' + pipMoney(S.money.cap) + ' cap (~' + r.first_step + ' min)'; }
  if (pipIsDeepWork(r) && r.est !== null && r.est > r.first_step) {
    return 'Open ' + r.title + ' and outline the first part for ' + r.first_step + ' min';
  }
  return 'Start now: ' + r.title + ' (~' + r.first_step + ' min)';
}
function pipDoNowWhy(S, r) {
  var before = pipBeforeNext(S);
  if (!r.fits) {
    return 'Nothing fits in the ' + S.eff + ' min you have' + before + ', so start this anyway even though its ' +
      r.first_step + '-min first step will not finish in this window.';
  }
  var fit = 'the ' + r.first_step + '-min first step fits the ' + S.eff + ' min you have' + before;
  if (r.due_ms !== null && r.money !== null && r.money > 0) {
    return pipMoney(r.money) + ' is lost if this is not done ' + pipBy(pipDueDesc(r.due_ms, S.now_ms)) + ', and ' + fit + '.';
  }
  if (r.due_ms !== null) { return 'It is due ' + pipDueDesc(r.due_ms, S.now_ms) + ', and ' + fit + '.'; }
  if (r.r3) { return 'It covers a basic need, and ' + fit + '.'; }
  return 'Nothing more urgent is open, and ' + fit + '.';
}
// "Return headphones for refund needs ~35 min, you have 25 before CHEM 110 Lab, due 5:00 PM during
//  CHEM 110 Lab — $79 at risk unless you find 10 more minutes."  (CONTRACT section 5 warning)
function pipAtRiskText(S, r) {
  var nb = S.fw.next;
  var have = Math.max(0, S.eff);
  var need = r.first_step - have;
  var when = '';
  if (nb && r.due_ms !== null) { when = (r.due_ms > S.day_ms + nb.start * 60000) ? ' during ' + nb.title : ' before ' + nb.title; }
  var loss = (r.money !== null && r.money > 0) ? pipMoney(r.money) + ' at risk' : 'the deadline is at risk';
  return r.title + ' needs ~' + r.first_step + ' min, you have ' + have + (nb ? ' before ' + nb.title : ' free now') +
    (r.due_ms !== null ? ', due ' + pipClock(r.due_ms) + when : '') + ' — ' + loss + ' unless you find ' + need + ' more minutes.';
}
function pipGroceryWhy(S) {
  var m = S.money;
  var rest = pipMoney(Math.max(0, m.cash - m.cap));
  if (m.until_ms !== null) {
    return 'You have ' + pipMoney(m.cash) + ' until ' + pipDayLabel(m.until_ms) + ' (about ' + pipMoney(m.daily) +
      '/day), so cap groceries at ' + pipMoney(m.cap) + ' and keep ' + rest + ' for the rest of the week.';
  }
  return 'You have ' + pipMoney(m.cash) + ', so cap groceries at ' + pipMoney(m.cap) + ' and keep ' + rest + ' for everything else.';
}
function pipCanWaitWhy(S, r) {
  var parts = [];
  if (r.due_ms === null) {
    parts.push('No deadline');
  } else {
    var h = (r.due_ms - S.now_ms) / 3600000;
    parts.push('Due ' + pipDueDesc(r.due_ms, S.now_ms) + (h > 48 ? ', more than 48 h away' : ''));
  }
  parts.push((r.money !== null && r.money > 0) ? pipMoney(r.money) + ' at stake but not today' : 'no money at risk');
  parts.push(r.defer_count > 0 ? 'deferred ' + pipPlural(r.defer_count, 'time') + ' so far' : 'not deferred yet');
  return parts.join(', ') + '.';
}
// atMin: minutes of day the item is planned at (bedtime or a slot), or null when it has no slot
function pipGuardSentence(S, r, atMin) {
  var tail;
  if (atMin === null) { tail = ', so it stays on today\'s plan.'; }
  else if (atMin === S.bed_min) { tail = ', so it stays on tonight\'s plan at ' + pipMinClock(S, atMin) + '.'; }
  else { tail = ', so it stays on today\'s plan at ' + pipMinClock(S, atMin) + '.'; }
  return r.title + ': open ' + Math.round(r.hours_open) + ' h and deferred ' + pipPlural(r.defer_count, 'time') + tail;
}

// ----- skeleton ------------------------------------------------------------------------
function pipBuildSkeleton(S) {
  var rows = S.rows;
  var nb = S.fw.next;
  var i;

  // do_now: best fitting non-rest (guard items always go to today); else best non-rest
  var cands = [];
  for (i = 0; i < rows.length; i++) {
    if (rows[i].category !== 'rest' && !rows[i].guard) { cands.push(rows[i]); }
  }
  var dn = null;
  for (i = 0; i < cands.length; i++) { if (cands[i].fits) { dn = cands[i]; break; } }
  if (!dn && cands.length) { dn = cands[0]; }

  var skel = { doNowRow: dn, do_now: null, next: null, today: [], can_wait: [], cont: null,
    warnings: [], balance_guard: [], sectionById: {}, itemsById: {} };

  if (dn) {
    var d = pipTaskItem(dn);
    d.action = pipDoNowAction(S, dn);
    d.why = pipDoNowWhy(S, dn);
    // do_now happens in the free window: it starts at the window start (now, or the end of
    // the block the student is in right now)
    d.starts_at = pipFmtTs(S.fw.ws_ms);
    d.ends_at = dn.fits ? pipFmtTs(S.fw.ws_ms + dn.first_step * 60000) : null;
    if (dn.at_risk) { skel.warnings.push({ task_id: dn.task_id, text: pipAtRiskText(S, dn) }); }
    skel.do_now = d;
    skel.itemsById[dn.task_id] = d;
    skel.sectionById[dn.task_id] = 'do_now';
  }

  // next
  if (nb) {
    var minsUntil = Math.max(0, Math.floor(nb.start - S.now_min));
    var nwhy;
    if (dn && dn.fits) {
      var spare = Math.max(0, S.eff - dn.first_step);
      nwhy = 'After the ' + dn.first_step + '-min ' + dn.title + ' you will have ' + spare + ' min to spare before ' +
        nb.title + ' starts at ' + pipMinClock(S, nb.start) + '.';
    } else {
      nwhy = nb.title + ' starts at ' + pipMinClock(S, nb.start) + ', ' + minsUntil + ' min from now.';
    }
    skel.next = pipBlockItem(S, nb, nwhy);
  } else {
    for (i = 0; i < cands.length; i++) {
      if (cands[i].fits && cands[i] !== dn) {
        var nx = pipTaskItem(cands[i]);
        nx.action = pipDoNowAction(S, cands[i]);
        nx.why = 'After ' + (dn ? dn.title : 'that') + ', this ' + cands[i].first_step + '-min step still fits the ' +
          S.fw.minutes + ' min left today.';
        skel.next = nx;
        break;
      }
    }
  }

  // buckets: at_risk first; rest tasks at bedtime; tasks with R1/R2/R3/R5 or the guard are
  // slotted (dated by due, then undated by score); everything else can wait.
  // Balance-guard meal items are slotted like other tasks (plan.ts group 1/2), only rest
  // tasks go to bedtime.
  var atRisk = [], dated = [], undated = [], bedtime = [], wait = [];
  for (i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r === dn) { continue; }
    if (r.at_risk) { atRisk.push(r); }
    else if (r.category === 'rest') { bedtime.push(r); }
    else if (r.r1 || r.r2 || r.r3 || r.r5 || r.guard) { if (r.due_ms !== null) { dated.push(r); } else { undated.push(r); } }
    else { wait.push(r); }
  }
  var datedEntries = [];
  var undatedEntries = [];
  for (i = 0; i < dated.length; i++) { datedEntries.push({ row: dated[i], cont: false }); }
  for (i = 0; i < undated.length; i++) { undatedEntries.push({ row: undated[i], cont: false }); }
  // do_now continuation session (assignment/work with more work than the first step)
  if (dn && pipIn(['assignment', 'work'], dn.category) && dn.est !== null && dn.est > dn.first_step) {
    if (dn.due_ms !== null) { datedEntries.push({ row: dn, cont: true }); } else { undatedEntries.unshift({ row: dn, cont: true }); }
  }
  datedEntries = pipStableSort(datedEntries, function (a, b) {
    if (a.row.due_ms !== b.row.due_ms) { return a.row.due_ms - b.row.due_ms; }
    return b.row.score - a.row.score;
  });
  var slotted = datedEntries.concat(undatedEntries);

  // slotting
  var later = [];
  for (i = 0; i < S.blocks.length; i++) { if (nb && S.blocks[i].start > nb.start) { later.push(S.blocks[i]); } }
  var cursor;
  if (nb) { cursor = nb.end + 15; }
  else { cursor = Math.ceil(S.fw.ws) + (dn && dn.fits ? dn.first_step : 0) + 15; }
  // first slot at or after the cursor that does not overlap a later fixed block (does not move the cursor)
  function findSlot(session) {
    var s = cursor;
    var moved = true;
    var loops = 0;
    while (moved && loops < 20) {
      moved = false; loops++;
      for (var k = 0; k < later.length; k++) {
        if (s < later[k].end && s + session > later[k].start) { s = later[k].end + 15; moved = true; }
      }
    }
    if (s + session > 24 * 60) { return null; }
    return { start: s, end: s + session };
  }

  for (i = 0; i < atRisk.length; i++) {
    var ar = atRisk[i];
    var ai = pipTaskItem(ar);
    var text = pipAtRiskText(S, ar);
    ai.action = 'Only if you find ' + (ar.first_step - Math.max(0, S.eff)) + ' more min: ' + ar.title + ' (~' + ar.first_step + ' min)';
    ai.why = text;
    skel.warnings.push({ task_id: ar.task_id, text: text });
    skel.today.push(ai);
  }
  for (i = 0; i < slotted.length; i++) {
    var en = slotted[i];
    var sr = en.row;
    var it = pipTaskItem(sr);
    var remaining = en.cont ? (sr.est - sr.first_step) : (sr.est !== null ? sr.est : sr.first_step);
    var session = Math.max(5, Math.min(remaining, 90));
    var slot = findSlot(session);
    var missedAt = null;
    // a dated task whose next open slot starts at or after its deadline gets no slot (plan.ts missedSlot)
    if (slot && !en.cont && sr.due_ms !== null && S.day_ms + slot.start * 60000 >= sr.due_ms) {
      missedAt = slot.start;
      slot = null;
    }
    if (slot) {
      cursor = slot.end + 15;
      it.starts_at = pipMinTs(S, slot.start);
      it.ends_at = pipMinTs(S, slot.end);
    }
    var at = slot ? pipMinClock(S, slot.start) : null;
    if (en.cont) {
      it.item_id = sr.task_id + '#cont';
      it.title = sr.title + ' (continued)';
      it.est_minutes = remaining;
      it.flag = null;
      it.action = 'Keep going on ' + sr.title + ' for ' + session + ' min';
      it.why = (sr.due_ms !== null ? 'It is due ' + pipDueDesc(sr.due_ms, S.now_ms) + ', so after' : 'After') +
        ' the ' + sr.first_step + '-min start now, this ' + session + '-min session' + (at ? ' at ' + at : '') +
        ' covers more of the remaining ' + remaining + ' min.';
      skel.cont = it;
      skel.itemsById[it.item_id] = it;
      skel.sectionById[it.item_id] = 'today';
      skel.today.push(it);
      continue;
    }
    if (missedAt !== null) {
      var dueDesc = pipDueDesc(sr.due_ms, S.now_ms);
      it.action = 'Squeeze in ' + sr.title + ' (~' + session + ' min) ' + pipBy(dueDesc);
      it.why = 'It is due ' + dueDesc + ', before the next open slot at ' + pipMinClock(S, missedAt) +
        ', so it needs a gap you make yourself.';
      skel.warnings.push({ task_id: sr.task_id, text: sr.title + ' is due ' + dueDesc + ', before your next open slot at ' +
        pipMinClock(S, missedAt) + '.' });
    } else if (pipIsGrocery(sr)) {
      it.action = 'Buy groceries with a ' + pipMoney(S.money.cap) + ' cap (~' + session + ' min)';
      it.why = pipGroceryWhy(S);
    } else if (sr.due_ms !== null) {
      it.action = (pipIsDeepWork(sr) ? 'Work on ' : 'Do: ') + sr.title + ' for ' + session + ' min';
      it.why = 'It is due ' + pipDueDesc(sr.due_ms, S.now_ms) +
        (at ? ', so this ' + session + '-min session at ' + at + ' keeps it on track.' : ', so fit a session in whenever you can today.');
    } else {
      it.action = 'Do: ' + sr.title + ' (~' + session + ' min)';
      it.why = 'It covers a basic need today' + (at ? ', so ' + session + ' min are set aside at ' + at + '.' : '.');
    }
    if (sr.guard) {
      if (missedAt === null) {
        it.why = sr.title + ' has been open ' + Math.round(sr.hours_open) + ' h and put off ' + pipPlural(sr.defer_count, 'time') +
          ', so UniMate keeps it on today\'s plan' + (at ? ' at ' + at : '') + '.';
      }
      skel.balance_guard.push(pipGuardSentence(S, sr, slot ? slot.start : null));
    }
    skel.today.push(it);
  }
  for (i = 0; i < later.length; i++) {
    skel.today.push(pipBlockItem(S, later[i], later[i].title + ' is fixed from ' + pipMinClock(S, later[i].start) +
      ' to ' + pipMinClock(S, later[i].end) + ', so nothing else is planned then.'));
  }
  bedtime = pipStableSort(bedtime, function (a, b) {
    if (a.guard !== b.guard) { return a.guard ? -1 : 1; }
    return b.score - a.score;
  });
  for (i = 0; i < bedtime.length; i++) {
    var g = bedtime[i];
    var gi = pipTaskItem(g);
    var bed = pipMinClock(S, S.bed_min);
    gi.starts_at = pipMinTs(S, S.bed_min);
    gi.ends_at = null;
    gi.action = /sleep/i.test(g.title + ' ' + g.raw_text) ? 'Lights out by ' + bed : 'Start ' + g.title + ' at ' + bed;
    if (g.guard) {
      gi.why = g.title + ' has been open ' + Math.round(g.hours_open) + ' h and put off ' + pipPlural(g.defer_count, 'time') +
        ', so UniMate protects it at ' + bed + ' tonight.';
      skel.balance_guard.push(pipGuardSentence(S, g, S.bed_min));
    } else {
      gi.why = 'Rest keeps tomorrow workable, so it starts at ' + bed + ' tonight.';
    }
    skel.today.push(gi);
  }
  for (i = 0; i < wait.length; i++) {
    var w = pipTaskItem(wait[i]);
    w.action = 'Later: ' + wait[i].title + (wait[i].est !== null ? ' (~' + wait[i].est + ' min)' : '');
    w.why = pipCanWaitWhy(S, wait[i]);
    skel.can_wait.push(w);
  }
  for (i = 0; i < skel.today.length; i++) {
    if (skel.today[i].kind === 'task' && skel.today[i].item_id === skel.today[i].task_id) {
      skel.itemsById[skel.today[i].task_id] = skel.today[i];
      skel.sectionById[skel.today[i].task_id] = 'today';
    }
  }
  for (i = 0; i < skel.can_wait.length; i++) {
    skel.itemsById[skel.can_wait[i].task_id] = skel.can_wait[i];
    skel.sectionById[skel.can_wait[i].task_id] = 'can_wait';
  }

  var windowText = (S.eff < S.fw.minutes) ? 'you have ' + Math.max(0, S.eff) + ' of the ' + S.fw.label : S.fw.label;
  skel.summary = dn
    ? 'Do ' + dn.title + ' now: ' + windowText + '.' + (skel.warnings.length ? ' ' + skel.warnings[0].text : '')
    : 'Nothing needs doing right now: ' + windowText + '.';
  skel.answer = pipAnswer(S, skel);
  return skel;
}
