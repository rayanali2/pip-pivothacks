// ---------------------------------------------------------------------------
// BUILD_PLAN part 2: deterministic follow-up answer, Cortex prompt, and the
// validation/merge of the LLM reply onto the skeleton (CONTRACT sections 3, 4, 6).
// ---------------------------------------------------------------------------
function pipAnswer(S, skel) {
  var q = S.extra.question ? String(S.extra.question) : '';
  var lq = q.toLowerCase();
  var dn = skel.doNowRow;
  var m = S.money;
  var i;
  if (q && /afford|money|budget|cash|spend/.test(lq)) {
    var risk = 0;
    for (i = 0; i < S.rows.length; i++) { if (S.rows[i].money !== null && S.rows[i].money > 0) { risk += S.rows[i].money; } }
    return 'You have ' + pipMoney(m.cash) +
      (m.until_ms !== null ? ' until ' + pipDayLabel(m.until_ms) + ' (' + pipPlural(m.days, 'day') + ', about ' + pipMoney(m.daily) + '/day)' : '') +
      ', so keep groceries under ' + pipMoney(m.cap) +
      (risk > 0 ? ' and remember ' + pipMoney(risk) + ' is at risk in open tasks.' : '.');
  }
  var wn = /why not (.+)/.exec(lq);
  if (wn && dn) {
    var words = wn[1].replace(/[^a-z0-9 ]/g, ' ').split(/\s+/);
    var best = null;
    var bestScore = 0;
    for (i = 0; i < S.rows.length; i++) {
      var r = S.rows[i];
      if (r === dn) { continue; }
      var hay = (r.title + ' ' + r.raw_text).toLowerCase();
      var sc = 0;
      for (var w = 0; w < words.length; w++) { if (words[w].length >= 3 && hay.indexOf(words[w]) >= 0) { sc++; } }
      if (sc > bestScore) { best = r; bestScore = sc; }
    }
    if (best) {
      return best.title + (best.due_ms !== null ? ' is due ' + pipDueDesc(best.due_ms, S.now_ms) : ' has no deadline') +
        ' and shows ' + pipRuleWords(best) + ', while ' + dn.title +
        (dn.due_ms !== null ? ' is due ' + pipDueDesc(dn.due_ms, S.now_ms) + ' and' : '') + ' shows ' + pipRuleWords(dn) + '.';
    }
  }
  if (S.extra.available_minutes !== null || S.extra.cash_available !== null) {
    var lead = S.extra.available_minutes !== null ? 'With ' + S.eff + ' min' : 'With ' + pipMoney(m.cash);
    if (S.extra.available_minutes !== null && S.extra.cash_available !== null) { lead += ' and ' + pipMoney(m.cash); }
    var tail = '.';
    if (skel.warnings.length) {
      var wt = skel.warnings[0].text;
      tail = '; ' + wt.charAt(0).toLowerCase() + wt.substring(1);
    }
    return lead + ', do now is ' + (dn ? dn.title : 'nothing') + tail;
  }
  return null;
}

function pipLiteItem(it) {
  if (!it) { return null; }
  return { item_id: it.item_id, kind: it.kind, task_id: it.task_id, title: it.title, action: it.action, why: it.why,
    starts_at: it.starts_at, ends_at: it.ends_at, flag: it.flag };
}
function pipLiteList(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) { out.push(pipLiteItem(list[i])); }
  return out;
}

