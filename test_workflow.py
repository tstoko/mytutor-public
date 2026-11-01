from datetime import datetime, timedelta
import json
from pathlib import Path
import tempfile
import unittest

import workflow as w


class WorkflowChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'mytutor-policy.json').write_text(json.dumps({'subjects': ['Mathematics', 'Further Mathematics', 'Economics', 'Politics']}))
        self.token = w.acquire(self.root)['token']

    def tearDown(self):
        self.temp.cleanup()

    def begin(self, kind='introduction', entity='request:123', details=None):
        return w.begin(self.token, kind, entity, details or {'message': 'Exact introduction', 'subject': 'Mathematics', 'level': 'A-level'}, self.root)

    def resolve(self, action, status='completed'):
        return w.resolve(self.token, action['id'], status, 'Fresh live confirmation observed', self.root)

    def booking(self):
        start = datetime.now(w.ZoneInfo('Europe/London')) + timedelta(days=2)
        return {'start': start.isoformat(), 'end': (start + timedelta(minutes=15)).isoformat(),
                'booking_link': 'https://www.mytutor.co.uk/verified-fixture', 'confirmed': True, 'calendar': 'Tutoring', 'subject': 'Mathematics', 'level': 'A-level', 'free_meeting': True,
                'availability': {'calendars_checked': sorted(w.CALENDARS), 'bookings_checked': True, 'complete': True, 'checked_at': w.now(), 'busy_intervals': []}}

    def test_concurrent_or_crashed_run_cannot_be_stolen(self):
        with self.assertRaises(ValueError):
            w.acquire(self.root)
        with self.assertRaises(ValueError):
            w.release('wrong-owner', self.root)

    def test_interrupted_send_requires_live_resolution(self):
        action = self.begin()
        w.release(self.token, self.root)
        self.token = w.acquire(self.root)['token']
        with self.assertRaises(ValueError):
            self.begin()
        self.resolve(action, 'not_performed')
        self.begin()

    def test_completed_send_never_repeats(self):
        self.resolve(self.begin())
        with self.assertRaises(ValueError):
            self.begin()

    def test_calendar_failure_does_not_repeat_acceptance(self):
        data = self.booking()
        self.resolve(self.begin('acceptance', 'booking:1', data))
        calendar = self.begin('calendar_create', 'booking:1', data)
        self.resolve(calendar, 'needs_review')
        with self.assertRaises(ValueError):
            self.begin('acceptance', 'booking:1', data)
        self.resolve(calendar, 'not_performed')
        self.resolve(self.begin('calendar_create', 'booking:1', data))
        with self.assertRaises(ValueError):
            self.begin('acceptance', 'booking:1', data)
        with self.assertRaises(ValueError):
            self.begin('calendar_create', 'booking:1', data)

    def test_changed_booking_updates_existing_event_once(self):
        data = self.booking()
        self.resolve(self.begin('calendar_create', 'booking:1', data))
        changed = dict(data, event_id='verified-event:1', start=(datetime.fromisoformat(data['start']) + timedelta(hours=1)).isoformat(), end=(datetime.fromisoformat(data['end']) + timedelta(hours=1)).isoformat())
        self.resolve(self.begin('calendar_update', 'booking:1', changed))
        with self.assertRaises(ValueError):
            self.begin('calendar_update', 'booking:1', dict(changed, observed_at=w.now()))
        with self.assertRaises(ValueError):
            self.begin('calendar_create', 'booking:1', changed)

    def test_cancel_requires_existing_event_identity(self):
        data = self.booking()
        with self.assertRaises(ValueError):
            self.begin('calendar_cancel', 'booking:1', data)
        self.resolve(self.begin('calendar_cancel', 'booking:1', dict(data, event_id='verified-event:1')))
        with self.assertRaises(ValueError):
            self.begin('calendar_create', 'booking:1', data)

    def test_clash_and_stale_or_incomplete_checks_block_acceptance(self):
        data = self.booking()
        data['availability']['busy_intervals'] = [{'start': data['start'], 'end': data['end']}]
        with self.assertRaises(ValueError):
            self.begin('acceptance', 'booking:1', data)
        data['availability']['busy_intervals'] = []
        data['availability']['calendars_checked'] = ['Tutoring']
        with self.assertRaises(ValueError):
            self.begin('acceptance', 'booking:1', data)
        data['availability']['calendars_checked'] = sorted(w.CALENDARS)
        data['availability']['checked_at'] = '2020-01-01T00:00:00+00:00'
        with self.assertRaises(ValueError):
            self.begin('acceptance', 'booking:1', data)

    def test_adjacent_meetings_do_not_clash(self):
        data = self.booking()
        data['availability']['busy_intervals'] = [{'start': (datetime.fromisoformat(data['start']) - timedelta(hours=1)).isoformat(), 'end': data['start']}]
        self.assertTrue(w.check_slot(data)['available'])

    def test_clearly_eligible_lower_level_is_supported(self):
        self.begin(details={'message': 'Factual maths introduction', 'subject': 'Mathematics', 'level': 'KS2'})

    def test_paid_or_ambiguous_requests_are_blocked(self):
        data = self.booking()
        data['free_meeting'] = False
        with self.assertRaises(ValueError):
            self.begin('acceptance', 'booking:1', data)
        with self.assertRaises(ValueError):
            self.begin(details={'message': 'Hello', 'subject': 'Physics', 'level': 'A-level'})
        with self.assertRaises(ValueError):
            self.begin(details={'message': 'Hello', 'subject': 'Mathematics', 'level': 'Unknown'})

    def test_probe_gate_rejects_interactive_and_resets_after_failure(self):
        path = self.root / 'scheduled-probes.jsonl'
        rows = []
        for minute in range(3):
            rows.append(dict(campaign='2026-10-09', execution='scheduled_heartbeat', started_at=f'2026-10-09T12:0{minute}:00Z', finished_at=f'2026-10-09T12:0{minute}:30+00:00', account_verified=True, requests_loaded=True, tutor_requests_loaded=True, bookings_loaded=True, calendar_content_read=True, calendar_names_verified=True, success=True, blockers=[]))
        path.write_text('\n'.join(map(json.dumps, rows)))
        self.assertTrue(w.probe_gate(self.root)['passed'])
        path.write_text(path.read_text() + '\n' + json.dumps(dict(rows[-1], success=False)))
        self.assertFalse(w.probe_gate(self.root)['passed'])
        path.write_text('\n'.join(json.dumps(dict(row, execution='interactive')) for row in rows))
        self.assertFalse(w.probe_gate(self.root)['passed'])

    def test_daylight_saving_folds_are_distinct(self):
        a = w.instant('2026-10-25T01:30:00+01:00')
        b = w.instant('2026-10-25T01:30:00+00:00')
        self.assertEqual((b - a).total_seconds(), 3600)
        with self.assertRaises(ValueError):
            w.instant('2026-03-29T01:30:00+00:00')
        with self.assertRaises(ValueError):
            w.instant('2026-10-25T01:30:00')

    def test_malformed_journal_is_preserved(self):
        path = self.root / 'action-log.json'
        path.write_text('{broken')
        with self.assertRaises(ValueError):
            self.begin()
        self.assertEqual(path.read_text(), '{broken')

    def test_failed_check_does_not_replace_last_success(self):
        w.record_run(self.token, {'status': 'success', 'fresh_check_verified': True}, self.root)
        previous = json.loads((self.root / 'health.json').read_text())['last_successful_check']
        w.record_run(self.token, {'status': 'blocked', 'blocker': 'Calendar denied'}, self.root)
        self.assertEqual(json.loads((self.root / 'health.json').read_text())['last_successful_check'], previous)
        with self.assertRaises(ValueError):
            w.record_run(self.token, {'status': 'success'}, self.root)


if __name__ == '__main__':
    unittest.main()
