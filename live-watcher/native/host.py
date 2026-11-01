#!/usr/bin/python3
"""Brave native-messaging host. Local timer and journal; no website requests."""
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import signal
import struct
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import workflow
from actions import Introductions
from calendar_sync import sync_confirmed

MAX_FRAME = 512 * 1024
INTERVAL = 5.0
SCAN_LOG_BYTES = 2 * 1024 * 1024
SCAN_LOG_BACKUPS = 2


def append_scan(root, record):
    # Scan telemetry is bounded; action journals are never rotated or pruned.
    path = root/'persistent-scans.jsonl'
    raw = (json.dumps(record)+'\n').encode('utf8')
    if path.exists() and path.stat().st_size + len(raw) > SCAN_LOG_BYTES:
        for index in range(SCAN_LOG_BACKUPS, 0, -1):
            source = path if index == 1 else path.with_name(path.name+f'.{index-1}')
            if source.exists():
                os.replace(source, path.with_name(path.name+f'.{index}'))
    with path.open('ab') as out:
        out.write(raw); out.flush(); os.fsync(out.fileno())


def read_exact(stream, length):
    data = b''
    while len(data) < length:
        block = stream.read(length-len(data))
        if not block:
            if not data:
                return None
            raise ValueError('Truncated native message')
        data += block
    return data


