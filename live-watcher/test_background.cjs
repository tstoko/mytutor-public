const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

function setup() {
  const listeners = {message:[],disconnect:[]};
  const sent = [];
  const port = {onMessage:{addListener:f=>listeners.message.push(f)},onDisconnect:{addListener:f=>listeners.disconnect.push(f)},postMessage:v=>sent.push(v),disconnect(){}};
  const chrome = {
    runtime:{connectNative:()=>port,onMessage:{addListener(){}},onStartup:{addListener(){}},getURL:p=>'chrome-extension://test/'+p},
    storage:{local:{set:async()=>{},get:async()=>({})}},action:{setBadgeText:async()=>{}},
    tabs:{query:async()=>[{id:42}]}
  };
  const context = vm.createContext({chrome,setTimeout,clearTimeout,Date,Error,Promise,console,importScripts(){}});
  vm.runInContext(fs.readFileSync(__dirname+'/extension/background.js','utf8'),context);
  return {context,chrome,listeners,sent};
}

test('waits for native readiness before enabling or posting start',async()=>{
  const {context,listeners,sent}=setup();
  const started=vm.runInContext('start()',context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.length,0);
  await listeners.message[0]({type:'ready'});
  await started;
  assert.equal(sent[0].type,'start');assert.equal(sent[0].tab_id,42);
  await listeners.disconnect[0]();
});

test('startup disconnect reports original error rather than null postMessage',async()=>{
  const {context,chrome,listeners,sent}=setup();
  const started=vm.runInContext('start()',context);
  const rejected=assert.rejects(started,/Specified native messaging host not found/);
  await new Promise(resolve=>setImmediate(resolve));
  chrome.runtime.lastError={message:'Specified native messaging host not found'};
  await listeners.disconnect[0]();await rejected;
  assert.equal(sent.length,0);
});


test('same-tab reply navigation is recognised',async()=>{
 const {context,chrome}=setup();
 chrome.tabs.get=async id=>({id,url:'https://www.mytutor.co.uk/tutors/secure/chat.html?id=123',status:'complete'});
 assert.equal(await vm.runInContext('waitForConversation(42,new Set(),5)',context),42);
});
test('new reply tab is recognised only if action recorded it',async()=>{
 const {context,chrome}=setup();
 chrome.tabs.get=async id=>({id,url:id===43?'https://www.mytutor.co.uk/tutors/secure/chat.html?id=123':'https://www.mytutor.co.uk/tutors/secure/marketplace.html',status:'complete'});
 assert.equal(await vm.runInContext('waitForConversation(42,new Set([43]),5)',context),43);
 assert.equal(await vm.runInContext('waitForConversation(42,new Set(),1)',context),null);
});
test('ambiguous conversations fail before submission',async()=>{
 const {context,chrome}=setup();
 chrome.tabs.get=async id=>({id,url:'https://www.mytutor.co.uk/tutors/secure/chat.html?id='+id,status:'complete'});
 await assert.rejects(vm.runInContext('waitForConversation(42,new Set([43]),5)',context),/Multiple reply conversations/);
});

test('native stop clears enabled state so Start can work again',async()=>{
 const {context,listeners,sent}=setup();
 const started=vm.runInContext('start()',context);
 await new Promise(resolve=>setImmediate(resolve));
 await listeners.message[0]({type:'ready'});await started;
 await listeners.message[0]({type:'health',health:{status:'stopped',blocker:'Outcome uncertain'}});
 assert.equal(vm.runInContext('enabled',context),false);
 assert.equal(vm.runInContext('port',context),null);
 const restarted=vm.runInContext('start()',context);
 await new Promise(resolve=>setImmediate(resolve));
 await listeners.message[1]({type:'ready'});await restarted;
 assert.equal(sent.filter(x=>x.type==='start').length,2);
});

