// ---------------------------------------------------------------------------
// Shared helpers, inlined by build.mjs at the top of every JavaScript procedure.
// ES5 only (var/function), no template literals, never two dollar signs in a row.
// Times are handled as "naive" wall-clock values: a 'YYYY-MM-DDTHH:MI:SS' string
// is mapped to Date.UTC(...) milliseconds and formatted back with getUTC*, so the
// JavaScript engine's own time zone never matters.
// ---------------------------------------------------------------------------
var PIP_TS_FMT = "'YYYY-MM-DD\"T\"HH24:MI:SS'";
var PIP_CATEGORIES = ['class', 'assignment', 'errand', 'meal', 'money', 'work', 'club', 'social', 'rest'];
var PIP_CONSTRAINT_KINDS = ['time_window', 'cash', 'fixed_block', 'travel'];
var PIP_RULE_IDS = ['irreversible_loss', 'fixed_block_collision', 'basic_needs', 'fits_window', 'academic_deadline'];
var PIP_MODELS = ['claude-sonnet-4-5', 'mistral-large2', 'llama3.1-8b'];
var PIP_COMPLETE_FNS = ['AI_COMPLETE', 'SNOWFLAKE.CORTEX.COMPLETE'];
var PIP_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var PIP_DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var PIP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var PIP_LAST_OK = null;

function pipIn(arr, v) {
  for (var i = 0; i < arr.length; i++) { if (arr[i] === v) { return true; } }
  return false;
}
function pipIsNil(v) { return v === null || v === undefined; }
function pipStr(v) { return pipIsNil(v) ? '' : String(v); }
function pipNum(v) {
  if (pipIsNil(v) || v === '' || typeof v === 'boolean') { return null; }
  var n = Number(v);
  return isFinite(n) ? n : null;
}
function pipP2(n) { return (n < 10 ? '0' : '') + n; }
function pipTrim(s) { return pipStr(s).replace(/^\s+|\s+$/g, ''); }

// ----- SQL ------------------------------------------------------------------
function pipExec(sql, binds) {
  return snowflake.execute({ sqlText: sql, binds: binds || [] });
}
// cols: upper-case column names/aliases to read from each row
function pipRows(sql, binds, cols) {
  var rs = pipExec(sql, binds);
  var out = [];
  while (rs.next()) {
    var row = {};
    for (var i = 0; i < cols.length; i++) {
      var v = rs.getColumnValue(cols[i]);
      row[cols[i]] = (v === undefined) ? null : v;
    }
    out.push(row);
  }
  return out;
}
function pipScalar(sql, binds) {
  var rs = pipExec(sql, binds);
  if (rs.next()) {
    var v = rs.getColumnValue(1);
    return (v === undefined) ? null : v;
  }
  return null;
}
function pipUuid() { return String(pipScalar('SELECT UUID_STRING()', [])); }
function pipNowLocal() {
  return String(pipScalar('SELECT TO_VARCHAR(CURRENT_TIMESTAMP()::TIMESTAMP_NTZ, ' + PIP_TS_FMT + ')', []));
}
// Record timestamp (created_at of plans, actions, constraints). Stored with milliseconds so
// rows written within the same second still order correctly (V_PLAN_HISTORY, history);
// returned to the API without fractional seconds.
var PIP_TS_MS_FMT = "'YYYY-MM-DD\"T\"HH24:MI:SS.FF3'";
function pipNowRecord() {
  var full = String(pipScalar('SELECT TO_VARCHAR(CURRENT_TIMESTAMP()::TIMESTAMP_NTZ, ' + PIP_TS_MS_FMT + ')', []));
  return { full: full, short: full.substring(0, 19) };
}

