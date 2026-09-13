const fs=require('fs');const assert=require('node:assert/strict');
const run=Date.now();const results=[];fs.mkdirSync('tmp',{recursive:true});
const cases=[
 ['academic','I need to finish my biology essay by tomorrow at 9 AM; it takes 50 minutes. I need to email my professor tonight; it takes 5 minutes. I want to organize my bookshelf this weekend; it takes 40 minutes.',/email|professor/i],
 ['errands','I must renew my parking permit by 11 PM today or pay a $120 fine; it takes 10 minutes. I need to buy printer paper tomorrow; it takes 20 minutes. I want to call my cousin this weekend; it takes 30 minutes.',/parking|permit/i],
 ['work','I must send the client proposal by tomorrow at noon; it takes 45 minutes. I need to book a vet appointment tomorrow; it takes 10 minutes. I want to practice guitar for 20 minutes this weekend.',/proposal/i],
 ['empty','Hello, how are you?',null]
];
(async()=>{
for(const [name,text,expected] of cases){
const student='audit-'+run+'-'+name;
const r=await fetch('http://localhost:3000/captures/text',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({student_id:student,text})});const d=await r.json();
fs.writeFileSync('tmp/audit-'+name+'.json',JSON.stringify(d,null,2));
const out={name,student,status:r.status,source:d.source,model:d.plan?.model,tasks:d.tasks?.map(t=>t.normalized_text),top:d.plan?.do_now?.title,pipeline:d.pipeline?.map(p=>({stage:p.stage,engine:p.engine,status:p.status})),errors:[]};
try{assert.equal(r.status,200);assert.equal(d.source,'snowflake');assert.doesNotMatch(JSON.stringify(d.tasks),/headphone|CHEM 110|CS 101|demo-/i);if(expected){assert.match(d.plan.do_now.title,expected);assert.ok(d.tasks.length>=3);}else{assert.equal(d.tasks.length,0);assert.equal(d.plan.do_now,null);}const ids=new Set(d.tasks.map(t=>t.task_id));for(const item of [d.plan.do_now,d.plan.next,...d.plan.today,...d.plan.can_wait].filter(Boolean)){if(item.task_id)assert.ok(ids.has(item.task_id),'unknown planned task');}}catch(e){out.errors.push(e.message);process.exitCode=1;}
results.push(out);console.log(JSON.stringify(out));
}
const work=JSON.parse(fs.readFileSync('tmp/audit-work.json'));
const response=await fetch('http://localhost:3000/captures/text',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({student_id:work.plan.student_id,followup_plan_id:work.plan.plan_id,text:'I also need to pay the electricity bill by 10 PM tonight or lose $80 in late fees; it takes 5 minutes.'})});
const follow=await response.json();fs.writeFileSync('tmp/audit-followup.json',JSON.stringify(follow,null,2));
const outcome={name:'followup',source:follow.source,top:follow.plan?.do_now?.title,tasks:follow.tasks?.map(t=>t.normalized_text),errors:[]};
try{assert.equal(response.status,200);assert.equal(follow.source,'snowflake');assert.match(JSON.stringify(follow.tasks),/electricity/i);assert.match(JSON.stringify(follow.tasks),/proposal/i);assert.match(follow.plan.do_now.title,/electricity/i);assert.equal(follow.previous_plan_id,work.plan.plan_id);}catch(e){outcome.errors.push(e.message);process.exitCode=1;}
results.push(outcome);console.log(JSON.stringify(outcome));
fs.writeFileSync('tmp/brain-dump-audit.json',JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});

