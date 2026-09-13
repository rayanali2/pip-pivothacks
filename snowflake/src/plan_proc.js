// ---------------------------------------------------------------------------
// BUILD_PLAN part 3: load data, run the SQL pre-rank, call Cortex, validate,
// insert into PLANS and return the Plan (api/src/types.ts).
// EXTRA_CONTEXT = {now_local, available_minutes?, cash_available?, question?,
//                  previous_plan_id?, trigger, skip_llm?}   (skip_llm is a Pip extension)
// ---------------------------------------------------------------------------
function pipBool(v) { return v === true || v === 1 || String(v).toLowerCase() === 'true'; }

var PIP_PRERANK_SQL = [
  'WITH params AS (',
  '  SELECT TO_TIMESTAMP_NTZ(?, ' + PIP_TS_FMT + ') AS now_ts,',
  '         CAST(? AS NUMBER) AS eff_min,',
  "         TRY_TO_TIMESTAMP_NTZ(NULLIF(?, ''), " + PIP_TS_FMT + ') AS nb_start,',
  "         TRY_TO_TIMESTAMP_NTZ(NULLIF(?, ''), " + PIP_TS_FMT + ') AS nb_end',
  '), base AS (',
  '  SELECT t.task_id, t.raw_text, t.normalized_text, t.category, t.due_at, t.money_at_risk, t.est_minutes,',
  '         COALESCE(t.defer_count, 0) AS defers, t.created_at,',
  '         p.now_ts, p.eff_min, p.nb_start, p.nb_end,',
  "         COALESCE(d.curve, 'linear') AS cfg_curve,",
  '         COALESCE(d.half_life_hours, 72) AS cfg_half_life,',
  '         COALESCE(d.floor_weight, 0.1) AS cfg_floor,',
  '         DATEDIFF(second, p.now_ts, t.due_at) / 3600.0 AS hours_to_due,',
  '         GREATEST(0, DATEDIFF(second, t.created_at, p.now_ts) / 3600.0) AS hours_open,',
  '         PIP.APP.PIP_FIRST_STEP_MINUTES(t.category, t.est_minutes) AS first_step',
  '  FROM PIP.APP.TASKS t',
  '  CROSS JOIN params p',
  '  LEFT JOIN PIP.APP.DECAY_CONFIG d ON d.category = t.category',
  "  WHERE t.student_id = ? AND t.status IN ('open', 'deferred') AND (t.due_at IS NULL OR t.due_at > p.now_ts)",
  '), ruled AS (',
  '  SELECT b.*,',
  '    ((COALESCE(b.money_at_risk, 0) > 0 AND b.due_at IS NOT NULL AND b.due_at <= DATEADD(hour, 24, b.now_ts))',
  "      OR (b.category IN ('assignment', 'work', 'money') AND b.due_at IS NOT NULL AND b.due_at <= DATEADD(hour, 12, b.now_ts))) AS r1,",
  '    (b.due_at IS NOT NULL AND b.nb_start IS NOT NULL AND b.nb_start > b.now_ts AND b.due_at <= b.nb_end) AS r2,',
  "    (b.category IN ('meal', 'rest') OR REGEXP_INSTR(LOWER(COALESCE(b.normalized_text, '') || ' ' || COALESCE(b.raw_text, '')),",
  "      'grocer|medic|pharm|prescription|sleep|lunch|dinner|breakfast|meal') > 0) AS r3,",
  '    (b.eff_min > 0 AND b.first_step <= b.eff_min) AS r4,',
  "    (b.category IN ('assignment', 'class', 'work') AND b.due_at IS NOT NULL AND b.due_at <= DATEADD(hour, 48, b.now_ts)) AS r5,",
  "    (b.category IN ('meal', 'rest') AND (COALESCE(b.hours_open, 0) >= 36 OR b.defers >= 2)) AS guard_fired,",
  "    IFF(COALESCE(b.money_at_risk, 0) > 0 AND b.due_at IS NOT NULL, 'cliff',",
  "      IFF(b.cfg_curve = 'cliff' AND b.due_at IS NULL, 'linear', b.cfg_curve)) AS curve_kind",
  '  FROM base b',
  ')',
  'SELECT r.task_id AS TASK_ID, r.raw_text AS RAW_TEXT, r.normalized_text AS NORMALIZED_TEXT, r.category AS CATEGORY,',
  '       TO_VARCHAR(r.due_at, ' + PIP_TS_FMT + ') AS DUE_S, r.money_at_risk::FLOAT AS MONEY, r.est_minutes::FLOAT AS EST,',
  '       r.defers::FLOAT AS DEFERS, r.hours_open::FLOAT AS HOURS_OPEN, r.first_step::FLOAT AS FIRST_STEP,',
  '       r.r1 AS R1, r.r2 AS R2, r.r3 AS R3, r.r4 AS R4, r.r5 AS R5, r.guard_fired AS GUARD_FIRED, r.curve_kind AS CURVE_KIND,',
  '       (10000 * IFF(r.r1, 1, 0) + 1000 * IFF(r.r2, 1, 0) + 100 * IFF(r.r3, 1, 0) + 10 * IFF(r.r4, 1, 0) + IFF(r.r5, 1, 0)',
  '        + COALESCE(ROUND(0.99 * PIP.APP.PIP_DECAY_COST(r.curve_kind, r.cfg_floor, r.cfg_half_life, r.hours_to_due, r.hours_open, r.defers, 2), 4), 0))::FLOAT AS SCORE',
  'FROM ruled r',
  // same order as compareEvals in api/src/ranker/rules.ts: score desc, earliest due (undated last), task_id
  'ORDER BY SCORE DESC, DUE_S ASC NULLS LAST, TASK_ID'
].join('\n');
var PIP_PRERANK_COLS = ['TASK_ID', 'RAW_TEXT', 'NORMALIZED_TEXT', 'CATEGORY', 'DUE_S', 'MONEY', 'EST', 'DEFERS', 'HOURS_OPEN',
  'FIRST_STEP', 'R1', 'R2', 'R3', 'R4', 'R5', 'GUARD_FIRED', 'CURVE_KIND', 'SCORE'];