// ----- time -----------------------------------------------------------------
// 'YYYY-MM-DDTHH:MI[:SS]' (or with a space) -> naive ms, else null
function pipParseTs(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(pipTrim(s));
  if (!m) { return null; }
  var h = Number(m[4]); var mi = Number(m[5]); var se = Number(m[6] || 0);
  if (h > 23 || mi > 59 || se > 59) { return null; }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi, se);
}
function pipParseDate(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(pipTrim(s));
  if (!m) { return null; }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
// 'H:MM' / 'HH:MM[:SS]' / '2 PM' / '2:30 p.m.' -> minutes of day, else null
// (a bare hour without AM/PM, e.g. '14', is rejected as ambiguous)
function pipParseHm(s) {
  var t = pipTrim(s).toLowerCase().replace(/\./g, '');
  var m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/.exec(t);
  if (!m) { return null; }
  var h = Number(m[1]);
  var mi = Number(m[2] || 0);
  if (m[3]) {
    if (h < 1 || h > 12) { return null; }
    if (m[3] === 'pm' && h !== 12) { h += 12; }
    if (m[3] === 'am' && h === 12) { h = 0; }
  } else if (!m[2]) {
    return null;
  }
  if (h > 23 || mi > 59) { return null; }
  return h * 60 + mi;
}
function pipFmtTs(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + '-' + pipP2(d.getUTCMonth() + 1) + '-' + pipP2(d.getUTCDate()) + 'T' +
    pipP2(d.getUTCHours()) + ':' + pipP2(d.getUTCMinutes()) + ':' + pipP2(d.getUTCSeconds());
}
function pipFmtDate(ms) { return pipFmtTs(ms).substring(0, 10); }
function pipFmtHmOfDay(min) { return pipP2(Math.floor(min / 60)) + ':' + pipP2(min % 60); }
function pipDayStart(ms) { var d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
function pipIsoDow(ms) { var d = new Date(ms).getUTCDay(); return d === 0 ? 7 : d; }
// '2:00 PM'
function pipClock(ms) {
  var d = new Date(ms); var h = d.getUTCHours(); var h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + pipP2(d.getUTCMinutes()) + (h < 12 ? ' AM' : ' PM');
}
// 'Fri Sep 18'
function pipDayLabel(ms) {
  var d = new Date(ms);
  return PIP_DAY_NAMES[d.getUTCDay()] + ' ' + PIP_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
}
function pipDaysBetween(fromMs, toMs) { return Math.round((pipDayStart(toMs) - pipDayStart(fromMs)) / 86400000); }
// 'at 5:00 PM today' | 'tomorrow at 11:59 PM' | 'Fri Sep 18 at 5:00 PM'
function pipDueDesc(dueMs, nowMs) {
  var days = pipDaysBetween(nowMs, dueMs);
  if (days === 0) { return 'at ' + pipClock(dueMs) + ' today'; }
  if (days === 1) { return 'tomorrow at ' + pipClock(dueMs); }
  return pipDayLabel(dueMs) + ' at ' + pipClock(dueMs);
}
// '$79' | '$7.50'
function pipMoney(x) {
  var n = Number(x);
  if (Math.abs(n - Math.round(n)) < 0.005) { return '$' + Math.round(n); }
  return '$' + n.toFixed(2);
}
function pipPlural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

// ----- LLM output -------------------------------------------------------------
// Drops code fences / prose by slicing first '{' .. last '}' (same idea as PIP_EXTRACT_JSON).
function pipExtractJson(text) {
  if (pipIsNil(text)) { return null; }
  var s = String(text);
  var a = s.indexOf('{'); var b = s.lastIndexOf('}');
  if (a < 0 || b <= a) { return null; }
  try {
    var o = JSON.parse(s.substring(a, b + 1));
    return (o && typeof o === 'object' && !(o instanceof Array)) ? o : null;
  } catch (e) {
    return null;
  }
}
// first sentence only; '' when not a usable string
function pipOneSentence(s) {
  if (typeof s !== 'string') { return ''; }
  var t = pipTrim(s.replace(/\s+/g, ' '));
  var m = /^(.+?[.!?])\s+[A-Z]/.exec(t);
  if (m) { t = m[1]; }
  if (t.length > 320) { t = t.substring(0, 317) + '...'; }
  return t;
}

// ----- Cortex -------------------------------------------------------------------
function pipCortexConfig() {
  var cfg = {};
  try {
    var rows = pipRows('SELECT key AS CFG_KEY, value AS CFG_VALUE FROM PIP.APP.CORTEX_CONFIG', [], ['CFG_KEY', 'CFG_VALUE']);
    for (var i = 0; i < rows.length; i++) { cfg[String(rows[i].CFG_KEY)] = rows[i].CFG_VALUE; }
  } catch (e) {
    cfg = {};
  }
  return cfg;
}
// One completion. Walks the fallback chain; returns {text, fn, model, errors}.
function pipComplete(prompt) {
  var cfg = pipCortexConfig();
  var order = [];
  var errors = [];
  function add(fn, model) {
    if (!pipIn(PIP_COMPLETE_FNS, fn)) { return; }
    if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9.\-]*$/.test(model)) { return; }
    for (var k = 0; k < order.length; k++) {
      if (order[k].fn === fn && order[k].model === model) { return; }
    }
    order.push({ fn: fn, model: model });
  }
  if (PIP_LAST_OK) { add(PIP_LAST_OK.fn, PIP_LAST_OK.model); }
  add(cfg.complete_fn || 'AI_COMPLETE', cfg.complete_model || 'claude-sonnet-4-5');
  for (var f = 0; f < PIP_COMPLETE_FNS.length; f++) {
    for (var m = 0; m < PIP_MODELS.length; m++) { add(PIP_COMPLETE_FNS[f], PIP_MODELS[m]); }
  }
  for (var i = 0; i < order.length; i++) {
    var a = order[i];
    try {
      var rs = pipExec('SELECT ' + a.fn + "('" + a.model + "', ?) AS OUT_TEXT", [prompt]);
      if (rs.next()) {
        var v = rs.getColumnValue('OUT_TEXT');
        if (!pipIsNil(v)) {
          PIP_LAST_OK = a;
          return { text: (typeof v === 'string') ? v : JSON.stringify(v), fn: a.fn, model: a.model, errors: errors };
        }
      }
      errors.push(a.fn + '/' + a.model + ': empty response');
    } catch (e) {
      errors.push(a.fn + '/' + a.model + ': ' + String((e && e.message) || e).substring(0, 200));
    }
  }
  return { text: null, fn: null, model: null, errors: errors };
}
// Completion + JSON parse, retried once. Returns {obj, fn, model, attempts, errors}.
function pipCompleteJson(prompt) {
  var errors = [];
  var p = prompt;
  for (var k = 1; k <= 2; k++) {
    var r = pipComplete(p);
    errors = errors.concat(r.errors);
    // every function/model failed: walking the whole chain again cannot help (the retry is for bad JSON)
    if (r.text === null) { break; }
    if (r.text !== null) {
      var obj = pipExtractJson(r.text);
      if (obj) { return { obj: obj, fn: r.fn, model: r.model, attempts: k, errors: errors }; }
      errors.push('attempt ' + k + ': ' + r.model + ' did not return parseable JSON');
    }
    p = prompt + '\n\nIMPORTANT: your previous reply was not valid JSON. Reply with ONLY the JSON object, starting with { and ending with }.';
  }
  return { obj: null, fn: null, model: null, attempts: 2, errors: errors };
}

