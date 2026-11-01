import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import sys
import shutil
import subprocess
from unittest.mock import patch

BASE = Path(__file__).resolve().parent
sys.path.insert(0,str(BASE.parent))
sys.path.insert(0,str(BASE/'native'))
spec=importlib.util.spec_from_file_location('watcher_host',BASE/'native/host.py')
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.policy=json.loads((BASE.parent/'mytutor-policy.json').read_text())
        (self.root/'mytutor-policy.json').write_text(json.dumps(self.policy))
        self.clock=0.;self.messages=[]
        self.watcher=host.Host(self.messages.append,self.root,lambda:self.clock)
        self.addCleanup(lambda:self.watcher.stop('test cleanup') if self.watcher.token else None)

    def snapshot(self, heading='Mathematics GCSE - Alice (Parent)'):
        return {'type':'snapshot','started_at':'2026-10-09T13:20:00+00:00','finished_at':'2026-10-09T13:20:01+00:00','snapshot':{
            'account':'ACCOUNT_NAME','url':'https://www.mytutor.co.uk/tutors/secure/marketplace.html','observed_at':'2026-10-09T13:20:01+00:00',
            'matching_team':{'text':"New requests Ah shucks, there's nothing to see here",'headings':['New requests']},
            'tutor_requests':{'text':heading,'headings':[heading]}}}

    def test_native_protocol_roundtrip_and_short_frames(self):
        stream=io.BytesIO();host.write_frame(stream,{'type':'start'});stream.seek(0)
        self.assertEqual(host.read_frame(stream),{'type':'start'})
        self.assertIsNone(host.read_frame(stream))
        for data in [b'\x01',struct.pack('=I',host.MAX_FRAME+1),struct.pack('=I',5)+b'{}']:
            with self.assertRaises(ValueError):host.read_frame(io.BytesIO(data))

    def test_sleep_tracks_scan_deadline_calendar_and_stopped_state(self):
        self.assertIsNone(self.watcher.wait_timeout())
        self.watcher.start(protocol=2)
        self.assertEqual(self.watcher.wait_timeout(),0)
        self.watcher.tick()
        self.assertEqual(self.watcher.wait_timeout(),35)
        self.clock=2
        self.watcher.snapshot(self.snapshot())
        self.assertEqual(self.watcher.wait_timeout(),5)
        self.watcher.next_calendar=4
        self.assertEqual(self.watcher.wait_timeout(),2)
        self.clock=10
        self.assertEqual(self.watcher.wait_timeout(),0)
        self.watcher.stop()
        self.assertIsNone(self.watcher.wait_timeout())

    def test_scan_rotation_bounds_telemetry_and_preserves_action_journal(self):
        journal=self.root/'action-log.json'
        journal.write_text('{"actions": []}')
        record={'scan':'x'*80}
        with patch.object(host,'SCAN_LOG_BYTES',100):
            for _ in range(20):host.append_scan(self.root,record)
        files=list(self.root.glob('persistent-scans.jsonl*'))
        self.assertEqual(len(files),3)
        for file in files:
            self.assertLessEqual(file.stat().st_size,100)
            self.assertEqual(json.loads(file.read_text()),record)
        self.assertEqual(journal.read_text(),'{"actions": []}')

    def test_real_native_process_releases_ownership_and_keeps_stop_reason(self):
        native=self.root/'live-watcher/native'
        native.mkdir(parents=True)
        for name in ('host.py','actions.py','calendar_sync.py'):
            shutil.copyfile(BASE/'native'/name,native/name)
        shutil.copyfile(BASE.parent/'workflow.py',self.root/'workflow.py')
        origin='chrome-extension://offline-test/'
        (native/'installed-origin.json').write_text(json.dumps({'origin':origin}))
        frames=io.BytesIO()
        for message in ({'type':'start'},{'type':'stop','reason':'Stopped by user'}):
            host.write_frame(frames,message)
        result=subprocess.run([sys.executable,str(native/'host.py'),origin],
                              input=frames.getvalue(),capture_output=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        output=io.BytesIO(result.stdout);messages=[]
        while True:
            message=host.read_frame(output)
            if message is None:break
            messages.append(message)
        self.assertEqual(messages[-1]['health']['blocker'],'Stopped by user')
        self.assertEqual(json.loads((self.root/'persistent-health.json').read_text())['blocker'],'Stopped by user')
        self.assertEqual(json.loads((self.root/'workflow-run.json').read_text())['status'],'finished')

    def test_not_reentrant_and_delay_begins_after_completion(self):
        self.watcher.start();self.watcher.tick();self.clock=15;self.watcher.tick()
        self.assertEqual(sum(x['type']=='scan' for x in self.messages),1)
        self.watcher.snapshot(self.snapshot());self.clock=19.99;self.watcher.tick()
        self.assertEqual(sum(x['type']=='scan' for x in self.messages),1)
        self.clock=20;self.watcher.tick()
        self.assertEqual(sum(x['type']=='scan' for x in self.messages),2)

    def test_unchanged_and_ineligible_do_not_repeatedly_notify(self):
        self.watcher.start();self.watcher.tick();self.watcher.snapshot(self.snapshot('Physics GCSE - Example Student (Parent)'))
        self.assertFalse(self.messages[-1]['notify'])
        self.clock=5;self.watcher.tick();self.watcher.snapshot(self.snapshot('Physics GCSE - Example Student (Parent)'))
        self.assertEqual(self.messages[-1]['type'],'health');self.assertFalse(self.messages[-1]['notify'])
        self.clock=10;self.watcher.tick();self.watcher.snapshot(self.snapshot())
        self.assertTrue(self.messages[-1]['notify'])

    def test_timeout_stops_and_releases_without_retry(self):
        self.watcher.start();self.watcher.tick();self.clock=35;self.watcher.tick()
        self.assertIsNone(self.watcher.token);self.assertIsNone(self.watcher.due)
        self.clock=100;self.watcher.tick()
        self.assertEqual(sum(x['type']=='scan' for x in self.messages),1)

    def test_ownership_contention_does_not_steal(self):
        self.watcher.start();token=self.watcher.token
        other=host.Host(self.messages.append,self.root)
        with self.assertRaises(ValueError):other.start()
        self.assertEqual(host.workflow.load(self.root/'workflow-run.json',{})['token'],token)

    def test_wrong_account_and_unsolicited_snapshot_rejected(self):
        with self.assertRaises(ValueError):self.watcher.snapshot(self.snapshot())
        self.watcher.start();self.watcher.tick();message=self.snapshot();message['snapshot']['account']='Other'
        with self.assertRaises(ValueError):self.watcher.snapshot(message)

    def test_ambiguous_heading_requires_inspection(self):
        message=self.snapshot('Maths - unknown level')
        self.assertTrue(host.inspect_snapshot(message['snapshot'],self.policy)['tutor_requests']['needs_inspection'])


    def begin_simulated_introduction(self):
        self.watcher.start(protocol=2);self.watcher.tick()
        message=self.snapshot()
        heading=message['snapshot']['tutor_requests']['headings'][0]
        message['snapshot']['tutor_requests']['cards']=[{'heading':heading,'text':heading+' Please help Send a replyDecline'}]
        self.watcher.snapshot(message)
        command=next(m for m in self.messages if m['type']=='introduce')
        return message,command

    def test_completed_introduction_resumes_next_scan_without_resending(self):
        message,command=self.begin_simulated_introduction()
        self.watcher.introduction_result({'action_id':command['action_id'],'status':'completed','evidence':{
            'message':command['details']['message'],'sent_count':1,'delivery':'Delivered',
            'conversation_url':'https://www.mytutor.co.uk/tutors/secure/chat.html?id=123',
            'requests_restored':True}})
        self.assertEqual(self.watcher.status,'watching')
        self.clock=4.99;self.watcher.tick();self.assertEqual(sum(m['type']=='scan' for m in self.messages),1)
        self.clock=5;self.watcher.tick();self.assertEqual(sum(m['type']=='scan' for m in self.messages),2)
        self.watcher.snapshot(message)
        self.assertEqual(sum(m['type']=='introduce' for m in self.messages),1)
        self.assertEqual(host.workflow.ledger(self.root)['actions'][0]['status'],'completed')

    def test_return_failure_keeps_completed_send_but_stops_scanning(self):
        _,command=self.begin_simulated_introduction()
        self.watcher.introduction_result({'action_id':command['action_id'],'status':'completed','evidence':{
            'message':command['details']['message'],'sent_count':1,'delivery':'Delivered',
            'conversation_url':'https://www.mytutor.co.uk/tutors/secure/chat.html?id=123',
            'restore_error':'Requests failed to load'}})
        self.assertEqual(self.watcher.status,'stopped');self.assertIsNone(self.watcher.token)
        self.assertEqual(host.workflow.ledger(self.root)['actions'][0]['status'],'completed')
        self.clock=100;self.watcher.tick();self.assertEqual(sum(m['type']=='scan' for m in self.messages),1)


if __name__=='__main__':unittest.main()