test('host stop disconnects native keepalive and preserves the original blocker',async()=>{
 const {context,chrome,listeners}=setup();let disconnects=0;const saved=[];
 chrome.storage.local.set=async value=>saved.push(value);
 const original=chrome.runtime.connectNative;
 chrome.runtime.connectNative=()=>{const port=original();port.disconnect=()=>disconnects++;return port;};
 const started=vm.runInContext('start()',context);
 await new Promise(resolve=>setImmediate(resolve));
 await listeners.message[0]({type:'ready'});await started;
 await listeners.message[0]({type:'health',health:{status:'stopped',blocker:'Inspect uncertain send'}});
 await listeners.disconnect[0]();
 assert.equal(disconnects,1);
 assert.equal(saved.filter(v=>v.health).at(-1).health.blocker,'Inspect uncertain send');
});

test('repeated scans update health without redrawing an unchanged badge',async()=>{
 const {context,chrome}=setup();const badges=[];let writes=0;
 chrome.action.setBadgeText=async value=>badges.push(value.text);
 chrome.storage.local.set=async()=>writes++;
 await vm.runInContext('health({status:"watching",scan_count:1});',context);
 await vm.runInContext('health({status:"watching",scan_count:2});',context);
 await vm.runInContext('health({status:"stopped"});',context);
 assert.deepEqual(badges,['ON','!']);assert.equal(writes,3);
});

test('disconnect during a pending stop storage write does not replace the blocker',async()=>{
 const {context,chrome,listeners}=setup();const saved=[];let release;
 const started=vm.runInContext('start()',context);
 await new Promise(resolve=>setImmediate(resolve));
 await listeners.message[0]({type:'ready'});await started;
 chrome.storage.local.set=value=>{
   saved.push(value);
   if(value.resume_requested===false)return new Promise(resolve=>release=resolve);
   return Promise.resolve();
 };
 const stopped=listeners.message[0]({type:'health',health:{status:'stopped',blocker:'Original stop reason'}});
 await listeners.disconnect[0]();release();await stopped;
 assert.equal(saved.filter(v=>v.health).at(-1).health.blocker,'Original stop reason');
});

test('original injection failure and live dialog diagnostics survive handoff timeout',async()=>{
 const {context,chrome,sent}=setup();
 chrome.tabs.onCreated={addListener(){},removeListener(){}};
 chrome.tabs.get=async id=>({id,url:'https://www.mytutor.co.uk/tutors/secure/marketplace.html',status:'complete'});
 chrome.notifications={create:async()=>{}};
 let calls=0;
 chrome.scripting={executeScript:async()=>{if(calls++===0)throw Error('simulated injection failure');return [{result:{url:'Requests',dialogs:['Reply dialog still open']}}];}};
 let stamp=0;context.Date={now:()=>stamp+=20000};
 await vm.runInContext("function performIntroduction(){}; function continueIntroduction(){}; checkDuplicates=async()=>({proof:{}}); port=chrome.runtime.connectNative('test');enabled=true;selectedTab=42;introduce({action_id:'test1',details:{recipient:'Alice'}})",context);
 const result=sent.find(x=>x.type==='introduction_result');
 assert.equal(result.status,'needs_review');
 assert.match(result.evidence.reason,/simulated injection failure/);
 assert.equal(result.evidence.diagnostic.dialogs[0],'Reply dialog still open');
});

test('inline preflight checks both active and archived lists before allowing send',async()=>{
 const {context,chrome}=setup();let archived=false;let inspected=[];
 chrome.tabs.create=async()=>({id:99});chrome.tabs.get=async()=>({id:99,url:archived?'archived':'active',status:'complete'});
 chrome.tabs.update=async(id,{url})=>{archived=url==='archived';};
 context.inspectMessageList=function inspectMessageList(){};context.messageNavigation=function messageNavigation(){};
 context.scriptResult=async(id,func)=>{if(func.name==='messageNavigation')return {url:'active'};inspected.push(archived);return {matches:0,archived,links:{'Active chats':'active',Archived:'archived'}};};
 const result=await vm.runInContext('selectedTab=42;checkDuplicates({recipient:"Alice"},{})',context);
 assert.deepEqual(inspected,[false,true]);assert.equal(result.proof.active_checked,true);assert.equal(result.proof.archived_checked,true);
});

