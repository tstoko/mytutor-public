// Fully local DOM/native-protocol simulation. No browser, network, credentials,
// installed runtime or real MyTutor messages are accessible to these VM contexts.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const MARKET='https://www.mytutor.co.uk/tutors/secure/marketplace.html';
const LIST='https://www.mytutor.co.uk/tutors/secure/messages.html';
const CHAT='https://www.mytutor.co.uk/tutors/secure/chat.html?id=123';
const actionCode=fs.readFileSync(__dirname+'/extension/actions.js','utf8');
const backgroundCode=fs.readFileSync(__dirname+'/extension/background.js','utf8');
const details={heading:'Economics A Level - Alice M. (Parent)',card_text:'Economics A Level - Alice M. (Parent) Please help Send a replyDecline',subject:'Economics',level:'A-level',recipient:'Alice M.',message:'Hi Alice, this is an offline simulated introduction.'};

function sandbox({confirmationFails=false,restoreFails=false,newTab=false}={}) {
 let nextId=100,sends=0,continues=0,scans=0;
 const tabs=new Map([[42,{id:42,url:MARKET,status:'complete'}]]),sent=[],records=[],created=[];
 const storage={resume_requested:true};
 const visible=extra=>({getClientRects:()=>[{}],...extra});
 const port={postMessage:value=>{sent.push(value);if(value.type==='introduction_result')records.push(value);}};
 const chrome={
  storage:{local:{get:async()=>storage,set:async value=>Object.assign(storage,value)}},
  notifications:{create:async()=>{}},runtime:{onMessage:{addListener(){}},onStartup:{addListener(){}}},
  tabs:{
   onCreated:{addListener:f=>created.push(f),removeListener:f=>created.splice(created.indexOf(f),1)},
   get:async id=>({...tabs.get(id)}),
   create:async({url})=>{const t={id:nextId++,url,status:'complete'};tabs.set(t.id,t);return t;},
   update:async(id,{url})=>{if(restoreFails&&id===42&&url===MARKET)throw Error('Simulated return navigation failure');tabs.get(id).url=url;return tabs.get(id);},
   remove:async id=>tabs.delete(id)
  }
 };
 function page(id) {
  const tab=tabs.get(id);let modal=false,inline=false;
  const input= new (class Area {constructor(){this._value='';}get value(){return this._value;}set value(v){this._value=v;}getClientRects(){return inline?[{}]:[];}dispatchEvent(){}})();
  const reply=visible({innerText:'Send a reply',click(){modal=true;}});
  const panel={querySelectorAll:()=>[heading]};
  const card={innerText:details.card_text,parentElement:panel,querySelectorAll:()=>[reply]};
  const heading=visible({innerText:details.heading,parentElement:card,querySelectorAll:()=>[]});
  const dialog={innerText:'Introduce yourself',getClientRects:()=>modal?[{}]:[],querySelector:()=>({innerText:'Introduce yourself'}),querySelectorAll:s=>s==='header li'?[{innerText:'Economics'},{innerText:'A Level'}]:[]};
  const next=visible({innerText:'Continue',disabled:false,click(){continues++;modal=true;inline=true;}});
  const send=visible({innerText:'Send message',disabled:false,click(){
   sends++;assert.equal(input.value,details.message);modal=false;
   if(newTab){const t={id:nextId++,openerTabId:42,url:CHAT,status:'complete'};tabs.set(t.id,t);created.forEach(f=>f(t));}
   else tab.url=CHAT;
  }});
  const fields=[{innerText:'Subject',nextElementSibling:{innerText:'Economics'}},{innerText:'Level',nextElementSibling:{innerText:'A Level'}}];
  const history=visible({querySelectorAll:s=>s==='dt'?fields:(sends?[{querySelector:selector=>({innerText:selector==='.message__body'?details.message:'Delivered'})}]:[])});
  const row={querySelectorAll:s=>s==='td'?[{}, {innerText:'Alice Parent'}]:[{getAttribute:()=>"location.href='/tutors/secure/chat.html?id=123'"}]};
  const links=[{innerText:'Active chats',href:LIST},{innerText:'Archived',href:LIST+'?archived=true'}];
  const elements={
   'marketplaceTabs:tutorRequestsForm:tutorRequestsPanel':panel,
   'acceptTutorRequestModal':dialog,'acceptTutorRequestForm:continue':next,
   'acceptTutorRequestForm:personalMessage:input':input,'acceptTutorRequestForm:replyToMarketplaceRequest':send,
   'chatsForCurrentUserForm:tutorMessagesTable_data':{querySelectorAll:()=>sends?[row]:[]},
   'tutorcardForm':{innerText:'Alice M. Suggest a booking'},'chathistory:chatmessages':history,
   'chatreplyform:replyinput':{value:''}
  };
  const document={body:{innerText:'Safe simulated MyTutor'},getElementById:key=>elements[key]||null,querySelector:()=>null,querySelectorAll:s=>s==='nav *'?[visible({innerText:'ACCOUNT_NAME'})]:s==='nav a'?[{innerText:'Messages',href:LIST}]:s==='a'?links:[]};
  const location={get href(){return tab.url;},get search(){return tab.url.endsWith('?archived=true')?'?archived=true':'';}};
  const context=vm.createContext({chrome,document,location,HTMLTextAreaElement:input.constructor,Event:class{},KeyboardEvent:class{},Date,Number,URL,Set,Promise,Error,setTimeout});
  vm.runInContext(actionCode,context);return context;
 }
 const pages=new Map();
 chrome.scripting={executeScript:async({target:{tabId},func,args=[]})=>{
  if(func.name==='readPanels'){scans++;return [{result:{account:'ACCOUNT_NAME',url:tabs.get(tabId).url,matching_team:{},tutor_requests:{}}}];}
  if(confirmationFails&&func.name==='inspectConversation')throw Error('Simulated confirmation unavailable');
  let p=pages.get(tabId);if(!p){p=page(tabId);pages.set(tabId,p);}
  // Actual shipped page functions execute against isolated fake DOMs.
  p.__args=args;
  if(func.name==='messageNavigation')return [{result:{url:LIST}}];
  return [{result:await vm.runInContext(`(${func.toString()})(...__args)`,p)}];
 }};
 const context=vm.createContext({chrome,Date,Error,Promise,Set,setTimeout,clearTimeout,importScripts(){}});
 vm.runInContext(actionCode,context);vm.runInContext(backgroundCode,context);
 // Reload/scan reader are simulated browser boundaries; all introduction,
 // duplicate inspection, Send and confirmation functions remain unmodified.
 context.reload=async id=>{assert.equal(tabs.get(id).url,MARKET);};
 context.testPort=port;context.details=details;
 vm.runInContext('port=testPort;enabled=true;selectedTab=42;',context);
 return {context,run:()=>vm.runInContext('introduce({action_id:"offline-test",details})',context),scan:()=>vm.runInContext('scan()',context),tabs,records,sends:()=>sends,continues:()=>continues,scans:()=>scans,sent};
}

for(const newTab of [false,true])test('offline unattended send → confirmation → Requests → next scan; new tab='+newTab,async()=>{
 const x=sandbox({newTab});await x.run();
 assert.equal(x.sends(),1);assert.equal(x.continues(),1);
 assert.equal(x.records[0].status,'completed');assert.equal(x.records[0].evidence.delivery,'Delivered');
 assert.equal(x.tabs.get(42).url,MARKET);assert.equal(vm.runInContext('busy',x.context),false);
 if(!newTab)assert.equal(x.records[0].evidence.requests_restored,true);
 await x.scan();assert.equal(x.sent.at(-1).type,'snapshot');assert.equal(x.sends(),1);
});
test('offline confirmation failure preserves uncertainty and never repeats Send',async()=>{
 const x=sandbox({confirmationFails:true});await x.run();assert.equal(x.sends(),1);assert.equal(x.records[0].status,'needs_review');assert.equal(x.tabs.get(42).url,CHAT);
});
test('offline return failure retains delivered outcome and records restoration blocker',async()=>{
 const x=sandbox({restoreFails:true});await x.run();assert.equal(x.sends(),1);assert.equal(x.records[0].status,'completed');assert.match(x.records[0].evidence.restore_error,/return navigation failure/);
});
