import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
BASE=Path(__file__).resolve().parent
sys.path[:0]=[str(BASE.parent),str(BASE/'native')]
import actions
import calendar_sync
import workflow

class ActionTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        self.root=Path(self.folder.name)
        self.policy=json.loads((BASE.parent/'mytutor-policy.json').read_text())
        (self.root/'mytutor-policy.json').write_text(json.dumps(self.policy))
        self.token=workflow.acquire(self.root)['token']
        self.addCleanup(lambda:workflow.release(self.token,self.root))
        self.engine=actions.Introductions(self.root)
        self.card={'heading':'Maths A Level - Alice M. (Parent)', 'text':'Maths A Level - Alice M. (Parent) Looking for help with algebra Send a reply Decline'}

    def test_factual_message_and_subject_alias(self):
        value=actions.introduction(self.card,self.policy)
        self.assertEqual((value['subject'],value['level']),('Mathematics','A-level'))
        self.assertIn('A* in A-level Mathematics',value['message'])
        self.assertIn('Hi Alice,',value['message'])
        self.assertNotIn('algebra',value['message'])  # Not an inferred specialism.

    def test_empty_and_ineligible_scans_do_not_load_growing_action_journal(self):
        with patch.object(workflow,'ledger',side_effect=AssertionError('Unnecessary journal load')):
            self.assertIsNone(self.engine.next(self.token,[]))
            self.assertIsNone(self.engine.next(self.token,[{'heading':'Unknown request','text':'Unknown request'}]))

    def test_eligible_card_still_requires_fresh_valid_journal(self):
        (self.root/'action-log.json').write_text('{"actions": "invalid"}')
        with self.assertRaisesRegex(ValueError,'Malformed action log'):
            self.engine.next(self.token,[self.card])

    def test_ambiguous_unsupported_and_recruitment_skip(self):
        for heading in ['Maths - Alice (Parent)','Physics GCSE - Alice (Parent)','Mathematics Degree - Alice (Parent)']:
            self.assertIsNone(actions.introduction(dict(heading=heading,text=heading),self.policy))
        card=dict(self.card,text=self.card['text']+' I am a recruiter offering AI training work; contact WhatsApp')
        self.assertIsNone(actions.introduction(card,self.policy))

    def test_journal_precedes_command_and_uncertainty_never_replays(self):
        command=self.engine.next(self.token,[self.card])
        self.assertEqual(workflow.ledger(self.root)['actions'][0]['status'],'pending')
        self.engine.uncertain(self.token,'Connection lost after Continue')
        self.assertIsNone(self.engine.next(self.token,[self.card]))
        self.assertEqual(workflow.ledger(self.root)['actions'][0]['status'],'needs_review')

    def test_duplicate_conversation_is_not_sent_and_not_repeated(self):
        command=self.engine.next(self.token,[self.card])
        self.engine.result(self.token,dict(action_id=command['action_id'],status='not_performed',evidence={'reason':'Existing outgoing message'}))
        self.assertIsNone(self.engine.next(self.token,[self.card]))

    def test_false_success_rejected_but_exact_verified_send_resolves(self):
        command=self.engine.next(self.token,[self.card])
        evidence={'message':'wrong','sent_count':1,'delivery':'Delivered','conversation_url':'https://www.mytutor.co.uk/tutors/secure/chat.html?id=123'}
        with self.assertRaises(ValueError):self.engine.result(self.token,dict(action_id=command['action_id'],status='completed',evidence=evidence))
        evidence['message']=command['details']['message']
        self.engine.result(self.token,dict(action_id=command['action_id'],status='completed',evidence=evidence))
        self.assertEqual(workflow.ledger(self.root)['actions'][0]['status'],'completed')

    def test_calendar_cannot_resume_a_send(self):
        command=self.engine.next(self.token,[self.card])
        with self.assertRaises(ValueError):workflow.resume_calendar(self.token,command['action_id'],self.root)

    def test_calendar_does_nothing_without_confirmed_acceptance(self):
        runner=Mock();self.assertEqual(calendar_sync.sync_confirmed(self.token,self.root,runner),[]);runner.assert_not_called()

    def test_calendar_failure_retries_only_same_calendar_record(self):
        booking={'confirmed':True,'free_meeting':True,'start':'2026-12-10T10:00:00+00:00','end':'2026-12-10T10:15:00+00:00','student':'Alice M.','subject':'Mathematics','booking_link':'https://www.mytutor.co.uk/tutors/secure/chat.html?id=123'}
        accepted={'id':'accept1','entity_id':'booking:123','kind':'acceptance','status':'completed','details':{'free_meeting':True},'evidence':json.dumps({'confirmed_booking':booking})}
        workflow.atomic_json(self.root/'action-log.json',{'actions':[accepted]})
        runner=Mock(return_value=Mock(returncode=1,stdout=json.dumps({'success':False,'blocker':'Calendar unavailable'})))
        calendar_sync.sync_confirmed(self.token,self.root,runner)
        first=workflow.ledger(self.root)['actions'][-1]
        runner.return_value=Mock(returncode=0,stdout=json.dumps({'success':True,'event_id':'event1','recovered':True}))
        calendar_sync.sync_confirmed(self.token,self.root,runner)
        rows=workflow.ledger(self.root)['actions']
        self.assertEqual(len(rows),2);self.assertEqual(rows[-1]['id'],first['id']);self.assertEqual(rows[-1]['status'],'completed')
        self.assertEqual(runner.call_args.args[0][-2],first['id'])

if __name__=='__main__':unittest.main()