test('an outgoing conversation causes an early skip before inline Send',async()=>{
 const {context,chrome}=setup();chrome.tabs.create=async()=>({id:99});
 context.inspectMessageList=function inspectMessageList(){};context.messageNavigation=function messageNavigation(){};context.inspectConversation=function inspectConversation(){};
 let calls=0;context.waitLoaded=async()=>({});context.waitForConversation=async()=>99;context.openListedConversation=async()=>99;
 context.scriptResult=async(id,func)=>{
   if(func.name==='messageNavigation')return {url:'active'};
   if(func.name==='inspectConversation')return {outgoing_count:1,conversation_url:'chat',draft_present:false};
   return calls++===0?{matches:1,archived:false,links:{'Active chats':'active',Archived:'archived'}}:{stage:'opened'};
 };
 const result=await vm.runInContext('selectedTab=42;checkDuplicates({recipient:"Alice"},{})',context);
 assert.equal(result.skip,true);assert.match(result.evidence.reason,/Existing outgoing/);
});

test('inline success requires exact message delivery in the resulting conversation',async()=>{
 const {context,chrome}=setup();chrome.tabs.update=async()=>{};
 context.inspectMessageList=function inspectMessageList(){};context.inspectConversation=function inspectConversation(){};context.waitLoaded=async()=>({});context.waitForConversation=async()=>99;context.openListedConversation=async()=>99;
 context.scriptResult=async(id,func)=>func.name==='inspectMessageList'?{stage:'opened'}:{sent_count:1,delivery:'Delivered',message:'exact',conversation_url:'https://www.mytutor.co.uk/tutors/secure/chat.html?id=123'};
 const result=await vm.runInContext('verifyInlineSend({message:"exact"},{id:99,activeUrl:"active"},{submitted_at:"observed"})',context);
 assert.equal(result.status,'completed');assert.equal(result.evidence.delivery,'Delivered');assert.equal(result.evidence.message,'exact');
});

for(const injectionFailure of [false,true]) test('inline navigation reconciles delivery and restores owned Requests; injection failure='+injectionFailure,async()=>{
 const {context,chrome,sent}=setup();let submits=0,restores=0;
 const chat='https://www.mytutor.co.uk/tutors/secure/chat.html?id=123';
 chrome.tabs.onCreated={addListener(){},removeListener(){}};
 chrome.tabs.get=async id=>({id,url:chat,status:'complete'});
 chrome.tabs.update=async(id,{url})=>{assert.equal(id,42);assert.match(url,/marketplace.html$/);restores++;};
 chrome.tabs.remove=async()=>{};chrome.notifications={create:async()=>{}};
 chrome.scripting={executeScript:async()=>[{result:{stage:'inline'}}]};
 context.sendInlineIntroduction=function sendInlineIntroduction(){};
 context.waitLoaded=async()=>{};
 context.scriptResult=async(id,func)=>{if(func.name==='readPanels')return {account:'ACCOUNT_NAME',url:'https://www.mytutor.co.uk/tutors/secure/marketplace.html'};submits++;if(injectionFailure)throw Error('Execution context destroyed');return {stage:'submitted',submitted:true};};
 context.verifyInlineSend=async()=>({status:'completed',evidence:{conversation_url:chat,sent_count:1,delivery:'Delivered'}});
 await vm.runInContext("function performIntroduction(){};checkDuplicates=async()=>({proof:{}});port=chrome.runtime.connectNative('test');enabled=true;selectedTab=42;introduce({action_id:'practice',details:{recipient:'Alice'}})",context);
 const result=sent.find(x=>x.type==='introduction_result');
 assert.equal(result.status,'completed');assert.equal(submits,1);assert.equal(restores,1);assert.equal(result.evidence.restore_error,undefined);
 if(injectionFailure)assert.match(result.evidence.submission_error,/context destroyed/);
});

