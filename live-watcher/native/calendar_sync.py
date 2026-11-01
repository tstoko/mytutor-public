"""Only confirmed journaled acceptances can seed calendar sync; no website guesses."""
import json
from pathlib import Path
import subprocess
import workflow

HELPER = Path.home()/'Library/Application Support/MyTutorLive/MyTutor Calendar Helper.app/Contents/MacOS/CalendarHelper'

def sync_confirmed(token, root, runner=subprocess.run):
    results=[]
    actions=workflow.ledger(root)['actions']
    for accepted in actions:
        if accepted['kind']!='acceptance' or accepted['status']!='completed':
            continue
        entity=accepted['entity_id']
        related=[a for a in actions if a['entity_id']==entity and a['kind'].startswith('calendar_')]
        if any(a['status']=='completed' for a in related):
            continue  # Updates/cancellations require new verified live booking evidence.
        pending=[a for a in related if a['status'] in ('pending','needs_review')]
        try:
            if pending:
                if len(pending)!=1 or pending[0]['kind']!='calendar_create':
                    raise ValueError('Ambiguous pending calendar actions require inspection')
                record=workflow.resume_calendar(token,pending[0]['id'],root)
            else:
                evidence=json.loads(accepted.get('evidence',''))
                booking=evidence['confirmed_booking']
                if booking.get('confirmed') is not True or booking.get('free_meeting') is not True:
                    raise ValueError('Confirmed free-booking evidence missing')
                details={key:booking[key] for key in ('start','end','student','subject','booking_link')}
                details.update(confirmed=True,calendar='Tutoring')
                record=workflow.begin(token,'calendar_create',entity,details,root)
            completed=runner([str(HELPER),'--journal-action',record['id'],token],capture_output=True,text=True,timeout=20)
            result=json.loads(completed.stdout)
            success=completed.returncode==0 and result.get('success') is True and bool(result.get('event_id'))
            workflow.resolve(token,record['id'],'completed' if success else 'needs_review',json.dumps(result),root)
            results.append(dict(result,entity_id=entity))
        except Exception as error:
            # Preserve pending records on interruption. Never accept again.
            results.append({'success':False,'entity_id':entity,'blocker':str(error)})
    return results
