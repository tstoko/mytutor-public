const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup({outgoing=false,draft='',subject='Maths',recipient='Example Parent',stopped=false}={}) {
  const visible=extra=>({getClientRects:()=>[{}],...extra});
  let sends=0;
  const messages=outgoing?[{}]:[];
  const fields=[{innerText:'Subject',nextElementSibling:{innerText:subject}},{innerText:'Level',nextElementSibling:{innerText:'A Level'}}];
  const history=visible({querySelectorAll:selector=>selector==='dt'?fields:messages,querySelector:()=>messages[0]});
  class Area {constructor(){this._value=draft;}get value(){return this._value;}set value(v){this._value=v;}getClientRects(){return [{}];}dispatchEvent(){}}
  const input=new Area();
  const button=visible({innerText:'Send',disabled:false,click(){sends++;messages.push({querySelector:selector=>({innerText:selector==='.message__body'?input.value:'Delivered'})});}});
  const elements={'chathistory:chatmessages':history,'tutorcardForm':{innerText:recipient+' Suggest a booking'},'chatreplyform:replyinput':input,'chatreplyform:send':button};
  const context=vm.createContext({chrome:{storage:{local:{get:async()=>({resume_requested:!stopped})}}},document:{getElementById:id=>elements[id],querySelectorAll:()=>[visible({innerText:'ACCOUNT_NAME'})],body:{innerText:'Safe chat'}},location:{href:'https://www.mytutor.co.uk/tutors/secure/chat.html?id=123'},HTMLTextAreaElement:Area,Event:class{},Date,Promise,setTimeout,Error});
  vm.runInContext(fs.readFileSync(__dirname+'/extension/actions.js','utf8'),context);
  return {context,run:()=>vm.runInContext(`continueIntroduction({recipient:'Example Parent',subject:'Mathematics',level:'A-level',message:'Hi Example, factual introduction.'})`,context),sends:()=>sends};
}
test('verified composer sends once and returns exact delivery evidence',async()=>{const x=setup();const result=await x.run();assert.equal(result.status,'completed');assert.equal(result.evidence.delivery,'Delivered');assert.equal(x.sends(),1);});
test('existing outgoing message prevents duplicate send',async()=>{const x=setup({outgoing:true});assert.equal((await x.run()).status,'not_performed');assert.equal(x.sends(),0);});
test('existing draft is preserved and prevents submission',async()=>{const x=setup({draft:'User draft'});assert.equal((await x.run()).status,'needs_review');assert.equal(x.sends(),0);});
test('recipient or subject mismatch never submits',async()=>{for(const options of [{recipient:'Someone Else'},{subject:'Physics'}]){const x=setup(options);assert.equal((await x.run()).status,'needs_review');assert.equal(x.sends(),0);}});

test('stopping revokes permission before final Send',async()=>{const x=setup({stopped:true});assert.equal((await x.run()).status,'needs_review');assert.equal(x.sends(),0);});