test('inline failure before submission preserves page without verification or retry',async()=>{
 const {context,chrome,sent}=setup();let submits=0;
 chrome.tabs.onCreated={addListener(){},removeListener(){}};
 chrome.tabs.get=async id=>({id,url:'https://www.mytutor.co.uk/tutors/secure/marketplace.html',status:'complete'});
 chrome.scripting={executeScript:async()=>[{result:{stage:'inline'}}]};chrome.notifications={create:async()=>{}};
 context.sendInlineIntroduction=function sendInlineIntroduction(){};
 context.scriptResult=async()=>{submits++;return {status:'needs_review',evidence:{submitted:false,reason:'Existing draft'}};};
 context.verifyInlineSend=async()=>{throw Error('Must not reconcile before Send');};
 await vm.runInContext("function performIntroduction(){};checkDuplicates=async()=>({proof:{}});port=chrome.runtime.connectNative('test');enabled=true;selectedTab=42;introduce({action_id:'practice',details:{recipient:'Alice'}})",context);
 const result=sent.find(x=>x.type==='introduction_result');assert.equal(result.status,'needs_review');assert.equal(result.evidence.reason,'Existing draft');assert.equal(submits,1);
});

test('listed conversation uses exact observed URL and retries only read-only navigation',async()=>{
 const {context,chrome}=setup();let calls=0,updates=[];
 chrome.tabs.get=async()=>({url:'https://www.mytutor.co.uk/tutors/secure/messages.html'});
 chrome.tabs.update=async(id,{url})=>updates.push(url);
 context.inspectMessageList=function inspectMessageList(){};context.waitLoaded=async()=>{};
 context.scriptResult=async()=>{if(calls++===0)throw Error('Transient unloaded list');return {stage:'located',conversation_url:'https://www.mytutor.co.uk/tutors/secure/chat.html?id=1234567'};};
 assert.equal(await vm.runInContext('openListedConversation(99,{})',context),99);assert.equal(calls,2);assert.equal(updates.at(-1),'https://www.mytutor.co.uk/tutors/secure/chat.html?id=1234567');
});
test('delivery confirmation prefers actual post-send conversation over message-list lookup',async()=>{
 const {context}=setup();context.waitForConversation=async()=>42;
 context.inspectConversation=function inspectConversation(){};
 context.scriptResult=async(id)=>{assert.equal(id,42);return {sent_count:1,delivery:'Delivered',message:'exact'};};
 context.openListedConversation=async()=>{throw Error('List must not be used');};
 const r=await vm.runInContext('verifyInlineSend({}, {}, {},42,new Set())',context);assert.equal(r.status,'completed');
});
test('preflight failure records definitely not submitted and never enters send',async()=>{
 const {context,chrome,sent}=setup();chrome.tabs.onCreated={addListener(){},removeListener(){}};
 chrome.tabs.get=async()=>({url:'https://www.mytutor.co.uk/tutors/secure/marketplace.html'});
 await vm.runInContext("checkDuplicates=async()=>{throw Error('Navigation failed')};port=chrome.runtime.connectNative('test');enabled=true;selectedTab=42;introduce({action_id:'preflight',details:{}})",context);
 const r=sent.find(x=>x.type==='introduction_result');assert.equal(r.status,'not_performed');assert.equal(r.evidence.submitted,false);assert.equal(r.evidence.phase,'duplicate_check');
});

test('slow notification cannot block next scan or clear its operation lock',async()=>{
 const {context,chrome}=setup();let releaseNotification,releaseScan;
 chrome.tabs.onCreated={addListener(){},removeListener(){}};
 chrome.tabs.get=async()=>({url:'https://www.mytutor.co.uk/tutors/secure/marketplace.html'});
 chrome.notifications={create:()=>new Promise(r=>releaseNotification=r)};
 context.checkDuplicates=async()=>({proof:{}});
 context.performIntroduction=function performIntroduction(){};
 chrome.scripting={executeScript:async()=>[{result:{status:'completed',evidence:{delivery:'Delivered'}}}]};
 context.testPort={postMessage(){}};
 vm.runInContext('port=testPort;enabled=true;selectedTab=42;',context);
 const intro=vm.runInContext('introduce({action_id:"slow",details:{recipient:"Alice"}})',context);
 while(!releaseNotification)await new Promise(r=>setImmediate(r));
 assert.equal(vm.runInContext('busy',context),false);
 context.reload=()=>new Promise(r=>releaseScan=r);
 const scan=vm.runInContext('scan()',context);
 assert.equal(vm.runInContext('busy',context),true);
 releaseNotification();await intro;
 assert.equal(vm.runInContext('busy',context),true);
 releaseScan();await scan;assert.equal(vm.runInContext('busy',context),false);
});
