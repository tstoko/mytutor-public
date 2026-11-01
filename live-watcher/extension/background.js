importScripts('actions.js');
// The native-messaging connection keeps the MV3 worker alive. Its local helper
// schedules scans after the last scan completes, without a browser page timer.
let port = null;
let busy = false;
let selectedTab = null;
let enabled = false;
let connecting = null;
let badgeText = null;
const MARKETPLACE = 'https://www.mytutor.co.uk/tutors/secure/marketplace.html';

async function health(value) {
  await chrome.storage.local.set({health: {...value, observed_at: new Date().toISOString()}});
  const text = value.status === 'watching' ? 'ON' : '!';
  if (text !== badgeText) {
    await chrome.action.setBadgeText({text});
    badgeText = text;
  }
}

async function connect() {
  if (connecting) return connecting;
  if (port) return port;
  connecting = new Promise((resolve, reject) => {
  const connection = chrome.runtime.connectNative('uk.local.mytutor_watcher');
  port = connection;
  let ready = false;
  let stoppedByHost = false;
  const timer = setTimeout(() => {
    reject(Error('Local helper did not acknowledge startup within 10 seconds.'));
    connection.disconnect();
    if (port === connection) port = null;
  }, 10000);
  connection.onMessage.addListener(async message => {
    if (message.type === 'ready') { ready = true; clearTimeout(timer); resolve(connection); return; }
    if (message.type === 'scan' && enabled) await scan();
    if (message.type === 'introduce' && enabled) await introduce(message);
    if (message.type === 'health') {
      if(message.health.status==='stopped') stoppedByHost=true;
      try {
        if(stoppedByHost) {enabled=false;await chrome.storage.local.set({resume_requested:false});}
        await health(message.health);
      }
      finally {
        // The host has resolved pending work and released ownership. Drop its
        // keepalive so both the native process and idle worker can be reclaimed.
        if(stoppedByHost) {if(port===connection)port=null;connection.disconnect();}
      }
    }
    if (message.type === 'calendar_notice') await chrome.notifications.create({type:'basic',iconUrl:'icon.png',title:'MyTutor calendar',message:message.summary});
    if (message.type === 'changed') {
      await health(message.health);
      if (message.notify) await chrome.notifications.create({type:'basic', iconUrl:'icon.png', title:'MyTutor requests changed', message:message.summary});
    }
  });
  connection.onDisconnect.addListener(async () => {
    const reason = chrome.runtime.lastError?.message || 'Local helper disconnected';
    clearTimeout(timer);
    if (!ready) reject(Error(reason));
    if (stoppedByHost) return;
    if (port === connection) port = null;
    enabled = false;
    await chrome.storage.local.set({resume_requested:false});
    await health({status:'stopped', blocker:reason});
    // Do not silently reconnect after an uncertain ownership loss.
  });
  });
  try { return await connecting; } finally { connecting = null; }
}

async function start() {
  if (enabled) return;
  const tabs = await chrome.tabs.query({url: MARKETPLACE});
  if (tabs.length !== 1) throw Error('Open exactly one signed-in MyTutor Requests tab, then start.');
  selectedTab = tabs[0].id;
  await chrome.storage.local.set({resume_requested:true, selected_tab:selectedTab});
  const connection = await connect();
  enabled = true;
  connection.postMessage({type:'start', tab_id:selectedTab, protocol:2});
}

async function stop(reason='Stopped by user') {
  enabled = false;
  await chrome.storage.local.set({resume_requested:false});
  if (port) port.postMessage({type:'stop', reason});
  await health({status:'stopped', blocker:reason});
}

async function reload(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url !== MARKETPLACE) throw Error('The watched tab moved away from Requests; monitoring stopped.');
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => finish(Error('Page load exceeded 20 seconds')), 20000);
    function finish(error) {
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }
    function listener(id, change) { if(id === tabId && change.status === 'complete') finish(); }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId, {bypassCache:false}).catch(finish);
  });
}