function inlineSetup({draft='',subject='Mathematics',proof=true,stopped=false}={}) {
 const visible=extra=>({getClientRects:()=>[{}],...extra});
 let sends=0,keyups=0;
 const details={heading:'Mathematics A Level - Example Parent (Parent)',card_text:'Mathematics A Level - Example Parent (Parent) Please help Send a replyDecline',subject:'Mathematics',level:'A-level',recipient:'Example Parent',message:'Hi Example, factual introduction.'};
 const panel={querySelectorAll:()=>[heading]},card={innerText:details.card_text,parentElement:panel};
 const heading={innerText:details.heading,parentElement:card};
 let modalShown=true;
 const modal=visible({querySelector:()=>({innerText:'Introduce yourself'}),querySelectorAll:()=>[{innerText:subject},{innerText:'A Level'}]});
 class Area {constructor(){this._value=draft;}get value(){return this._value;}set value(v){this._value=v;}getClientRects(){return [{}];}dispatchEvent(event){if(event.type==='keyup')keyups++;}}
 modal.getClientRects=()=>modalShown?[{}]:[];
 const input=new Area(),button=visible({disabled:false,innerText:'Send message',click(){sends++;modalShown=false;}});
 const elements={'marketplaceTabs:tutorRequestsForm:tutorRequestsPanel':panel,'acceptTutorRequestModal':modal,'acceptTutorRequestForm:personalMessage:input':input,'acceptTutorRequestForm:replyToMarketplaceRequest':button};
 class E {constructor(type){this.type=type;}}
 const context=vm.createContext({document:{getElementById:id=>elements[id],querySelectorAll:()=>[visible({innerText:'ACCOUNT_NAME'})],body:{innerText:'Safe requests'}},location:{href:'https://www.mytutor.co.uk/tutors/secure/marketplace.html'},chrome:{storage:{local:{get:async()=>({resume_requested:!stopped})}}},HTMLTextAreaElement:Area,KeyboardEvent:E,Event:E,Date,Number,Promise,setTimeout,Error});
 vm.runInContext(fs.readFileSync(__dirname+'/extension/actions.js','utf8'),context);
 context.testDetails=details;context.testProof=proof?{active_checked:true,archived_checked:true,checked_at:new Date().toISOString()}:{};
 return {run:()=>vm.runInContext('sendInlineIntroduction(testDetails,testProof)',context),sends:()=>sends,keyups:()=>keyups,input};
}
test('actual inline form triggers keyup validation and submits once',async()=>{const x=inlineSetup();assert.equal((await x.run()).stage,'submitted');assert.equal(x.sends(),1);assert.equal(x.keyups(),1);});
test('inline form preserves an existing draft',async()=>{const x=inlineSetup({draft:'User draft'});assert.equal((await x.run()).status,'needs_review');assert.equal(x.input.value,'User draft');assert.equal(x.sends(),0);});
test('inline form refuses missing duplicate proof, wrong subject, or Stop',async()=>{for(const options of [{proof:false},{subject:'Physics'},{stopped:true}]){const x=inlineSetup(options);assert.equal((await x.run()).status,'needs_review');assert.equal(x.sends(),0);}});

function listSetup(handlers) {
 const visible=extra=>({getClientRects:()=>[{}],...extra});
 let clicks=0;
 const row={click(){clicks++;},querySelectorAll:s=>s==='td'?[{}, {innerText:'Example Parent'}]:handlers.map(value=>({getAttribute:()=>value}))};
 const table={querySelectorAll:()=>[row]};
 const links=['Active chats','Archived'].map((innerText,i)=>({innerText,href:'https://www.mytutor.co.uk/tutors/secure/messages.html'+(i?'?archived=true':'')}));
 const context=vm.createContext({document:{getElementById:id=>id.endsWith('_data')?table:null,querySelectorAll:s=>s==='nav *'?[visible({innerText:'ACCOUNT_NAME'})]:s==='a'?links:[],body:{innerText:'Messages'}},location:{href:links[0].href,search:''},URL,Error,Set});
 vm.runInContext(fs.readFileSync(__dirname+'/extension/actions.js','utf8'),context);
 return {run:()=>vm.runInContext('inspectMessageList({recipient:"Example Parent"},true)',context),clicks:()=>clicks};
}
test('real inner-div navigation is extracted without clicking inert row',async()=>{
 const x=listSetup(["location.href='/tutors/secure/chat.html?id=1234567'","location.href='/tutors/secure/chat.html?id=1234567'"]);
 const r=await x.run();assert.equal(r.stage,'located');assert.equal(r.conversation_url,'https://www.mytutor.co.uk/tutors/secure/chat.html?id=1234567');assert.equal(x.clicks(),0);
});
test('unknown, external or conflicting navigation handlers are rejected',async()=>{
 for(const handlers of [[],["location.href='https://evil.example'"],["arbitrary()"],["location.href='/tutors/secure/chat.html?id=1'","location.href='/tutors/secure/chat.html?id=2'"]])await assert.rejects(listSetup(handlers).run(),/navigation control not verified/);
});
test('existing outgoing blocks duplicates even without matching student metadata',async()=>{
 const x=setup({outgoing:true,subject:'Older conversation'});
 const r=await vm.runInContext('inspectConversation({recipient:"Example Parent",subject:"Mathematics",level:"A-level"},"duplicate")',x.context);
 assert.equal(r.outgoing_count,1);assert.equal(x.sends(),0);
 await assert.rejects(vm.runInContext('inspectConversation({recipient:"Example Parent",subject:"Mathematics",level:"A-level"})',x.context),/subject\/level mismatch/);
});