function pipBuildPlanMain(studentIdArg, captureIdArg, extraArg) {
  var i;
  var sid = pipTrim(studentIdArg);
  var cid = pipTrim(captureIdArg);
  var ctx = extraArg;
  if (typeof ctx === 'string') { try { ctx = JSON.parse(ctx); } catch (e) { ctx = {}; } }
  if (!ctx || typeof ctx !== 'object' || ctx instanceof Array) { ctx = {}; }
  if (!sid) { return { error: 'student_id is required' }; }

  // 1. scenario clock
  var nowMs = pipParseTs(ctx.now_local);
  if (nowMs === null) { nowMs = pipParseTs(pipNowLocal()); }
  var nowStr = pipFmtTs(nowMs);
  var dayMs = pipDayStart(nowMs);
  var nowMin = (nowMs - dayMs) / 60000;
  var dow = pipIsoDow(nowMs);
  var ctxMinutes = pipNum(ctx.available_minutes);
  var ctxCash = pipNum(ctx.cash_available);
  var extra = {
    available_minutes: (ctxMinutes !== null && ctxMinutes >= 0) ? Math.round(ctxMinutes) : null,
    cash_available: (ctxCash !== null && ctxCash >= 0) ? Math.round(ctxCash * 100) / 100 : null,
    question: (typeof ctx.question === 'string' && pipTrim(ctx.question)) ? pipTrim(ctx.question) : null,
    previous_plan_id: pipTrim(ctx.previous_plan_id) || null,
    trigger: pipIn(['capture', 'rerank', 'seed'], pipTrim(ctx.trigger)) ? pipTrim(ctx.trigger) : 'capture'
  };

  // 2. today's blocks = timetable + fixed_block constraints of this capture (dedup by start time)
  var blocks = [];
  var tt = pipRows("SELECT title AS TITLE, TO_VARCHAR(starts_at, 'HH24:MI') AS START_HM, TO_VARCHAR(ends_at, 'HH24:MI') AS END_HM, " +
    'location AS LOCATION FROM PIP.APP.TIMETABLE WHERE student_id = ? AND day_of_week = ? ORDER BY starts_at',
    [sid, dow], ['TITLE', 'START_HM', 'END_HM', 'LOCATION']);
  for (i = 0; i < tt.length; i++) {
    var bs = pipParseHm(tt[i].START_HM);
    var be = pipParseHm(tt[i].END_HM);
    if (bs === null) { continue; }
    if (be === null || be <= bs) { be = Math.min(bs + 60, 24 * 60); }
    blocks.push({ title: pipStr(tt[i].TITLE), start: bs, end: be, location: pipTrim(tt[i].LOCATION) || null });
  }
  var timeWindow = null;
  var cashC = null;
  if (cid) {
    var cons = pipRows('SELECT kind AS KIND, value AS VAL FROM PIP.APP.CONSTRAINTS WHERE capture_id = ? ORDER BY created_at',
      [cid], ['KIND', 'VAL']);
    for (i = 0; i < cons.length; i++) {
      var v = cons[i].VAL;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e2) { v = null; } }
      if (!v || typeof v !== 'object') { continue; }
      var kind = pipStr(cons[i].KIND);
      if (kind === 'fixed_block') {
        var cs = pipParseHm(v.starts_at);
        if (cs === null) { continue; }
        var dup = false;
        for (var k = 0; k < blocks.length; k++) { if (blocks[k].start === cs) { dup = true; } }
        if (dup) { continue; }
        var ce = pipParseHm(v.ends_at);
        if (ce === null || ce <= cs) { ce = Math.min(cs + 60, 24 * 60); }
        blocks.push({ title: pipTrim(v.title) || 'Class', start: cs, end: ce, location: pipTrim(v.location) || null });
      } else if (kind === 'time_window') {
        var twm = pipNum(v.minutes);
        if (twm !== null && twm > 0) { timeWindow = Math.round(twm); }
      } else if (kind === 'cash') {
        var amt = pipNum(v.amount);
        if (amt !== null && amt >= 0) { cashC = { amount: amt, until_ms: pipParseDate(v.until) }; }
      }
    }
  }
  blocks = pipStableSort(blocks, function (a, b) { return a.start !== b.start ? a.start - b.start : a.end - b.end; });
  var fw = pipFreeWindow(nowMs, dayMs, blocks);
  if (extra.available_minutes === null && timeWindow !== null) { extra.available_minutes = timeWindow; }
  var eff = extra.available_minutes !== null ? Math.min(fw.minutes, extra.available_minutes) : fw.minutes;

  // 3. money: capture cash constraint overrides PROFILE, EXTRA_CONTEXT cash overrides both
  var prof = pipRows("SELECT chronotype AS CHRONOTYPE, cash_available::FLOAT AS CASH, TO_VARCHAR(budget_until, 'YYYY-MM-DD') AS UNTIL_S " +
    'FROM PIP.APP.PROFILE WHERE student_id = ?', [sid], ['CHRONOTYPE', 'CASH', 'UNTIL_S']);
  var chronotype = (prof.length && pipIn(['early_bird', 'neutral', 'night_owl'], pipStr(prof[0].CHRONOTYPE))) ? pipStr(prof[0].CHRONOTYPE) : 'neutral';
  var cash = prof.length ? (pipNum(prof[0].CASH) || 0) : 0;
  var untilMs = prof.length ? pipParseDate(prof[0].UNTIL_S) : null;
  if (cashC) { cash = cashC.amount; if (cashC.until_ms !== null) { untilMs = cashC.until_ms; } }
  if (extra.cash_available !== null) { cash = extra.cash_available; }
  var days = (untilMs !== null) ? Math.max(1, pipDaysBetween(dayMs, untilMs)) : null;
  var money = {
    cash: cash, until_ms: untilMs, budget_until: untilMs !== null ? pipFmtDate(untilMs) : null, days: days,
    daily: days !== null ? Math.round(cash / days * 100) / 100 : null, cap: Math.floor(cash * 0.6)
  };

  // 4. past-due open tasks expire
  pipExec("UPDATE PIP.APP.TASKS SET status = 'expired' WHERE student_id = ? AND status IN ('open', 'deferred') " +
    'AND due_at IS NOT NULL AND due_at <= TO_TIMESTAMP_NTZ(?, ' + PIP_TS_FMT + ')', [sid, nowStr]);

  // 5. SQL pre-rank (R1..R5, balance guard, first step, fits, score)
  var nb = fw.next;
  var q = pipRows(PIP_PRERANK_SQL, [nowStr, eff, nb ? pipFmtTs(dayMs + nb.start * 60000) : '',
    nb ? pipFmtTs(dayMs + nb.end * 60000) : '', sid], PIP_PRERANK_COLS);
  var rows = [];
  var rowsById = {};
  for (i = 0; i < q.length; i++) {
    var cat = pipStr(q[i].CATEGORY);
    var r = {
      task_id: String(q[i].TASK_ID), raw_text: pipStr(q[i].RAW_TEXT),
      title: pipStr(q[i].NORMALIZED_TEXT) || pipStr(q[i].RAW_TEXT),
      category: pipIn(PIP_CATEGORIES, cat) ? cat : 'errand',
      due_at: pipIsNil(q[i].DUE_S) ? null : String(q[i].DUE_S), due_ms: pipParseTs(q[i].DUE_S),
      money: pipNum(q[i].MONEY), est: pipNum(q[i].EST), defer_count: pipNum(q[i].DEFERS) || 0,
      hours_open: pipNum(q[i].HOURS_OPEN) || 0, first_step: pipNum(q[i].FIRST_STEP) || 15,
      r1: pipBool(q[i].R1), r2: pipBool(q[i].R2), r3: pipBool(q[i].R3), r4: pipBool(q[i].R4), r5: pipBool(q[i].R5),
      guard: pipBool(q[i].GUARD_FIRED), curve_kind: pipStr(q[i].CURVE_KIND) || 'linear', score: pipNum(q[i].SCORE) || 0
    };
    r.fits = r.r4;
    r.at_risk = r.r1 && r.r2 && !r.r4;
    r.rules_fired = [];
    if (r.r1) { r.rules_fired.push('irreversible_loss'); }
    if (r.r2) { r.rules_fired.push('fixed_block_collision'); }
    if (r.r3) { r.rules_fired.push('basic_needs'); }
    if (r.r4) { r.rules_fired.push('fits_window'); }
    if (r.r5) { r.rules_fired.push('academic_deadline'); }
    rows.push(r);
    rowsById[r.task_id] = r;
  }

  var S = {
    student_id: sid, capture_id: cid || null, now_ms: nowMs, now_str: nowStr, day_ms: dayMs, now_min: nowMin, dow: dow,
    blocks: blocks, fw: fw, eff: eff, rows: rows, rowsById: rowsById, chronotype: chronotype,
    bed_min: pipBedMin(chronotype), money: money, extra: extra
  };

  // 6. deterministic skeleton (also the no-LLM plan)
  var skel = pipBuildSkeleton(S);
  var fin = { do_now: skel.do_now, next: skel.next, today: skel.today, can_wait: skel.can_wait, summary: skel.summary, answer: skel.answer };
  var model = 'sql-prerank';
  var cortexErrors = [];

  // 7-8. Cortex wording + validation
  if (rows.length > 0 && !pipBool(ctx.skip_llm)) {
    var llm = pipCompleteJson(pipPlanPrompt(S, skel));
    if (llm.obj) {
      fin = pipMergeLlm(S, skel, llm.obj);
      model = llm.model;
    } else {
      cortexErrors = llm.errors;
    }
  }

  // 10. reasoning
  var preRank = [];
  for (i = 0; i < rows.length; i++) {
    preRank.push({ task_id: rows[i].task_id, score: Math.round(rows[i].score * 10000) / 10000, rules_fired: rows[i].rules_fired,
      first_step_minutes: rows[i].first_step, fits: rows[i].fits });
  }
  var reasoning = {
    summary: fin.summary,
    now: nowStr,
    free_window: fw.json,
    effective_minutes: eff,
    context: { available_minutes: extra.available_minutes, cash_available: extra.cash_available, question: extra.question },
    cash_available: cash,
    budget_until: money.budget_until,
    days_until_budget: days,
    daily_budget: money.daily,
    warnings: skel.warnings,
    balance_guard: skel.balance_guard,
    answer: fin.answer,
    pre_rank: preRank,
    trigger: extra.trigger,
    previous_plan_id: extra.previous_plan_id
  };

  // 11. append to PLANS and return the Plan
  var planId = pipUuid();
  var rec = pipNowRecord();
  var createdAt = rec.short;
  pipExec('INSERT INTO PIP.APP.PLANS (plan_id, student_id, capture_id, do_now, next, today, can_wait, reasoning, model, created_at) ' +
    "SELECT ?, ?, NULLIF(?, ''), PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?), ?, TO_TIMESTAMP_NTZ(?, " + PIP_TS_MS_FMT + ')',
    [planId, sid, cid, JSON.stringify(fin.do_now), JSON.stringify(fin.next), JSON.stringify(fin.today),
      JSON.stringify(fin.can_wait), JSON.stringify(reasoning), model, rec.full]);
  var plan = {
    plan_id: planId, student_id: sid, capture_id: cid || null, created_at: createdAt, model: model,
    do_now: fin.do_now, next: fin.next, today: fin.today, can_wait: fin.can_wait, reasoning: reasoning
  };
  if (cortexErrors.length) { plan.cortex_errors = cortexErrors; }
  return plan;
}

try {
  return pipBuildPlanMain(STUDENT_ID, CAPTURE_ID, EXTRA_CONTEXT);
} catch (err) {
  return { error: String((err && err.message) || err) };
}