def read_frame(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack('=I', header)[0]
    if not 0 < size <= MAX_FRAME:
        raise ValueError('Invalid native-message size')
    raw = read_exact(stream, size)
    if raw is None:
        raise ValueError('Truncated native-message body')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('Expected native-message object')
    return value


def write_frame(stream, value):
    raw = json.dumps(value, ensure_ascii=False).encode('utf8')
    if len(raw) > MAX_FRAME:
        raise ValueError('Response exceeds limit')
    stream.write(struct.pack('=I', len(raw)) + raw)
    stream.flush()


def fingerprint(text):
    return hashlib.sha256(re.sub(r'\s+', ' ', text).strip().encode()).hexdigest()


def classify_heading(heading, policy):
    # Positive eligibility is only a candidate for inspection, never permission
    # to send or accept. Keep unknown headings actionable for manual inspection.
    match = re.fullmatch(r'(.+?)\s+(GCSE|AS-level|A-level|KS1|KS2|KS3|11-plus|13-plus)\s+-\s+(.+)', heading.strip())
    if not match:
        return 'unknown'
    return 'candidate' if match[1] in policy['subjects'] else 'ineligible'


def inspect_snapshot(snapshot, policy):
    if snapshot.get('account') != policy['tutor_background']['mytutor_display_name']:
        raise ValueError('Account verification failed')
    if snapshot.get('url') != 'https://www.mytutor.co.uk/tutors/secure/marketplace.html':
        raise ValueError('Unexpected website location')
    result = {}
    for name in ('matching_team', 'tutor_requests'):
        panel = snapshot[name]
        if not isinstance(panel.get('text'), str) or not panel['text'].strip():
            raise ValueError('Empty/unloaded request panel')
        headings = panel.get('headings')
        if not isinstance(headings, list) or any(not isinstance(x, str) for x in headings):
            raise ValueError('Invalid request headings')
        # Matching team includes a static New requests heading. Do not confuse
        # it with a meeting. Unknown nonempty layouts still trigger inspection.
        headings = [h for h in headings if h != 'New requests']
        empty = "Ah shucks, there's nothing to see here" in panel['text']
        candidates = [h for h in headings if classify_heading(h, policy) != 'ineligible']
        result[name] = {'sha256': fingerprint(panel['text']), 'text':panel['text'],
                        'headings':headings, 'candidate_headings':candidates,
                        'needs_inspection':bool(candidates) or (not headings and not empty)}
    return result


class Host:
    def __init__(self, send, root=ROOT, clock=time.monotonic):
        self.root, self.send, self.clock = root, send, clock
        self.token = None
        self.due = None
        self.deadline = None
        self.last_scan = None
        self.scans = 0
        self.status = 'stopped'
        self.blocker = None
        self.actions = Introductions(root)
        self.action_mode = False
        self.next_calendar = 0
        self.calendar_failure = None
        self.action_ids = []

    def start(self, protocol=1):
        if self.token:
            return
        self.token = workflow.acquire(self.root)['token']
        self.action_mode = protocol == 2
        self.status = 'watching'
        self.blocker = None
        self.due = self.clock()
        self.send({'type':'health','health':{'status':self.status,'mode':self.mode()}})

    def mode(self):
        return 'automatic_introductions' if self.action_mode else 'detection_only'

    def wait_timeout(self):
        # Incoming browser messages wake Queue.get immediately. Otherwise sleep
        # until actual work is due, rather than polling five times per second.
        times = [value for value in (self.due, self.deadline) if value is not None]
        if self.token and self.action_mode and self.deadline is None:
            times.append(self.next_calendar)
        return max(0.0, min(times)-self.clock()) if times else None

    def stop(self, reason=None):
        self.status = 'stopped'
        self.blocker = reason
        self.due = self.deadline = None
        workflow.atomic_json(self.root/'persistent-health.json', {
            'status':'stopped','blocker':reason,'observed_at':workflow.now(),
            'mode':self.mode(),'scan_count':self.scans})
        if self.token:
            try:
                self.actions.uncertain(self.token, reason or 'Watcher stopped before an action result')
                workflow.record_run(self.token, {'status':'blocked' if reason else 'success',
                    'fresh_check_verified':self.scans > 0, 'executor':'persistent_native_watcher',
                    'scan_count':self.scans, 'blockers':[reason] if reason else [],
                    'mode':self.mode(),'action_ids':self.action_ids,'pending_calendar_actions':[]}, self.root)
            finally:
                workflow.release(self.token, self.root)
                self.token = None

    def tick(self):
        current = self.clock()
        if self.token and self.action_mode and self.deadline is None and current>=self.next_calendar:
            results=sync_confirmed(self.token,self.root)
            failures=[r for r in results if r.get('success') is not True]
            self.next_calendar=self.clock()+(60 if failures else 900)
            if failures and failures!=self.calendar_failure:
                self.send({'type':'calendar_notice','summary':'A confirmed meeting needs calendar sync: '+str(failures[0].get('blocker','Calendar save failed'))})
            elif results and not failures:
                self.send({'type':'calendar_notice','summary':'Verified calendar sync for confirmed free MyTutor meeting.'})
            self.calendar_failure=failures
        current = self.clock()
        if self.deadline is not None and current >= self.deadline:
            self.stop('Browser operation timed out; inspect before restarting.')
            self.send({'type':'health','health':{'status':'stopped','blocker':self.blocker}})
        if self.due is not None and current >= self.due:
            self.due = None
            self.deadline = current + 35
            self.send({'type':'scan'})

    def snapshot(self, message):
        if not self.token or self.deadline is None:
            raise ValueError('Unsolicited snapshot without an owned scan')
        policy = workflow.load(self.root/'mytutor-policy.json', None)
        panels = inspect_snapshot(message['snapshot'], policy)
        previous = workflow.load(self.root/'persistent-watch-state.json', {'panels':{}})
        changed = [name for name, panel in panels.items()
                   if previous['panels'].get(name, {}).get('sha256') != panel['sha256']]
        stamp = workflow.now()
        first_seen = previous.get('first_seen', {})
        for panel in panels.values():
            first_seen.setdefault(panel['sha256'], message['snapshot']['observed_at'])
        first_seen = {key:first_seen[key] for key in list(first_seen)[-1000:]}
        needs_inspection = [name for name in changed if panels[name]['needs_inspection']]
        record = {'started_at':message['started_at'],'finished_at':message['finished_at'],
                  'received_at':stamp,'changed_panels':changed,
                  'gap_seconds':None if self.last_scan is None else self.clock()-self.last_scan,
                  'mode':self.mode(),'external_actions':0}
        workflow.atomic_json(self.root/'persistent-watch-state.json', {
            'account':message['snapshot']['account'],'observed_at':stamp,'panels':panels,
            'first_seen':first_seen,'last_scan':record})
        append_scan(self.root, record)
        self.scans += 1
        self.last_scan = self.clock()
        self.deadline = None
        self.due = self.clock()+INTERVAL
        health = {'status':'watching','mode':self.mode(),'last_scan':stamp,'scan_count':self.scans,
                  'changed_panels':changed,'needs_inspection':needs_inspection}
        workflow.atomic_json(self.root/'persistent-health.json',health)
        self.send({'type':'changed' if changed else 'health','health':health,
                   'notify':bool(needs_inspection),
                   'summary':'New or changed request content needs review. No action has been submitted.'})
        if self.action_mode:
            command = self.actions.next(self.token,message['snapshot']['tutor_requests'].get('cards',[]))
            if command:
                self.due = None
                self.deadline = self.clock()+90
                self.action_ids.append(command['action_id'])
                self.send(command)

    def introduction_result(self,message):
        status=self.actions.result(self.token,message)
        self.deadline=None
        if status=='needs_review' or (message['evidence'].get('restore_error') or message['evidence'].get('stop')):
            self.stop(message['evidence'].get('reason') or message['evidence'].get('restore_error') or 'Introduction outcome needs inspection; no retry')
            self.send({'type':'health','health':{'status':'stopped','blocker':self.blocker}})
        else:
            self.due=self.clock()+INTERVAL



def main():
    # Chrome enforces allowed_origins; additionally match the single installed
    # extension. Never run as a generic server or accept browser/page commands.
    config = workflow.load(Path(__file__).with_name('installed-origin.json'), {})
    if len(sys.argv) < 2 or sys.argv[1] != config.get('origin'):
        raise SystemExit('Native host origin not registered')
    write_frame(sys.stdout.buffer, {'type':'ready'})
    # Backpressure bounds queued snapshots if journal or Calendar work is slow.
    messages = queue.Queue(maxsize=4)
    def reader():
        try:
            while True:
                message = read_frame(sys.stdin.buffer)
                messages.put(message)
                if message is None:
                    return
        except Exception as error:
            messages.put({'type':'error','blocker':str(error)})
            messages.put(None)
    threading.Thread(target=reader, daemon=True).start()
    host = Host(lambda value: write_frame(sys.stdout.buffer, value))
    def interrupted(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        while True:
            try:
                message = messages.get(timeout=host.wait_timeout())
            except queue.Empty:
                host.tick(); continue
            if message is None:
                break
            try:
                kind = message.get('type')
                if kind == 'start': host.start(message.get('protocol',1))
                elif kind == 'stop':
                    host.stop(message.get('reason'))
                    host.send({'type':'health','health':{'status':'stopped','blocker':host.blocker}})
                    break
                elif kind == 'snapshot': host.snapshot(message)
                elif kind == 'introduction_result': host.introduction_result(message)
                elif kind == 'error': host.stop(message['blocker']); break
                else: raise ValueError('Unsupported native command')
                host.tick()
            except Exception as error:
                host.stop(str(error))
                host.send({'type':'health','health':{'status':'stopped','blocker':str(error)}})
                break
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        if host.token:
            host.stop('Browser connection closed')


if __name__ == '__main__':
    main()
