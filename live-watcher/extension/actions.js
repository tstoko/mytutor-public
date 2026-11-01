// Runs in the extension's isolated world. Every control below was observed in
// MyTutor's rendered UI. No endpoints, application internals or page eval.
async function performIntroduction(details) {
  const normalize = value => value.replace(/\s+/g,' ').trim();
  const visible = el => !!el && el.getClientRects().length>0;
  const get = id => document.getElementById(id);
  let continued = false, submitted = false;
  function check() {
    if (!Array.from(document.querySelectorAll('nav *')).some(el=>visible(el)&&normalize(el.innerText)==='ACCOUNT_NAME')) throw Error('ACCOUNT_NAME account not verified');
    if (/captcha|too many requests|rate limit|access denied|temporarily blocked/i.test(document.body.innerText)) throw Error('Access restriction; stopped');
    if (document.querySelector('input[type=password]')) throw Error('Sign-in required');
  }
  async function until(read, label) {
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) { check(); const value=read(); if(value)return value; await new Promise(r=>setTimeout(r,100)); }
    throw Error(label+' did not become verifiable');
  }
  try {
    check();
    if (location.href!=='https://www.mytutor.co.uk/tutors/secure/marketplace.html') throw Error('Requests location changed');
    const panel=get('marketplaceTabs:tutorRequestsForm:tutorRequestsPanel');
    const candidates=Array.from(panel?.querySelectorAll('h4')||[]).filter(h=>visible(h)&&normalize(h.innerText)===details.heading);
    if(candidates.length!==1) throw Error('Request heading missing or ambiguous');
    let card=candidates[0];
    while(card && card!==panel) {
      const replies=Array.from(card.querySelectorAll('button')).filter(b=>visible(b)&&normalize(b.innerText)==='Send a reply');
      if(replies.length===1 && normalize(card.innerText)===details.card_text) break;
      card=card.parentElement;
    }
    if(!card || card===panel) throw Error('Request content changed or card layout unknown');
    const reply=Array.from(card.querySelectorAll('button')).find(b=>visible(b)&&normalize(b.innerText)==='Send a reply');
    reply.click();
    const modal=await until(()=>visible(get('acceptTutorRequestModal'))&&get('acceptTutorRequestModal'),'Reply dialog');
    const button=get('acceptTutorRequestForm:continue');
    if(!visible(button)||button.disabled||normalize(button.innerText)!=='Continue' || /terms|contract|payment|fee|recurring/i.test(modal.innerText)) throw Error('Reply dialog differs from verified flow');
    // Continue may register interest. Journal exists before this first step.
    if(!(await chrome.storage.local.get('resume_requested')).resume_requested) throw Error('Watcher stopped before Continue');
    continued=true;button.click();
    // The observed flow replaces this dialog with an inline composer. A true
    // navigation may destroy the context; the background handles that separately.
    return await until(()=>{const input=get('acceptTutorRequestForm:personalMessage:input');return visible(input)?{stage:'inline',continued:true}:null;},'Inline introduction composer');
  } catch(error) {
    return {status:(continued||submitted)?'needs_review':'not_performed',evidence:{reason:String(error.message),continued,submitted,stop:true}};
  }
}

async function continueIntroduction(details) {
  const normalize=value=>value.replace(/\s+/g,' ').trim();
  const visible=el=>!!el&&el.getClientRects().length>0;
  let submitted=false;
  function verify() {
    if(!/^https:\/\/www\.mytutor\.co\.uk\/tutors\/secure\/chat\.html\?id=\d+$/.test(location.href)) throw Error('No verified conversation location');
    if(!Array.from(document.querySelectorAll('nav *')).some(el=>visible(el)&&normalize(el.innerText)==='ACCOUNT_NAME')) throw Error('Account changed');
    if(/captcha|too many requests|rate limit|access denied|temporarily blocked/i.test(document.body.innerText)) throw Error('Access restriction');
    const card=document.getElementById('tutorcardForm');
    if(!card || !normalize(card.innerText).startsWith(details.recipient+' ')) throw Error('Conversation recipient could not be matched');
    const history=document.getElementById('chathistory:chatmessages');
    if(!visible(history)) throw Error('Conversation history not loaded');
    const fields={};
    for(const dt of history.querySelectorAll('dt')) fields[normalize(dt.innerText)]=normalize(dt.nextElementSibling?.innerText||'');
    const subjects={'Maths':'Mathematics','Further Maths':'Further Mathematics'};
    const levels={'A Level':'A-level','AS Level':'AS-level'};
    if((subjects[fields.Subject]||fields.Subject)!==details.subject || (levels[fields.Level]||fields.Level)!==details.level) throw Error('Conversation subject or level differs from request');
    return history;
  }
  try {
    const history=verify();
    if(history.querySelectorAll('.message.sent').length) return {status:'not_performed',evidence:{reason:'Existing outgoing message: no duplicate introduction',conversation_url:location.href,continued:true}};
    const input=document.getElementById('chatreplyform:replyinput'),button=document.getElementById('chatreplyform:send');
    if(!visible(input)||!visible(button)||input.value.trim()||button.disabled||normalize(button.innerText)!=='Send') throw Error('Composer missing, disabled or contains a draft');
    const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    setter.call(input,details.message); input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    verify();
    if(input.value!==details.message || history.querySelector('.message.sent')) throw Error('Composer or conversation changed before send');
    if(!(await chrome.storage.local.get('resume_requested')).resume_requested) throw Error('Watcher stopped before Send');
    verify();
    if(input.value!==details.message || history.querySelector('.message.sent')) throw Error('Conversation changed during final check');
    submitted=true;button.click(); // Exactly once, never retry a click.
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      const current=verify();
      const sent=Array.from(current.querySelectorAll('.message.sent')).filter(el=>normalize(el.querySelector('.message__body')?.innerText||'')===normalize(details.message));
      if(sent.length===1) {
        const delivery=normalize(sent[0].querySelector('.message__status')?.innerText||'');
        if(['Sent','Delivered','Read'].includes(delivery)) return {status:'completed',evidence:{message:details.message,sent_count:1,delivery,conversation_url:location.href,completed_at:new Date().toISOString()}};
      }
      await new Promise(r=>setTimeout(r,150));
    }
    throw Error('Send outcome not confirmed');
  } catch(error) { return {status:'needs_review',evidence:{reason:String(error.message),continued:true,submitted,conversation_url:location.href}}; }
}