function pipPlanPrompt(S, skel) {
  var i;
  var nb = S.fw.next;
  var later = [];
  for (i = 0; i < S.blocks.length; i++) {
    if (nb && S.blocks[i].start > nb.start) {
      later.push(S.blocks[i].title + ' ' + pipMinClock(S, S.blocks[i].start) + '-' + pipMinClock(S, S.blocks[i].end));
    }
  }
  var pre = [];
  for (i = 0; i < S.rows.length; i++) {
    var r = S.rows[i];
    pre.push({ task_id: r.task_id, text: r.title, category: r.category, due_at: r.due_at, money_at_risk: r.money,
      est_minutes: r.est, first_step_minutes: r.first_step, rules_fired: r.rules_fired, fits: r.fits,
      score: Math.round(r.score * 100) / 100, flag: r.at_risk ? 'at_risk' : (r.guard ? 'balance_guard' : null) });
  }
  var m = S.money;
  var warnings = [];
  for (i = 0; i < skel.warnings.length; i++) { warnings.push(skel.warnings[i].text); }
  var skeleton = { do_now: pipLiteItem(skel.do_now), next: pipLiteItem(skel.next), today: pipLiteList(skel.today), can_wait: pipLiteList(skel.can_wait) };
  return [
    'You are Pip, a calm day planner for a first-time independent university student.',
    'A deterministic ranker already ordered the tasks. Improve the plan wording and return it.',
    'Reply with ONLY one JSON object (no prose, no code fences) with exactly this shape:',
    '{"summary":"...","answer":"... or null","do_now":{"task_id":"...","title":"...","action":"...","why":"...","starts_at":"YYYY-MM-DDTHH:MI:SS or null","ends_at":"... or null"},' +
      '"next":{"item_id":"...","kind":"task or fixed_block","task_id":"... or null","title":"...","action":"...","why":"...","starts_at":"...","ends_at":"..."},' +
      '"today":[{same fields as next}],"can_wait":[{same fields as next}]}',
    '',
    'Ranking rules (already applied in the pre-rank):',
    '1 irreversible_loss: money at risk due within 24 h, or an assignment/work/money deadline within 12 h.',
    '2 fixed_block_collision: the deadline passes before the next fixed block ends, so this free window is the last chance.',
    '3 basic_needs: meals, rest, sleep, groceries, medicine.',
    '4 fits_window: the first step fits the effective free minutes.',
    '5 academic_deadline: an assignment, class or work deadline within 48 h.',
    'Balance guard: a meal or rest task open for 36 h or deferred twice always stays in today.',
    '',
    'Hard requirements:',
    '- Keep do_now as the skeleton do_now task unless it no longer fits the effective minutes.',
    '- Use only the task_ids listed below and never invent tasks. Every task appears exactly once across do_now, today and can_wait; a "<task_id>#cont" continuation item in today is allowed. Keep at_risk and balance_guard items in today.',
    '- next stays the fixed block item when the skeleton has one.',
    '- action is the smallest concrete step. Each why is exactly ONE sentence that cites real times (h:mm AM/PM), dollars and minutes. Never mention scores or rule ids.',
    '- summary is one or two sentences Pip can say out loud. answer: if the student asked a question, answer it in one or two sentences; otherwise null.',
    '- Times are local "YYYY-MM-DDTHH:MI:SS". Keep the skeleton times unless a better slot is obvious, and never overlap a fixed block.',
    '',
    'Situation:',
    '- now: ' + S.now_str + ' (' + PIP_DAY_LONG[new Date(S.now_ms).getUTCDay()] + ')',
    '- free window: ' + S.fw.label + '; effective minutes: ' + S.eff,
    '- next fixed block: ' + (nb ? nb.title + ' ' + pipMinClock(S, nb.start) + '-' + pipMinClock(S, nb.end) + (nb.location ? ' at ' + nb.location : '') : 'none'),
    '- later fixed blocks today: ' + (later.length ? later.join('; ') : 'none'),
    '- cash: ' + pipMoney(m.cash) + (m.until_ms !== null ? ' until ' + pipDayLabel(m.until_ms) + ' (' + pipPlural(m.days, 'day') + ', ' + pipMoney(m.daily) + '/day)' : '') + '; grocery cap ' + pipMoney(m.cap),
    '- chronotype: ' + S.chronotype + ' (bedtime ' + pipMinClock(S, S.bed_min) + ')',
    '- balance guard: ' + (skel.balance_guard.length ? skel.balance_guard.join(' ') : 'none'),
    '- warnings: ' + (warnings.length ? warnings.join(' ') : 'none'),
    '- student question: ' + (S.extra.question ? S.extra.question : 'none'),
    '- minutes the student says they have: ' + (S.extra.available_minutes !== null ? S.extra.available_minutes : 'not stated'),
    '',
    'Pre-rank (highest score first):',
    JSON.stringify(pre),
    '',
    'Skeleton plan:',
    JSON.stringify(skeleton)
  ].join('\n');
}