// Executes in Chrome's isolated extension world. Reads rendered DOM and clicks
// only the two request tabs. Never evaluates page-supplied code or endpoints.
async function readPanels() {
  const visible = el => !!el && el.getClientRects().length > 0;
  const text = el => el.innerText.replace(/\r/g,'').trim();
  function check() {
    const body = document.body.innerText;
    if (/captcha|too many requests|rate limit|access denied|temporarily blocked/i.test(body)) throw Error('Access restriction or rate limit; stop and inspect MyTutor.');
    if (document.querySelector('input[type=password]')) throw Error('MyTutor sign-in required.');
    if (!Array.from(document.querySelectorAll('nav *')).some(el => visible(el) && text(el) === 'ACCOUNT_NAME')) throw Error('Signed-in ACCOUNT_NAME account could not be verified.');
  }
  async function panel(label, id) {
    const tabs = Array.from(document.querySelectorAll('[role=tab]')).filter(el => visible(el) && text(el).replace(/\s+\d+$/,'').trim() === label);
    if(tabs.length !== 1) throw Error('Request tabs changed; manual layout verification required.');
    tabs[0].click();
    const deadline = Date.now()+4000;
    while(Date.now() < deadline) {
      const p=document.getElementById(id);
      if(visible(p) && tabs[0].getAttribute('aria-selected') === 'true') {
        // Let the tab's asynchronous DOM updates settle before reading.
        await new Promise(resolve => {
          let timer=setTimeout(done,200); const observer=new MutationObserver(() => {clearTimeout(timer);timer=setTimeout(done,200);});
          const max=setTimeout(done,1000);
          function done(){clearTimeout(timer);clearTimeout(max);observer.disconnect();resolve();}
          observer.observe(p,{childList:true,subtree:true,characterData:true});
        });
        check();
        const visibleHeadings=Array.from(p.querySelectorAll('h4')).filter(visible);
        const headings=visibleHeadings.map(el=>text(el).replace(/\s+/g,' '));
        const cards=[];
        if(label==='Tutor requests') for(const h of visibleHeadings) {
          let card=h;
          while(card && card!==p) {
            const buttons=Array.from(card.querySelectorAll('button')).filter(b=>visible(b)&&text(b)==='Send a reply');
            if(buttons.length===1) {cards.push({heading:text(h).replace(/\s+/g,' '),text:text(card).replace(/\s+/g,' ')});break;}
            card=card.parentElement;
          }
        }
        return {text:text(p), headings, cards};
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('Request panel did not load.');
  }
  check();
  const matching=await panel('Matching team','marketplaceTabs:matchingTeamForm:matchingTeamPanel');
  const tutor=await panel('Tutor requests','marketplaceTabs:tutorRequestsForm:tutorRequestsPanel');
  return {account:'ACCOUNT_NAME',url:location.href,observed_at:new Date().toISOString(),matching_team:matching,tutor_requests:tutor};
}

async function scan() {
  if (busy || !enabled) return;
  busy = true;
  const started_at = new Date().toISOString();
  try {
    await reload(selectedTab);
    const result = await chrome.scripting.executeScript({target:{tabId:selectedTab}, func:readPanels});
    if (!result[0]?.result) throw Error('No readable request snapshot returned.');
    if (enabled && port) port.postMessage({type:'snapshot',started_at,finished_at:new Date().toISOString(),snapshot:result[0].result});
  } catch(error) {
    if (port) port.postMessage({type:'error',blocker:String(error.message || error)});
    await stop(String(error.message || error));
  } finally { busy = false; }
}

function isChatTab(tab) {
  return /^https:\/\/www\.mytutor\.co\.uk\/tutors\/secure\/chat\.html\?id=\d+$/.test(tab?.url||'') && tab.status==='complete';
}

async function waitForConversation(sourceId, createdIds, timeoutMs=12000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const ids=[sourceId,...createdIds];
    const candidates=[];
    for(const id of ids) {
      try {const tab=await chrome.tabs.get(id);if(isChatTab(tab)) candidates.push(tab);} catch(error) {if(id===sourceId) throw error;}
    }
    if(candidates.length>1) throw Error('Multiple reply conversations opened; inspect before sending');
    if(candidates.length===1) return candidates[0].id;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  return null;
}

async function replyDiagnostics() {
  const visible=el=>!!el&&el.getClientRects().length>0;
  return {url:location.href,dialogs:Array.from(document.querySelectorAll('[role=dialog]')).filter(visible).map(el=>el.innerText.trim().slice(0,2000)),
    errors:Array.from(document.querySelectorAll('[role=alert],.ui-messages-error,.ui-message-error')).filter(visible).map(el=>el.innerText.trim().slice(0,1000))};
}

async function waitLoaded(id, expected=null) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {
    const tab=await chrome.tabs.get(id);
    if(tab.status==='complete'&&(!expected||tab.url===expected))return tab;
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error('Duplicate-check page load timed out');
}
async function scriptResult(id,func,args=[]) {
  const result=(await chrome.scripting.executeScript({target:{tabId:id},func,args}))[0];
  if(result?.error)throw Error(String(result.error.message||result.error));
  if(!result?.result)throw Error('No verified inspection result');
  return result.result;
}
async function messageNavigation() {
  const link=Array.from(document.querySelectorAll('nav a')).find(e=>e.innerText.trim()==='Messages');
  if(!link||link.href!=='https://www.mytutor.co.uk/tutors/secure/messages.html')throw Error('Messages navigation not verified');
  return {url:link.href};
}
async function openListedConversation(id,details) {
  // Retrying only navigation/inspection is safe; this path has no Send control.
  const list=await chrome.tabs.get(id);
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const listing=await scriptResult(id,inspectMessageList,[details,true]);
      if(listing.stage!=='located'||!/^https:\/\/www\.mytutor\.co\.uk\/tutors\/secure\/chat\.html\?id=\d+$/.test(listing.conversation_url||''))throw Error('Conversation destination not verified');
      await chrome.tabs.update(id,{url:listing.conversation_url});
      await waitLoaded(id,listing.conversation_url);
      return id;
    } catch(error) {
      if(attempt===1)throw error;
      await chrome.tabs.update(id,{url:list.url});await waitLoaded(id,list.url);
    }
  }
}
async function checkDuplicates(details,context) {
  const nav=await scriptResult(selectedTab,messageNavigation);
  const tab=await chrome.tabs.create({url:nav.url,active:false});context.id=tab.id;
  await waitLoaded(tab.id,nav.url);
  const proof={active_checked:false,archived_checked:false};
  let listing=await scriptResult(tab.id,inspectMessageList,[details,false]);
  const urls=[listing.links['Active chats'],listing.links.Archived];context.activeUrl=urls[0];
  for(let index=0;index<urls.length;index++) {
    if(index) {await chrome.tabs.update(tab.id,{url:urls[index]});await waitLoaded(tab.id,urls[index]);listing=await scriptResult(tab.id,inspectMessageList,[details,false]);}
    if(listing.archived!==(index===1))throw Error('Active/archived list identity mismatch');
    if(listing.matches===1) {
      const chat=await openListedConversation(tab.id,details);
      const conversation=await scriptResult(chat,inspectConversation,[details,'duplicate']);
      if(conversation.draft_present)return {skip:true,evidence:{reason:'Existing conversation draft preserved',stop:true,...conversation}};
      if(conversation.outgoing_count>0)return {skip:true,evidence:{reason:'Existing outgoing message: no duplicate introduction',...conversation}};
    }
    proof[index===0?'active_checked':'archived_checked']=true;
  }
  proof.checked_at=new Date().toISOString();return {proof};
}
async function verifyInlineSend(details,context,submission,sourceId=null,createdIds=new Set()) {
  // Confirmation is the exact delivered message in the actual conversation,
  // never merely a closed modal or disappearance of the opportunity.
  let chat=sourceId===null?null:await waitForConversation(sourceId,createdIds,2000);
  if(chat===null) {
    await chrome.tabs.update(context.id,{url:context.activeUrl});await waitLoaded(context.id,context.activeUrl);
    chat=await openListedConversation(context.id,details);
  }
  const deadline=Date.now()+8000;
  while(Date.now()<deadline) {
    const evidence=await scriptResult(chat,inspectConversation,[details]);
    if(evidence.sent_count===1&&['Sent','Delivered','Read'].includes(evidence.delivery))return {status:'completed',evidence:{...evidence,submitted_at:submission.submitted_at,completed_at:new Date().toISOString(),inline:true}};
    await new Promise(r=>setTimeout(r,200));
  }
  throw Error('Exact inline introduction delivery not confirmed; no automatic retry');
}