// Read the complete active/archived message list before the inline request send.
async function inspectMessageList(details, openMatch=false) {
  const normalize=s=>s.replace(/\s+/g,' ').trim();
  const visible=e=>!!e&&e.getClientRects().length>0;
  if(!Array.from(document.querySelectorAll('nav *')).some(e=>visible(e)&&normalize(e.innerText)==='ACCOUNT_NAME')) throw Error('Duplicate check account not verified');
  if(/captcha|too many requests|rate limit|access denied|temporarily blocked/i.test(document.body.innerText)) throw Error('Duplicate check access restriction');
  const links=Object.fromEntries(Array.from(document.querySelectorAll('a')).filter(e=>['Active chats','Archived'].includes(normalize(e.innerText))).map(e=>[normalize(e.innerText),e.href]));
  if(!links['Active chats']||!links.Archived) throw Error('Message-list navigation not verified');
  const table=document.getElementById('chatsForCurrentUserForm:tutorMessagesTable_data');
  const archived=location.search==='?archived=true';
  if(!table) {
    if(archived&&document.body.innerText.includes('Archived message threads live here')) return {stage:'list',matches:0,links,archived};
    throw Error('Complete message list not loaded');
  }
  const search=document.getElementById('chatsForCurrentUserForm:searchInput');
  if(search?.value.trim()||Array.from(document.querySelectorAll('.ui-paginator,button,a')).some(e=>visible(e)&&(/load more/i.test(e.innerText)||e.classList.contains('ui-paginator')))) throw Error('Filtered or paginated message list cannot prove duplicate absence');
  const first=details.recipient.split(' ')[0];
  const matches=Array.from(table.querySelectorAll('tr')).filter(row=>normalize(row.querySelectorAll('td')[1]?.innerText||'').split(' ')[0]===first);
  if(matches.length>1) throw Error('Multiple conversations share the recipient name; inspect before sending');
  if(matches.length===1&&openMatch) {
    // MyTutor binds navigation to inner divs, not the table row. Read the
    // exact observed destination without executing arbitrary onclick code.
    const targets=Array.from(matches[0].querySelectorAll('div[onclick]')).map(el=>el.getAttribute('onclick'));
    const urls=targets.map(value=>/^location\.href='(\/tutors\/secure\/chat\.html\?id=\d+)'$/.exec(value)?.[1]);
    if(!urls.length||urls.some(url=>!url)||new Set(urls).size!==1)throw Error('Conversation navigation control not verified');
    return {stage:'located',conversation_url:new URL(urls[0],location.href).href,links,archived};
  }
  return {stage:'list',matches:matches.length,links,archived};
}

async function inspectConversation(details, purpose="confirmation") {
  const normalize=s=>s.replace(/\s+/g,' ').trim();
  const visible=e=>!!e&&e.getClientRects().length>0;
  if(!/^https:\/\/www\.mytutor\.co\.uk\/tutors\/secure\/chat\.html\?id=\d+$/.test(location.href)) throw Error('Conversation URL not verified');
  if(!Array.from(document.querySelectorAll('nav *')).some(e=>visible(e)&&normalize(e.innerText)==='ACCOUNT_NAME')) throw Error('Conversation account not verified');
  const card=document.getElementById('tutorcardForm'),history=document.getElementById('chathistory:chatmessages');
  if(!card||!normalize(card.innerText).startsWith(details.recipient+' ')||!visible(history)) throw Error('Duplicate-check conversation recipient not verified');
  const fields={};for(const dt of history.querySelectorAll('dt')) fields[normalize(dt.innerText)]=normalize(dt.nextElementSibling?.innerText||'');
  const subject={'Maths':'Mathematics','Further Maths':'Further Mathematics'}[fields.Subject]||fields.Subject;
  const level={'A Level':'A-level','AS Level':'AS-level'}[fields.Level]||fields.Level;
  const sent=Array.from(history.querySelectorAll('.message.sent'));
  // Existing outgoing messages/drafts prohibit another introduction even in
  // older conversations lacking the new-request student-information block.
  const draft_present=!!document.getElementById('chatreplyform:replyinput')?.value.trim();
  if(purpose==='duplicate'&&(sent.length||draft_present))return {draft_present,conversation_url:location.href,outgoing_count:sent.length};
  if(subject!==details.subject||level!==details.level) throw Error('Duplicate-check conversation subject/level mismatch');
  const exact=sent.filter(e=>normalize(e.querySelector('.message__body')?.innerText||'')===normalize(details.message));
  return {draft_present:!!document.getElementById('chatreplyform:replyinput')?.value.trim(),conversation_url:location.href,outgoing_count:sent.length,sent_count:exact.length,message:details.message,delivery:exact.length===1?normalize(exact[0].querySelector('.message__status')?.innerText||''):'',observed_at:new Date().toISOString()};
}

