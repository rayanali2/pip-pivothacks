// ---------------------------------------------------------------------------
// EXTRACT_FROM_TRANSCRIPT(CAPTURE_ID VARCHAR) RETURNS VARIANT
// {tasks: Task[], constraints: Constraint[], model, attempts[, error]}
// ---------------------------------------------------------------------------
function pipCleanTs(v) {
  var ms = pipParseTs(v);
  return ms === null ? null : pipFmtTs(ms);
}
function pipCleanConstraint(c) {
  if (!c || typeof c !== 'object') { return null; }
  var kind = pipTrim(c.kind);
  var v = (c.value && typeof c.value === 'object') ? c.value : {};
  if (kind === 'fixed_block') {
    var s = pipParseHm(v.starts_at);
    if (s === null) { return null; }
    var e = pipParseHm(v.ends_at);
    return { kind: kind, value: {
      title: pipTrim(v.title) || 'Class',
      starts_at: pipFmtHmOfDay(s),
      ends_at: e === null ? null : pipFmtHmOfDay(e),
      location: pipTrim(v.location) || null
    } };
  }
  if (kind === 'cash') {
    var amount = pipNum(v.amount);
    if (amount === null || amount < 0) { return null; }
    var until = pipParseDate(v.until);
    return { kind: kind, value: { amount: Math.round(amount * 100) / 100, until: until === null ? null : pipFmtDate(until) } };
  }
  if (kind === 'time_window') {
    var minutes = pipNum(v.minutes);
    if (minutes === null || minutes <= 0) { return null; }
    return { kind: kind, value: { minutes: Math.round(minutes) } };
  }
  if (kind === 'travel') {
    var tm = pipNum(v.minutes);
    if (tm === null || tm <= 0) { return null; }
    return { kind: kind, value: { minutes: Math.round(tm), to: pipTrim(v.to) || null } };
  }
  return null;
}

function pipExtractPrompt(transcript, nowStr, openTasks, profile) {
  var nowMs = pipParseTs(nowStr);
  var today = pipDayStart(nowMs);
  var days = [];
  for (var k = 1; k <= 7; k++) {
    var d = today + k * 86400000;
    days.push(PIP_DAY_LONG[new Date(d).getUTCDay()] + ' = ' + pipFmtDate(d));
  }
  var taskLines = [];
  for (var i = 0; i < openTasks.length; i++) {
    taskLines.push('  - id "' + openTasks[i].id + '" | ' + openTasks[i].category + ' | ' + openTasks[i].text);
  }
  return [
    'You extract tasks and constraints for Pip, a day planner for a first-time independent university student.',
    'Reply with ONLY one JSON object (no prose, no code fences) with exactly this shape:',
    '{"tasks":[{"raw_text":"...","normalized_text":"...","category":"...","due_at":"YYYY-MM-DDTHH:MI:SS or null","money_at_risk":0,"est_minutes":0,"existing_task_id":"id or null"}],"constraints":[{"kind":"...","value":{}}]}',
    '',
    'Rules:',
    '- category is exactly one of: class, assignment, errand, meal, money, work, club, social, rest.',
    '- raw_text is the student\'s own words for that task; normalized_text is a short imperative phrase such as "Return headphones for refund".',
    '- Now is ' + nowStr + ' (' + PIP_DAY_LONG[new Date(nowMs).getUTCDay()] + '). Today is ' + pipFmtDate(today) + '; tomorrow is ' + pipFmtDate(today + 86400000) + '.',
    '- A weekday name means the next such day strictly after today: ' + days.join(', ') + '.',
    '- Write every deadline as local time "YYYY-MM-DDTHH:MI:SS". A bare time such as "5 PM" means today at 17:00:00. "Due tomorrow" without a time means tomorrow at 23:59:00. No deadline mentioned means null.',
    '- money_at_risk is the dollars lost if the deadline is missed (refund, fee, fine), otherwise null. est_minutes is a realistic whole-minute estimate, or null.',
    '- A class, lab, lecture, shift or appointment at a fixed time is NOT a task. Output it as a constraint {"kind":"fixed_block","value":{"title":"...","starts_at":"HH:MM","ends_at":"HH:MM or null","location":"... or null"}} with 24-hour times.',
    '- "$X until <day>" is a constraint {"kind":"cash","value":{"amount":X,"until":"YYYY-MM-DD"}}.',
    '- "I only have N minutes" is a constraint {"kind":"time_window","value":{"minutes":N}}; half an hour = 30, an hour = 60.',
    '- Travel time ("20 minutes to get to campus") is a constraint {"kind":"travel","value":{"minutes":N,"to":"..."}}.',
    '- The student already has these open tasks. If the transcript mentions one of them again, set existing_task_id to its id and keep its category; otherwise existing_task_id is null.',
    taskLines.length ? taskLines.join('\n') : '  (none)',
    '- Questions such as "What should I do?" are not tasks. Never invent anything that was not said.',
    '- Current cash on file: ' + pipMoney(profile.cash) + '.',
    '- If nothing is found reply {"tasks":[],"constraints":[]}.',
    '',
    'Transcript:',
    '"""' + transcript + '"""'
  ].join('\n');
}