// ----- rows -----------------------------------------------------------------------
var PIP_TASK_COLS = ['TASK_ID', 'STUDENT_ID', 'CAPTURE_ID', 'RAW_TEXT', 'NORMALIZED_TEXT', 'CATEGORY', 'DUE_S',
  'MONEY', 'EST', 'STATUS', 'DEFERS', 'CREATED_S'];
var PIP_TASK_SELECT = 'SELECT task_id AS TASK_ID, student_id AS STUDENT_ID, capture_id AS CAPTURE_ID, ' +
  'raw_text AS RAW_TEXT, normalized_text AS NORMALIZED_TEXT, category AS CATEGORY, ' +
  'TO_VARCHAR(due_at, ' + PIP_TS_FMT + ') AS DUE_S, money_at_risk::FLOAT AS MONEY, est_minutes::FLOAT AS EST, ' +
  'status AS STATUS, defer_count::FLOAT AS DEFERS, TO_VARCHAR(created_at, ' + PIP_TS_FMT + ') AS CREATED_S ' +
  'FROM PIP.APP.TASKS ';
// Task (types.ts) from a PIP_TASK_SELECT row
function pipTaskJson(r) {
  return {
    task_id: String(r.TASK_ID),
    student_id: String(r.STUDENT_ID),
    capture_id: pipIsNil(r.CAPTURE_ID) ? null : String(r.CAPTURE_ID),
    raw_text: pipStr(r.RAW_TEXT),
    normalized_text: pipStr(r.NORMALIZED_TEXT),
    category: pipStr(r.CATEGORY),
    due_at: pipIsNil(r.DUE_S) ? null : String(r.DUE_S),
    money_at_risk: pipNum(r.MONEY),
    est_minutes: pipNum(r.EST),
    status: pipStr(r.STATUS),
    defer_count: pipNum(r.DEFERS) || 0,
    created_at: pipStr(r.CREATED_S)
  };
}
function pipLoadTask(taskId) {
  var rows = pipRows(PIP_TASK_SELECT + 'WHERE task_id = ?', [taskId], PIP_TASK_COLS);
  return rows.length ? pipTaskJson(rows[0]) : null;
}