function pipOverlapsBlock(S, sMin, eMin) {
  for (var i = 0; i < S.blocks.length; i++) {
    if (sMin < S.blocks[i].end && eMin > S.blocks[i].start) { return true; }
  }
  return false;
}
// Copy of a skeleton item with the LLM's wording (and optionally slot times) applied.
function pipApplyText(S, item, src, allowTimes) {
  var t = JSON.parse(JSON.stringify(item));
  if (!src || typeof src !== 'object') { return t; }
  var a = pipTrim(src.action);
  if (a && a.length <= 200) { t.action = a; }
  var w = pipOneSentence(src.why);
  if (w) { t.why = w; }
  var ti = pipTrim(src.title);
  if (t.kind === 'task' && ti && ti.length <= 80) { t.title = ti; }
  if (allowTimes && t.kind === 'task' && t.flag === null && t.category !== 'rest') {
    var s = pipParseTs(src.starts_at);
    var e = pipParseTs(src.ends_at);
    if (s !== null && e !== null && e > s && pipDayStart(s) === S.day_ms && pipDayStart(e) === S.day_ms && s >= S.now_ms) {
      var sm = (s - S.day_ms) / 60000;
      var em = (e - S.day_ms) / 60000;
      if (!pipOverlapsBlock(S, sm, em) && em - sm <= 180) { t.starts_at = pipFmtTs(s); t.ends_at = pipFmtTs(e); }
    }
  }
  return t;
}

// Validation (CONTRACT section 6 / BUILD_PLAN step 8). Section membership always
// comes from the skeleton; the LLM contributes wording, order within a section,
// summary/answer and (checked) slot times.
function pipMergeLlm(S, skel, obj) {
  var out = { do_now: skel.do_now, next: skel.next, today: [], can_wait: [], summary: skel.summary, answer: skel.answer };
  var i;
  if (skel.do_now && obj.do_now && typeof obj.do_now === 'object' && pipTrim(obj.do_now.task_id) === skel.do_now.task_id) {
    out.do_now = pipApplyText(S, skel.do_now, obj.do_now, false);
  }
  if (skel.next && obj.next && typeof obj.next === 'object') {
    var nid = pipTrim(obj.next.item_id);
    var ntid = pipTrim(obj.next.task_id);
    var same = (skel.next.kind === 'fixed_block')
      ? (nid === skel.next.item_id || pipTrim(obj.next.kind) === 'fixed_block')
      : (ntid === skel.next.task_id || nid === skel.next.item_id);
    if (same) { out.next = pipApplyText(S, skel.next, obj.next, false); }
  }
  // LLM entries keyed by skeleton item id (first occurrence wins; unknown ids are dropped).
  // Section membership and order always come from the skeleton, so every pre-ranked task
  // appears exactly once across do_now/today/can_wait and nothing is invented.
  var srcByKey = {};
  var lists = [obj.today, obj.can_wait];
  for (var l = 0; l < lists.length; l++) {
    if (!(lists[l] instanceof Array)) { continue; }
    for (var k = 0; k < lists[l].length; k++) {
      var src = lists[l][k];
      if (!src || typeof src !== 'object') { continue; }
      var id = pipTrim(src.item_id);
      var tid = pipTrim(src.task_id);
      var key = null;
      if (id && skel.itemsById.hasOwnProperty(id)) {
        key = id;
      } else if (tid && id.indexOf('#cont') < 0 && id.indexOf('block:') !== 0 && skel.itemsById.hasOwnProperty(tid)) {
        key = tid;
      }
      if (key !== null && !srcByKey.hasOwnProperty(key)) { srcByKey[key] = src; }
    }
  }
  for (i = 0; i < skel.today.length; i++) {
    var todayItem = skel.today[i];
    out.today.push((todayItem.kind === 'task' && srcByKey.hasOwnProperty(todayItem.item_id))
      ? pipApplyText(S, todayItem, srcByKey[todayItem.item_id], true) : todayItem);
  }
  for (i = 0; i < skel.can_wait.length; i++) {
    var waitItem = skel.can_wait[i];
    out.can_wait.push(srcByKey.hasOwnProperty(waitItem.item_id)
      ? pipApplyText(S, waitItem, srcByKey[waitItem.item_id], false) : waitItem);
  }
  var sm = (typeof obj.summary === 'string') ? pipTrim(obj.summary) : '';
  if (sm && sm.length <= 400) { out.summary = sm; }
  if (S.extra.question) {
    var an = (typeof obj.answer === 'string') ? pipTrim(obj.answer) : '';
    if (an && an.length <= 400) { out.answer = an; }
  }
  return out;
}
