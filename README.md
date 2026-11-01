# MyTutor request watcher

A local browser extension and native helper for monitoring tutoring requests,
recording workflow actions, and optionally syncing confirmed meetings to a
calendar. The project is designed for local use and must be configured for the
account, calendar, and permissions of the person installing it.

## Before use

- Review `mytutor-policy.json` and replace every `YOUR_...` value with your own
  verified details. Keep this file private if it contains personal information.
- Set the account display name expected by the extension in `ACCOUNT_NAME`
  references before loading it.
- Load the unpacked extension once, then set its generated ID in
  `live-watcher/native/uk.local.mytutor_watcher.json` before installation.
- Review the website's terms and your employer/platform rules before enabling
  automated actions.
- Start in detection-only mode. Verify the live page and recovery behavior
  before enabling any action that sends a message or changes a calendar.

## Components

- `live-watcher/extension/` reads the active request page and coordinates
  actions through a native messaging host.
- `live-watcher/native/` handles scheduling, journaling, and calendar sync.
- `workflow.py` validates eligibility and records action ownership and results.
- `mytutor-policy.json` is a sample policy, not a verified profile.

Run the isolated test suites with the commands listed in `RUNBOOK.md`. Tests
use fixtures and do not verify current website behavior or authorize real
messages, acceptances, or calendar changes.
