// ---------------------------------------------------------------------------
// RECORD_ACTION(STUDENT_ID, PLAN_ID, TASK_ID, KIND) RETURNS VARIANT
// Returns an Action (types.ts) and applies the task status change:
//   done -> 'done' | defer -> 'deferred' and defer_count + 1 | drop -> 'dropped' | start_now -> no change
// Invalid input returns {error}.
// ---------------------------------------------------------------------------
function pipRecordActionMain(studentId, planId, taskId, kind) {
  var k = pipTrim(kind);
  if (!pipIn(['start_now', 'done', 'defer', 'drop'], k)) {
    return { error: 'invalid kind: ' + pipStr(kind) };
  }
  var sid = pipTrim(studentId);
  var pid = pipTrim(planId);
  if (!sid || !pid) {
    return { error: 'student_id and plan_id are required' };
  }
  var tid = pipTrim(taskId);
  var actionId = pipUuid();
  var created = pipNowLocal();
  pipExec('INSERT INTO PIP.APP.ACTIONS (action_id, student_id, plan_id, task_id, kind, created_at) ' +
    "SELECT ?, ?, ?, NULLIF(?, ''), ?, TO_TIMESTAMP_NTZ(?, " + PIP_TS_FMT + ')',
    [actionId, sid, pid, tid, k, created]);
  if (tid) {
    if (k === 'done') {
      pipExec("UPDATE PIP.APP.TASKS SET status = 'done' WHERE task_id = ? AND student_id = ?", [tid, sid]);
    } else if (k === 'defer') {
      pipExec("UPDATE PIP.APP.TASKS SET status = 'deferred', defer_count = COALESCE(defer_count, 0) + 1 WHERE task_id = ? AND student_id = ?", [tid, sid]);
    } else if (k === 'drop') {
      pipExec("UPDATE PIP.APP.TASKS SET status = 'dropped' WHERE task_id = ? AND student_id = ?", [tid, sid]);
    }
  }
  return {
    action_id: actionId,
    student_id: sid,
    plan_id: pid,
    task_id: tid ? tid : null,
    kind: k,
    created_at: created
  };
}

try {
  return pipRecordActionMain(STUDENT_ID, PLAN_ID, TASK_ID, KIND);
} catch (err) {
  return { error: String((err && err.message) || err) };
}