async function sendInlineIntroduction(details, duplicateProof) {
  const normalize=s=>s.replace(/\s+/g,' ').trim();
  const visible=e=>!!e&&e.getClientRects().length>0;
  const get=id=>document.getElementById(id);
  let submitted=false;
  function verify() {
    if(location.href!=='https://www.mytutor.co.uk/tutors/secure/marketplace.html') throw Error('Inline reply location changed');
    if(!Array.from(document.querySelectorAll('nav *')).some(e=>visible(e)&&normalize(e.innerText)==='ACCOUNT_NAME')) throw Error('Inline reply account not verified');
    if(/captcha|too many requests|rate limit|access denied|temporarily blocked/i.test(document.body.innerText)) throw Error('Access restriction');
    if(!duplicateProof?.active_checked||!duplicateProof?.archived_checked||!Number.isFinite(Date.parse(duplicateProof.checked_at))||Date.now()-Date.parse(duplicateProof.checked_at)>60000||Date.now()<Date.parse(duplicateProof.checked_at)) throw Error('Fresh complete conversation duplicate check required');
    const panel=get('marketplaceTabs:tutorRequestsForm:tutorRequestsPanel');
    const headings=Array.from(panel?.querySelectorAll('h4')||[]).filter(e=>normalize(e.innerText)===details.heading);
    if(headings.length!==1) throw Error('Inline reply request changed');
    let card=headings[0];while(card&&card!==panel&&normalize(card.innerText)!==details.card_text)card=card.parentElement;
    if(!card||card===panel) throw Error('Exact request content no longer matches');
    const modal=get('acceptTutorRequestModal'),input=get('acceptTutorRequestForm:personalMessage:input');
    if(!visible(modal)||!visible(input)||normalize(modal.querySelector('h1')?.innerText||'')!=='Introduce yourself') throw Error('Verified inline composer missing');
    const labels=Array.from(modal.querySelectorAll('header li')).map(e=>normalize(e.innerText));
    const subject={'Maths':'Mathematics','Further Maths':'Further Mathematics'}[labels[0]]||labels[0];
    const level={'A Level':'A-level','AS Level':'AS-level'}[labels[1]]||labels[1];
    if(subject!==details.subject||level!==details.level) throw Error('Inline composer subject/level mismatch');
    return input;
  }
  try {
    let input=verify();if(input.value.trim()) throw Error('Existing inline draft preserved');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,details.message);
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    // The real form enables Send through its observed keyup AJAX validator.
    input.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'End'}));
    const deadline=Date.now()+8000;let button;
    while(Date.now()<deadline) {
      input=verify();button=get('acceptTutorRequestForm:replyToMarketplaceRequest');
      if(visible(button)&&!button.disabled&&normalize(button.innerText)==='Send message')break;
      await new Promise(r=>setTimeout(r,100));
    }
    if(!visible(button)||button.disabled||input.value!==details.message) throw Error('Inline Send validation did not complete');
    if(!(await chrome.storage.local.get('resume_requested')).resume_requested) throw Error('Watcher stopped before inline Send');
    input=verify();button=get('acceptTutorRequestForm:replyToMarketplaceRequest');
    if(!visible(button)||button.disabled||normalize(button.innerText)!=='Send message'||input.value!==details.message) throw Error('Inline composer changed before Send');
    submitted=true;button.click(); // One click; conversation verification follows.
    const submitted_at=new Date().toISOString();
    const settleDeadline=Date.now()+10000;
    while(Date.now()<settleDeadline) {
      if(!visible(get('acceptTutorRequestModal'))) return {stage:'submitted',submitted:true,submitted_at};
      const errors=Array.from(get('acceptTutorRequestModal').querySelectorAll('.ui-message-error,.ui-messages-error,[role=alert]')).filter(visible).map(e=>e.innerText.trim()).filter(Boolean);
      if(errors.length) throw Error('Inline submission validation: '+errors.join(' '));
      await new Promise(r=>setTimeout(r,100));
    }
    throw Error('Inline submission did not acknowledge; inspect conversation before retrying');
  } catch(error) {return {status:'needs_review',evidence:{reason:String(error.message),submitted,inline:true}};}
}
