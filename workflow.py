#!/usr/bin/env python3
"""Local journal and exclusive run ownership; never interacts with websites or UI."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import tempfile
import uuid
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
# The installed native helper keeps its own files outside macOS-protected
# Documents. Project-side journal commands share that same ownership/state.
_runtime_location = ROOT / 'runtime-location.json'
if _runtime_location.exists():
    _runtime_root = Path(json.loads(_runtime_location.read_text())['root'])
    _expected_runtime = Path.home() / 'Library/Application Support/MyTutorLive/runtime'
    if _runtime_root != _expected_runtime:
        raise ValueError('Unexpected installed runtime location')
    ROOT = _runtime_root
KINDS = {'introduction', 'acceptance', 'calendar_create', 'calendar_update', 'calendar_cancel'}
CALENDARS = {'Tutoring', 'General', 'Other'}
LEVELS = {'KS1', 'KS2', 'KS3', '11-plus', '13-plus', 'GCSE', 'AS-level', 'A-level'}


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def transaction(root):
    with (root / 'workflow.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def load(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def ledger(root):
    value = load(root / 'action-log.json', {'actions': []})
    if not isinstance(value, dict) or not isinstance(value.get('actions'), list):
        raise ValueError('Malformed action log; preserve and reconcile it')
    if any(not isinstance(a, dict) or not all(k in a for k in ('id', 'kind', 'entity_id', 'status', 'details')) or a.get('status') not in {'pending', 'needs_review', 'completed', 'not_performed'} or a.get('kind') not in KINDS or not isinstance(a.get('details'), dict) for a in value['actions']):
        raise ValueError('Unrecognised action records; migration/reconciliation required')
    return value


def owner(root, token):
    run = load(root / 'workflow-run.json', {})
    if not token or run.get('token') != token or run.get('status') != 'running':
        raise ValueError('Run ownership required')
    return run


def acquire(root=ROOT):
    with transaction(root):
        run = load(root / 'workflow-run.json', {})
        if run.get('status') == 'running':
            raise ValueError('Another run owns the workflow; never automatically steal an old lease')
        token = str(uuid.uuid4())
        atomic_json(root / 'workflow-run.json', {'token': token, 'status': 'running', 'started_at': now()})
        return {'token': token}


def release(token, root=ROOT):
    with transaction(root):
        run = owner(root, token)
        run.update(status='finished', finished_at=now())
        atomic_json(root / 'workflow-run.json', run)


def instant(value):
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError('An explicit UTC offset is required')
    local = dt.astimezone(ZoneInfo('Europe/London'))
    if dt.utcoffset() != local.utcoffset():
        raise ValueError('Offset does not match Europe/London on this date')
    return dt.astimezone(timezone.utc)


def interval(details):
    start, end = instant(details['start']), instant(details['end'])
    if end <= start:
        raise ValueError('Meeting end must be after start')
    return start, end


def calendar_revision(details):
    # Observation timestamps/evidence can change without changing the requested event.
    return {key: value for key, value in details.items() if key not in {'availability', 'evidence', 'observed_at'}}


def check_slot(details):
    start, end = interval(details)
    availability = details['availability']
    if set(availability['calendars_checked']) != CALENDARS or availability.get('bookings_checked') is not True:
        raise ValueError('All three calendars and current MyTutor bookings must be checked')
    checked = datetime.fromisoformat(availability['checked_at'])
    if checked.tzinfo is None:
        raise ValueError('Conflict-check timestamp needs an offset')
    age = (datetime.now(timezone.utc) - checked).total_seconds()
    if not 0 <= age <= 60:
        raise ValueError('Conflict checks must be no more than 60 seconds old')
    if availability.get('complete') is not True:
        raise ValueError('Incomplete or ambiguous conflict data; do not accept')
    for busy in availability['busy_intervals']:
        busy_start, busy_end = instant(busy['start']), instant(busy['end'])
        if busy_end < busy_start:
            raise ValueError('Invalid busy interval')
        if (busy_start == busy_end and start <= busy_start < end) or (busy_start < end and start < busy_end):
            raise ValueError('Meeting clashes with a calendar event or booking')
    return {'available': True, 'checked_at': availability['checked_at']}


def begin(token, kind, entity_id, details, root=ROOT):
    if kind not in KINDS or not isinstance(entity_id, str) or not entity_id.strip():
        raise ValueError('Supported action kind and verified stable entity ID required')
    if not isinstance(details, dict):
        raise ValueError('Action details must be an object')
    if kind in {'introduction', 'acceptance'}:
        policy = load(root / 'mytutor-policy.json', None)
        if policy is None or details.get('subject') not in policy['subjects'] or details.get('level') not in LEVELS:
            raise ValueError('Exact eligible subject and supported level required; other levels need explicit review')
    if kind == 'introduction' and not details.get('message'):
        raise ValueError('Persist the exact proposed message')
    if kind != 'introduction':
        start, end = interval(details)
        if kind == 'acceptance':
            if start <= datetime.now(timezone.utc):
                raise ValueError('Cannot accept a past meeting')
            if details.get('free_meeting') is not True:
                raise ValueError('Only explicitly verified free meetings may be accepted')
            check_slot(details)
        if not details.get('booking_link'):
            raise ValueError('Verified MyTutor booking/request link required')
        if kind.startswith('calendar_') and (details.get('confirmed') is not True or details.get('calendar') != 'Tutoring'):
            raise ValueError('Calendar actions require a confirmed booking and Tutoring destination')
        if kind in {'calendar_update', 'calendar_cancel'} and not details.get('event_id'):
            raise ValueError('Existing verified calendar event identity required')
    with transaction(root):
        owner(root, token)
        value = ledger(root)
        related = [a for a in value['actions'] if a['entity_id'] == entity_id]
        same = [a for a in related if a['kind'] == kind]
        # An uncertain send/acceptance/create must be reconciled, never replayed.
        if any(a['status'] in {'pending', 'needs_review'} for a in related):
            raise ValueError('Uncertain action exists for this entity; reconcile live state first')
        if kind in {'introduction', 'acceptance', 'calendar_create'} and any(a['status'] == 'completed' for a in same):
            raise ValueError('Action already completed; do not repeat it')
        if kind in {'calendar_update', 'calendar_cancel'} and any(a['status'] == 'completed' and calendar_revision(a['details']) == calendar_revision(details) for a in same):
            raise ValueError('This calendar revision already completed')
        if kind == 'calendar_create' and any(a['kind'] == 'calendar_cancel' and a['status'] == 'completed' for a in related):
            raise ValueError('Cancelled booking requires explicit live reconciliation')
        record = {'id': str(uuid.uuid4()), 'kind': kind, 'entity_id': entity_id, 'details': details,
                  'status': 'pending', 'started_at': now(), 'run_token': token}
        value['actions'].append(record)
        atomic_json(root / 'action-log.json', value)
        return record


def resolve(token, action_id, status, evidence, root=ROOT):
    if status not in {'completed', 'needs_review', 'not_performed'} or not evidence.strip():
        raise ValueError('Resolution status and concrete live-state evidence required')
    with transaction(root):
        owner(root, token)
        value = ledger(root)
        record = next((a for a in value['actions'] if a['id'] == action_id), None)
        if record is None or record['status'] not in {'pending', 'needs_review'}:
            raise ValueError('Only unresolved actions can be resolved')
        record.update(status=status, evidence=evidence, resolved_at=now())
        atomic_json(root / 'action-log.json', value)
        return record


def resume_calendar(token, action_id, root=ROOT):
    """Transfer only a calendar retry under a newly acquired exclusive lease.

    EventKit will first reconcile the stable marker, so a save interrupted before
    acknowledgement cannot produce another event. Sends/acceptances never use this.
    """
    with transaction(root):
        owner(root, token)
        value = ledger(root)
        action = next((a for a in value['actions'] if a['id'] == action_id), None)
        if not action or action['kind'] != 'calendar_create' or action['status'] not in {'pending','needs_review'}:
            raise ValueError('Only uncertain calendar creation can be resumed automatically')
        action.setdefault('retry_owners', []).append({'previous_token': action.get('run_token'), 'token':token, 'at':now()})
        action['run_token'] = token
        atomic_json(root / 'action-log.json',value)
        return action


def record_run(token, result, root=ROOT):
    with transaction(root):
        run = owner(root, token)
        if result.get('status') not in {'success', 'blocked', 'failed'}:
            raise ValueError('Explicit run status required')
        if result['status'] == 'success' and result.get('fresh_check_verified') is not True:
            raise ValueError('Success requires a verified fresh check')
        finished = now()
        duration = (datetime.fromisoformat(finished) - datetime.fromisoformat(run['started_at'])).total_seconds()
        record = dict(result, started_at=run['started_at'], finished_at=finished, duration_seconds=duration)
        path = root / 'health.json'
        health = load(path, {})
        health['last_run'] = record
        if result['status'] == 'success':
            health['last_successful_check'] = record['finished_at']
        else:
            health['last_blocker'] = record
        health['pending_actions'] = [a['id'] for a in ledger(root)['actions'] if a['status'] in {'pending', 'needs_review'}]
        with (root / 'run-results.jsonl').open('a') as out:
            out.write(json.dumps(record) + '\n')
            out.flush()
            os.fsync(out.fileno())
        atomic_json(path, health)


def probe_gate(root=ROOT):
    required = ('account_verified', 'requests_loaded', 'tutor_requests_loaded', 'bookings_loaded', 'calendar_content_read', 'calendar_names_verified', 'success')
    path = root / 'scheduled-probes.jsonl'
    consecutive = []
    previous_end = None
    for line in path.read_text().splitlines() if path.exists() else []:
        row = json.loads(line)
        if row.get('campaign') != '2026-10-09':
            continue
        good = row.get('execution') == 'scheduled_heartbeat' and all(row.get(k) is True for k in required) and not row.get('blockers')
        try:
            start = datetime.fromisoformat(row['started_at'].replace('Z', '+00:00'))
            end = datetime.fromisoformat(row['finished_at'].replace('Z', '+00:00'))
            good = good and start.tzinfo is not None and end.tzinfo is not None and end >= start and (previous_end is None or start > previous_end)
        except (KeyError, ValueError, TypeError):
            good = False
        if good:
            consecutive.append(row)
            previous_end = end
        else:
            consecutive, previous_end = [], None
    return {'passed': len(consecutive) >= 3, 'consecutive_successes': len(consecutive), 'successful_probes': consecutive[-3:]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['acquire', 'release', 'begin', 'resolve', 'record-run', 'probe-gate'])
    parser.add_argument('--token')
    parser.add_argument('--kind')
    parser.add_argument('--entity-id')
    parser.add_argument('--input', type=Path, help='JSON action details or run results; avoids shell interpolation')
    parser.add_argument('--action-id')
    parser.add_argument('--status')
    parser.add_argument('--evidence-file', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'probe-gate':
            result = probe_gate()
        elif args.command == 'acquire':
            result = acquire()
        elif args.command == 'release':
            result = release(args.token)
        elif args.command == 'begin':
            result = begin(args.token, args.kind, args.entity_id, load(args.input, None))
        elif args.command == 'resolve':
            result = resolve(args.token, args.action_id, args.status, args.evidence_file.read_text())
        else:
            result = record_run(args.token, load(args.input, None))
        print(json.dumps(result))
    except (ValueError, OSError, TypeError, KeyError, AttributeError) as exc:
        parser.exit(1, str(exc) + '\n')


if __name__ == '__main__':
    main()
