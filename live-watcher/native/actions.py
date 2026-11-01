"""Policy decisions and journaled action coordination; no page-supplied commands."""
import hashlib
import re
import workflow

ALIASES = {'Maths':'Mathematics', 'Further Maths':'Further Mathematics'}
LEVELS = {'A Level':'A-level','A-level':'A-level','AS Level':'AS-level','AS-level':'AS-level',
          'GCSE':'GCSE','KS1':'KS1','KS2':'KS2','KS3':'KS3','11-plus':'11-plus','13-plus':'13-plus'}

def clean(value):
    return re.sub(r'\s+', ' ', value).strip()

def introduction(card, policy):
    """Use the structured visible heading only; request prose is never a prompt."""
    heading = clean(card.get('heading',''))
    match = re.fullmatch(r'(.+?) (A Level|A-level|AS Level|AS-level|GCSE|KS1|KS2|KS3|11-plus|13-plus) - ([\w .’\'-]+) \((Parent|Student)\)', heading)
    if not match:
        return None
    subject = ALIASES.get(match[1],match[1])
    if subject not in policy['subjects']:
        return None
    name = clean(match[3])
    # Avoid inventing a topic: subject and level are themselves verified facts.
    message = policy['intro_template'].format(parent_name=name.split()[0],
        grade=policy['tutor_background']['a_level_grades'][subject],subject=subject,
        request_topic=f"{LEVELS[match[2]]} {subject}")
    text = clean(card.get('text',''))
    if re.search(r'whatsapp|recruit(?:er|ment)|AI training|remote (?:work|job)|https?://',text,re.I):
        return None
    if not text or len(text)>20000 or heading not in text:
        return None
    return {'subject':subject,'level':LEVELS[match[2]],'recipient':name,'message':message,
            'heading':heading,'card_text':text,
            'entity_id':'request:'+hashlib.sha256(text.encode()).hexdigest()}

class Introductions:
    def __init__(self, root):
        self.root = root
        self.pending = None

    def next(self, token, cards):
        if self.pending:
            raise ValueError('An introduction is already in flight')
        if not cards:
            return None
        policy = workflow.load(self.root/'mytutor-policy.json',None)
        ledger = None
        for card in cards:
            details = introduction(card,policy)
            if not details:
                continue
            if ledger is None:
                ledger = workflow.ledger(self.root)
            related = [a for a in ledger['actions'] if a['entity_id']==details['entity_id']]
            if related:  # Do not repeat even a known skipped layout on every refresh.
                continue
            action = workflow.begin(token,'introduction',details['entity_id'],details,self.root)
            self.pending = action
            return {'type':'introduce','action_id':action['id'],'details':details}
        return None

    def result(self, token, value):
        action = self.pending
        if not action or value.get('action_id') != action['id']:
            raise ValueError('Unexpected introduction result')
        status = value.get('status')
        evidence = value.get('evidence')
        if status not in ('completed','not_performed','needs_review') or not isinstance(evidence,dict):
            raise ValueError('Invalid introduction evidence')
        if status=='completed':
            if evidence.get('message')!=action['details']['message'] or evidence.get('sent_count')!=1 or evidence.get('delivery') not in ('Sent','Delivered','Read'):
                raise ValueError('Exact sent message and delivery evidence required')
            if not re.fullmatch(r'https://www\.mytutor\.co\.uk/tutors/secure/chat\.html\?id=\d+',evidence.get('conversation_url','')):
                raise ValueError('Verified conversation URL required')
        import json
        workflow.resolve(token,action['id'],status,json.dumps(evidence),self.root)
        self.pending = None
        return status

    def uncertain(self, token, reason):
        if self.pending:
            workflow.resolve(token,self.pending['id'],'needs_review',reason,self.root)
            self.pending = None