function pipExtractMain(captureId) {
  var caps = pipRows('SELECT student_id AS STUDENT_ID, transcript AS TRANSCRIPT FROM PIP.APP.CAPTURES WHERE capture_id = ?',
    [pipStr(captureId)], ['STUDENT_ID', 'TRANSCRIPT']);
  if (!caps.length) {
    return { tasks: [], constraints: [], model: null, attempts: 0, error: 'capture not found: ' + pipStr(captureId) };
  }
  var studentId = String(caps[0].STUDENT_ID);
  var transcript = pipStr(caps[0].TRANSCRIPT);
  var nowStr = pipNowLocal();

  var openRows = pipRows("SELECT task_id AS TASK_ID, category AS CATEGORY, normalized_text AS NORMALIZED_TEXT FROM PIP.APP.TASKS " +
    "WHERE student_id = ? AND status IN ('open', 'deferred') ORDER BY created_at", [studentId], ['TASK_ID', 'CATEGORY', 'NORMALIZED_TEXT']);
  var openTasks = [];
  var openIds = {};
  for (var i = 0; i < openRows.length; i++) {
    openTasks.push({ id: String(openRows[i].TASK_ID), category: pipStr(openRows[i].CATEGORY), text: pipStr(openRows[i].NORMALIZED_TEXT) });
    openIds[String(openRows[i].TASK_ID)] = pipStr(openRows[i].CATEGORY);
  }
  var profRows = pipRows('SELECT cash_available::FLOAT AS CASH FROM PIP.APP.PROFILE WHERE student_id = ?', [studentId], ['CASH']);
  var profile = { cash: profRows.length ? (pipNum(profRows[0].CASH) || 0) : 0 };

  var llm = pipCompleteJson(pipExtractPrompt(transcript, nowStr, openTasks, profile));
  if (!llm.obj) {
    return { tasks: [], constraints: [], model: null, attempts: 2, error: 'LLM extraction failed: ' + llm.errors.join(' | ') };
  }

  var touched = [];
  var rawTasks = (llm.obj.tasks instanceof Array) ? llm.obj.tasks : [];
  for (var t = 0; t < rawTasks.length && t < 20; t++) {
    var x = rawTasks[t];
    if (!x || typeof x !== 'object') { continue; }
    var raw = pipTrim(x.raw_text);
    var norm = pipTrim(x.normalized_text) || raw;
    if (!raw) { raw = norm; }
    if (!norm) { continue; }
    if (norm.length > 200) { norm = norm.substring(0, 200); }
    var category = pipIn(PIP_CATEGORIES, pipTrim(x.category)) ? pipTrim(x.category) : 'errand';
    var due = pipCleanTs(x.due_at);
    var money = pipNum(x.money_at_risk);
    money = (money !== null && money > 0) ? String(Math.round(money * 100) / 100) : '';
    var est = pipNum(x.est_minutes);
    est = (est !== null && est > 0) ? String(Math.round(est)) : '';
    var existing = pipTrim(x.existing_task_id);
    var targetId = (existing && openIds.hasOwnProperty(existing)) ? existing : null;

    if (!targetId) {
      var sim = pipRows("SELECT task_id AS TASK_ID FROM PIP.APP.TASKS WHERE student_id = ? AND status IN ('open', 'deferred') " +
        'AND category = ? AND JAROWINKLER_SIMILARITY(LOWER(normalized_text), LOWER(?)) >= 80 ' +
        'ORDER BY JAROWINKLER_SIMILARITY(LOWER(normalized_text), LOWER(?)) DESC, created_at LIMIT 1',
        [studentId, category, norm, norm], ['TASK_ID']);
      if (sim.length) { targetId = String(sim[0].TASK_ID); }
    }

    if (targetId) {
      pipExec('UPDATE PIP.APP.TASKS SET ' +
        'due_at = COALESCE(TRY_TO_TIMESTAMP_NTZ(NULLIF(?, \'\'), ' + PIP_TS_FMT + '), due_at), ' +
        'money_at_risk = COALESCE(TRY_TO_NUMBER(NULLIF(?, \'\'), 10, 2), money_at_risk), ' +
        'est_minutes = COALESCE(TRY_TO_NUMBER(NULLIF(?, \'\')), est_minutes), ' +
        "capture_id = ?, status = 'open' " +
        'WHERE task_id = ? AND student_id = ?',
        [due || '', money, est, String(captureId), targetId, studentId]);
    } else {
      targetId = pipUuid();
      pipExec('INSERT INTO PIP.APP.TASKS (task_id, student_id, capture_id, raw_text, normalized_text, category, due_at, ' +
        'money_at_risk, est_minutes, status, defer_count, created_at) ' +
        'SELECT ?, ?, ?, ?, ?, ?, TRY_TO_TIMESTAMP_NTZ(NULLIF(?, \'\'), ' + PIP_TS_FMT + '), ' +
        "TRY_TO_NUMBER(NULLIF(?, ''), 10, 2), TRY_TO_NUMBER(NULLIF(?, '')), 'open', 0, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ",
        [targetId, studentId, String(captureId), raw, norm, category, due || '', money, est]);
    }
    if (!pipIn(touched, targetId)) { touched.push(targetId); }
  }

  var constraints = [];
  var rawCons = (llm.obj.constraints instanceof Array) ? llm.obj.constraints : [];
  for (var c = 0; c < rawCons.length && c < 20; c++) {
    var cc = pipCleanConstraint(rawCons[c]);
    if (!cc) { continue; }
    var cid = pipUuid();
    var created = pipNowLocal();
    pipExec('INSERT INTO PIP.APP.CONSTRAINTS (constraint_id, capture_id, kind, value, created_at) ' +
      'SELECT ?, ?, ?, PARSE_JSON(?), TO_TIMESTAMP_NTZ(?, ' + PIP_TS_FMT + ')',
      [cid, String(captureId), cc.kind, JSON.stringify(cc.value), created]);
    if (cc.kind === 'cash') {
      pipExec('MERGE INTO PIP.APP.PROFILE p ' +
        'USING (SELECT ? AS sid, TRY_TO_NUMBER(?, 10, 2) AS cash, TRY_TO_DATE(NULLIF(?, \'\'), \'YYYY-MM-DD\') AS until_d) s ' +
        'ON p.student_id = s.sid ' +
        'WHEN MATCHED THEN UPDATE SET cash_available = s.cash, budget_until = COALESCE(s.until_d, p.budget_until), ' +
        'updated_at = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ ' +
        'WHEN NOT MATCHED THEN INSERT (student_id, chronotype, cooks_own_meals, cash_available, budget_until, procrastinates_on, updated_at) ' +
        "VALUES (s.sid, 'neutral', TRUE, s.cash, s.until_d, NULL, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)",
        [studentId, String(cc.value.amount), cc.value.until || '']);
    }
    constraints.push({ constraint_id: cid, capture_id: String(captureId), kind: cc.kind, value: cc.value, created_at: created });
  }

  var tasks = [];
  for (var j = 0; j < touched.length; j++) {
    var row = pipLoadTask(touched[j]);
    if (row) { tasks.push(row); }
  }
  return { tasks: tasks, constraints: constraints, model: llm.model, attempts: llm.attempts };
}

try {
  return pipExtractMain(CAPTURE_ID);
} catch (err) {
  return { tasks: [], constraints: [], model: null, attempts: 0, error: String((err && err.message) || err) };
}