async function introduce(command) {
  while(busy) await new Promise(resolve=>setTimeout(resolve,20));
  if(!enabled || !port) return;
  busy=true;
  let outcome, conversationTab=null, openingError=null, phase="duplicate_check";
  const inspection={};
  const sourceId=selectedTab;
  const createdIds=new Set();
  // Track only tabs opened by this owned Requests tab during this action.
  // Existing tabs, unrelated user tabs and guessed conversation URLs are excluded.
  const onCreated=tab=>{if(tab.openerTabId===sourceId)createdIds.add(tab.id);};
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    const args=[command.details];
    const duplicates=await checkDuplicates(command.details,inspection);
    if(duplicates.skip) outcome={status:'not_performed',evidence:duplicates.evidence};
    else {
    phase="reply_opening";
    let opened;
    try {
      const injected=(await chrome.scripting.executeScript({target:{tabId:sourceId},func:performIntroduction,args}))[0];
      if(injected?.error) throw Error(String(injected.error.message||injected.error));
      opened=injected?.result;
      if(!opened) openingError='Reply script returned no outcome';
    } catch(error) {
      // Retain the real failure. Never replay a potentially successful click.
      openingError=String(error.message||error);
    }
    if(opened?.status) outcome=opened;
    else if(opened?.stage==='inline') {
      let submitted, submissionError;
      try {submitted=await scriptResult(sourceId,sendInlineIntroduction,[command.details,duplicates.proof]);}
      catch(error) {submissionError=String(error.message||error);}
      // Send can replace the document and destroy the injected script context.
      // Reconcile read-only; never replay a possibly successful submission.
      if(submitted?.status && submitted.evidence?.submitted!==true) outcome=submitted;
      else {
        outcome=await verifyInlineSend(command.details,inspection,submitted||{},sourceId,createdIds);
        if(submissionError)outcome.evidence.submission_error=submissionError;
        const source=await chrome.tabs.get(sourceId);
        if(isChatTab(source) && source.url===outcome.evidence.conversation_url)conversationTab=sourceId;
      }
    }
    else {
      conversationTab=await waitForConversation(sourceId,createdIds);
      if(!conversationTab) {
        let diagnostic;
        try {diagnostic=(await chrome.scripting.executeScript({target:{tabId:sourceId},func:replyDiagnostics}))[0]?.result;} catch(error) {diagnostic={inspection_error:String(error.message)};}
        outcome={status:'needs_review',evidence:{reason:openingError ? 'Reply script failed: '+openingError : 'Continue did not open a verifiable conversation',continued:opened?.continued??'unknown',opening_error:openingError,diagnostic}};
      } else {
        if(!enabled || !port) throw Error('Watcher stopped before conversation submission');
        outcome=(await chrome.scripting.executeScript({target:{tabId:conversationTab},func:continueIntroduction,args}))[0]?.result;
        if(!outcome) throw Error('No introduction outcome returned');
        outcome.evidence.conversation_tab_id=conversationTab;
        if(openingError) outcome.evidence.opening_error=openingError;
      }
    }
    }
  } catch(error) {outcome={status:phase==='duplicate_check'?'not_performed':'needs_review',evidence:{reason:String(error.message),phase,submitted:phase==='duplicate_check'?false:'unknown',stop:true,continued:phase==='duplicate_check'?false:'unknown',opening_error:openingError}};}
  finally {chrome.tabs.onCreated.removeListener(onCreated);
    if(inspection.id && outcome?.status!=='needs_review') {try {await chrome.tabs.remove(inspection.id);}catch(error){/* read-only inspection tab already closed */}}
  }
  // Preserve unrelated navigation and all uncertain conversation/draft state.
  try {
    const source=await chrome.tabs.get(sourceId);
    if(source.url!==MARKETPLACE) {
      if(sourceId===conversationTab && isChatTab(source) && outcome.status!=='needs_review') {
        await chrome.tabs.update(sourceId,{url:MARKETPLACE});
        await waitLoaded(sourceId,MARKETPLACE);
        const restored=await scriptResult(sourceId,readPanels);
        if(restored.account!=='ACCOUNT_NAME'||restored.url!==MARKETPLACE)throw Error('Restored Requests account/location not verified');
        outcome.evidence.requests_restored=true;
        outcome.evidence.requests_restored_at=new Date().toISOString();
      }
      else outcome.evidence.restore_error='Watched tab moved; current page preserved for inspection';
    }
  } catch(error) {outcome.evidence.restore_error=String(error.message);}
  // Release the browser-operation lock before the host schedules the next scan.
  // Notification latency must not consume or discard that scan command.
  busy=false;
  if(port) port.postMessage({type:'introduction_result',action_id:command.action_id,...outcome});
  if(outcome.status==='completed') await chrome.notifications.create({type:'basic',iconUrl:'icon.png',title:'MyTutor introduction sent',message:'Sent and verified your introduction to '+command.details.recipient+'.'});
  else if(outcome.status==='needs_review') await chrome.notifications.create({type:'basic',iconUrl:'icon.png',title:'MyTutor action needs inspection',message:outcome.evidence.reason||'The outcome is uncertain. No automatic retry will be made.'});
}

chrome.runtime.onMessage.addListener((message,sender,respond) => {
  // Accept control only from this extension's popup, never from a webpage.
  if(sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  (async()=>{
    try { if(message.type === 'start') await start(); else if(message.type === 'stop') await stop(); respond({ok:true}); }
    catch(error){ await health({status:'stopped',blocker:String(error.message || error)});respond({ok:false}); }
  })();
  return true;
});

chrome.runtime.onStartup.addListener(async()=>{
  const saved=await chrome.storage.local.get(['resume_requested','selected_tab']);
  if(saved.resume_requested) {
    // Resume only after the actual tab is present; missing tabs require Start.
    try { await start(); } catch(error) { await health({status:'stopped',blocker:String(error.message || error)}); }
  }
});
