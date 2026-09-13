const $ = (id) => document.getElementById(id);
let base = 'http://localhost:3000', plan = null, blocks = [], busy = false, muted = true, snowflakeConnected = false, journal = [];
let recorder, stream, recordingBlob, timer;
const student = 'demo';
function el(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
function tab(name) { document.querySelectorAll('.page').forEach(n => n.hidden = n.id !== name); document.querySelectorAll('[data-tab]').forEach(n => { n.removeAttribute('aria-current'); if (n.dataset.tab === name) n.setAttribute('aria-current', 'page'); }); }
document.querySelectorAll('[data-tab]').forEach(n => n.addEventListener('click', () => { tab(n.dataset.tab); if (n.dataset.tab === 'history') run(loadHistory); }));
async function api(path, body, method = 'POST') {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : method, headers: body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify({ student_id: student, ...body }), signal: AbortSignal.timeout(120000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function run(fn) { if (busy) { notice('Pip is still finishing the last request.'); return; } busy = true; document.body.classList.add('busy'); notice(); document.querySelectorAll('button').forEach(b => b.disabled = true); try { await fn(); } catch (e) { notice(e instanceof TypeError ? 'Cannot reach Pip. Keep npm run dev running in your API Terminal, then press Refresh.' : e.message); } finally { busy = false; document.body.classList.remove('busy'); document.querySelectorAll('button').forEach(b => b.disabled = false); } }
function source(s) { $('source').textContent = s === 'snowflake' ? 'Snowflake connected' : snowflakeConnected ? 'Snowflake connected · fallback used' : 'Local fallback'; }
async function remember(prompt, data) {
 if (!data?.plan?.plan_id) return;
 journal = journal.filter(entry => entry.plan_id !== data.plan.plan_id);
 journal.unshift({plan_id:data.plan.plan_id, created_at:data.plan.created_at || new Date().toISOString(), prompt:prompt || data.transcript || data.plan.reasoning?.context?.question || null, response:data.plan.do_now?.action || data.plan.reasoning?.summary || 'Plan updated', title:data.plan.do_now?.title || 'Plan updated', source:data.source});
 journal = journal.slice(0, 50); await chrome.storage.local.set({journal});
}
function speak(text) { if (muted || !('speechSynthesis' in window)) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = .95; speechSynthesis.speak(u); }
function card(item, lead = false) {
 const c = el('article', null, `card ${lead ? 'lead' : ''} ${item.kind === 'fixed_block' ? 'fixed' : ''}`);
 c.append(el('small', lead ? 'DO THIS NOW' : item.kind === 'fixed_block' ? 'FIXED COMMITMENT' : item.category?.toUpperCase() || 'YOUR DAY'), el('h2', item.title), el('p', item.action), el('p', item.why, 'why'));
 if (item.starts_at) c.append(el('small', new Date(item.starts_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})));
 if (item.evidence?.length) { const d = el('details'); d.append(el('summary', 'Why this step?')); item.evidence.filter(x => x.fired).forEach(x => d.append(el('p', x.detail))); c.append(d); }
 if (lead && item.task_id) { const actions = el('div', null, 'actions'); for (const [kind, label] of [['start_now','Start now'],['done','Done'],['defer','Later']]) { const b = el('button', label, kind === 'start_now' ? 'primary' : 'secondary'); b.addEventListener('click', () => run(async () => { const result = await api('/actions', { plan_id: plan.plan_id, task_id: item.task_id, kind }); source(result.source); if (kind !== 'start_now') await rerank({}); await loadHistory(); notice(`${label} recorded in History.`); })); actions.append(b); } c.append(actions); }
 return c;
}
function renderPlan() {
 const container = $('plan'); container.replaceChildren(); $('followup').hidden = !plan;
 if (!plan) { container.append(el('p', 'Tell Pip about your day to find your next step.', 'empty')); return; }
 if (plan.reasoning?.free_window?.label) $('context').textContent = plan.reasoning.free_window.label;
 if (plan.do_now) container.append(card(plan.do_now, true)); else container.append(el('p', 'Nothing urgent right now. Take a breath.', 'empty'));
 for (const [title, items] of [['Next', plan.next ? [plan.next] : []], ['Today', plan.today || []], ['Can wait', plan.can_wait || []]]) { if (items.length) { container.append(el('h2', title)); items.forEach(i => container.append(card(i))); } }
 if (plan.reasoning?.answer) container.append(el('p', plan.reasoning.answer));
 for (const w of plan.reasoning?.warnings || []) container.append(el('p', w.text, 'context'));
}
async function accept(data, prompt = null) { source(data.source); if (data.needs_text) { notice('Pip could not transcribe this recording. Type your thoughts above and try again.'); return; } plan = data.plan; await Promise.all([chrome.storage.session.set({ plan, source: data.source }), remember(prompt, data)]); renderPlan(); tab('today'); if (data.diff?.headline) notice(data.diff.headline); if (plan?.do_now) speak(`${plan.do_now.action}. ${plan.do_now.why}`); }
async function rerank(context) { if (!plan) return; await accept(await api('/plans/rerank', {plan_id: plan.plan_id, context}), context.question || (context.available_minutes != null ? `${context.available_minutes} minutes available` : 'Plan updated')); }
$('capture').addEventListener('submit', e => { e.preventDefault(); run(async () => { const text = $('thought').value.trim(); await accept(await api('/captures/text', {text}), text); $('thought').value = ''; }); });
$('followup').addEventListener('submit', e => { e.preventDefault(); run(async () => { const question = $('question').value.trim(); await rerank({question}); $('question').value = ''; }); });
$('minutes').onclick = () => run(() => rerank({available_minutes:25}));
$('longer').onclick = () => run(() => rerank({available_minutes:Math.max(0, (plan?.reasoning?.effective_minutes || 0) - 10)}));
$('example').onclick = () => { $('thought').value = 'I have a 2 PM lab. I need to return headphones by 5 PM or lose the refund. My assignment is due tomorrow. I need groceries, and I have $35 until Friday. What should I do?'; $('thought').focus(); };
$('scan').onclick = () => run(async () => {
 const [current] = await chrome.tabs.query({active:true, currentWindow:true});
 if (!current?.id) throw new Error('Open the course page you want Pip to scan, then try again.');
 const url = current.url || '';
 if (!/^https?:/i.test(url)) throw new Error('Chrome does not allow extensions to scan this page. Open a normal course website or document tab.');
 const [{result}] = await chrome.scripting.executeScript({target:{tabId:current.id}, func:globalThis.extractPipPageContext});
 if (!result?.text) throw new Error('Pip could not find readable text on this tab.');
 const prompt = `Course page: ${result.title}\nFind every actionable course task, due date, exam, class time, and deadline in the page excerpt below. Add them to my tasks and rank what matters now. Do not invent dates that are not shown.\n\n${result.text}`;
 $('record-state').textContent = `Found ${result.matchedLines || 'relevant'} course lines · sending to Pip`;
 await accept(await api('/captures/text', {text:prompt}), `Scanned tab: ${result.title}`);
 notice(`Scanned “${result.title}” and added its dated work to your plan.`);
});
$('mute').onclick = async () => { muted = !muted; $('mute').textContent = muted ? 'Sound off' : 'Sound on'; $('mute').setAttribute('aria-label', muted ? 'Enable spoken recommendations' : 'Mute spoken recommendations'); if (muted) speechSynthesis.cancel(); await chrome.storage.local.set({muted}); };
async function loadHistory() {
 const target = $('entries'); target.replaceChildren();
 let remote = [];
 try { const data = await api('/history?student_id=demo'); source(data.source); remote = data.entries || []; }
 catch (error) { if (!journal.length) throw error; notice('Showing saved conversations while Snowflake reconnects.'); }
 const byId = new Map(remote.map(entry => [entry.plan_id, entry]));
 for (const local of journal) if (!byId.has(local.plan_id)) byId.set(local.plan_id, local);
 const entries = [...byId.values()].sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
 if (!entries.length) { target.append(el('p', 'Your prompts and next steps will show up here.', 'empty')); return; }
 entries.forEach(entry => {
   const local = journal.find(item => item.plan_id === entry.plan_id);
   const prompt = entry.transcript || entry.context?.question || local?.prompt;
   const title = entry.do_now_title || local?.title || 'A moment of clarity';
   const response = local?.response || entry.changed || 'Plan saved';
   const c = el('article', null, 'card');
   c.append(el('small', new Date(entry.created_at).toLocaleString()));
   if (prompt) c.append(el('p', `You: ${prompt}`, 'prompt'));
   c.append(el('h2', title), el('p', `Pip: ${response}`));
   if (entry.context?.available_minutes != null) c.append(el('p', `${entry.context.available_minutes} minutes available`));
   (entry.actions || []).forEach(a => c.append(el('p', `${a.kind.replaceAll('_',' ')} · ${a.task_title || 'Step'}`)));
   target.append(c);
 });
}
function renderBlocks() { const target = $('blocks'); target.replaceChildren(); const days = ['','Mon','Tue','Wed','Thu','Fri','Sat','Sun']; if (!blocks.length) target.append(el('p', 'Add your fixed classes to make room for everything else.', 'empty')); [...blocks].sort((a,b) => a.day_of_week-b.day_of_week || a.starts_at.localeCompare(b.starts_at)).forEach(b => { const c = el('article', null, 'card fixed'); c.append(el('small', `${days[b.day_of_week]} · ${b.starts_at}–${b.ends_at}`), el('h2', b.title)); target.append(c); }); }
async function connect() { $('source').textContent = 'Connecting…'; try { const health = await api('/health?refresh=1'); snowflakeConnected = health.snowflake?.connected === true; source(health.source); const [schedule, profile, today] = await Promise.all([api('/timetable?student_id=demo'),api('/profile?student_id=demo'),api('/timetable/today?student_id=demo')]); blocks = schedule.blocks; renderBlocks(); $('cash').value = profile.profile.cash_available; $('until').value = profile.profile.budget_until || ''; if (today.next_free_window?.label) $('context').textContent = today.next_free_window.label; await loadHistory(); } catch (e) { snowflakeConnected = false; $('source').textContent = 'API offline'; throw e; } }
$('refresh').onclick = () => run(connect);
$('refresh-history').onclick = () => run(loadHistory);
$('add-block').onsubmit = e => { e.preventDefault(); run(async () => { const f = new FormData(e.target); if (f.get('end') <= f.get('start')) throw new Error('End time must be after start time.'); const fresh = await api('/timetable?student_id=demo'); const data = await api('/timetable',{blocks:[...fresh.blocks,{day_of_week:Number(f.get('day')),title:f.get('title'),starts_at:f.get('start'),ends_at:f.get('end'),location:null}]},'PUT'); blocks=data.blocks; renderBlocks(); e.target.reset(); notice('Class saved. Update your plan to include the new schedule.'); }); };
$('profile').onsubmit = e => { e.preventDefault(); run(async () => { await api('/profile',{cash_available:Number($('cash').value),budget_until:$('until').value || null},'PUT'); notice('Budget saved. Update your plan to use it.'); }); };
$('settings').onsubmit = e => { e.preventDefault(); run(async () => { const u = new URL($('address').value); if (u.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(u.hostname) || u.username || u.password) throw new Error('Use an HTTP localhost or 127.0.0.1 address, without credentials.'); base = u.origin; plan = null; await chrome.storage.session.remove(['plan','source']); await chrome.storage.local.set({base}); renderPlan(); await connect(); }); };
$('record').onclick = async () => {
 if (recorder?.state === 'recording') { recorder.stop(); return; }
 try { const mime = ['audio/webm;codecs=opus','audio/webm','audio/mp4;codecs=mp4a.40.2','audio/mp4'].find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)); if (!mime) throw new Error('This Chrome version cannot record supported audio. Please use typed input.'); stream = await navigator.mediaDevices.getUserMedia({audio:true}); const chunks=[]; recorder = new MediaRecorder(stream,{mimeType:mime}); recorder.ondataavailable = e => { if(e.data.size) chunks.push(e.data); }; recorder.onstop = () => { clearTimeout(timer); stream.getTracks().forEach(t=>t.stop()); document.body.classList.remove('listening'); $('record').textContent='● Record voice'; $('record-state').textContent='Review before sending'; recordingBlob=new Blob(chunks,{type:mime}); if ($('audio').src) URL.revokeObjectURL($('audio').src); $('audio').src=URL.createObjectURL(recordingBlob); $('audio').hidden=false; $('send-audio').hidden=false; }; recorder.start(); $('record').textContent='■ Stop recording'; $('record-state').textContent='Listening · up to 60 seconds'; document.body.classList.add('listening'); timer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},60000); } catch(e) { stream?.getTracks().forEach(t=>t.stop()); notice(`${e.message} You can always type your thoughts.`); }
};
$('send-audio').onclick=()=>run(async()=>{if(!recordingBlob)return; const f=new FormData();const extension=recordingBlob.type.includes('webm')?'webm':'m4a';f.append('student_id',student);f.append('audio',recordingBlob,`capture.${extension}`); await accept(await api('/captures/voice',f),'Voice note');});
window.addEventListener('pagehide',()=>{clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());speechSynthesis.cancel();});
const saved=await chrome.storage.local.get(['base','muted','journal']); if(saved.base)base=saved.base; muted=saved.muted!==false; journal=Array.isArray(saved.journal)?saved.journal:[]; $('mute').textContent=muted?'Sound off':'Sound on'; $('address').value=base;
const session=await chrome.storage.session.get(['plan','source']); plan=session.plan||null; renderPlan(); await run(connect);
