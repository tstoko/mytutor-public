# Local watcher

The watcher consists of a browser extension and a native messaging helper. The
extension reads the signed-in account's request page. The helper schedules
scans, journals actions, and can sync confirmed meetings to the configured
calendar.

## Configuration

1. Review the sample policy in the repository root and replace its
   `YOUR_...` placeholders with verified information.
2. Replace `ACCOUNT_NAME` in the extension and its fixtures with the exact
   display name used by the account you intend to monitor.
3. Review calendar names and permissions before building or installing the
   native helper.
4. Use detection-only mode first. Do not enable live actions until you have
   verified current page behavior and recovery on your own account.

The installer requires an explicit `--approved` flag. It copies the helper and
policy into the user's application support directory and registers a native
messaging host for the extension. Inspect those changes before installation.

## Safety model

Actions are journaled before submission. Existing outgoing messages and drafts
block duplicate introductions. Uncertain outcomes require reconciliation with
the live account before retrying. Calendar creation requires a completed,
confirmed booking and checks for an existing matching event.

Automated tests use isolated fixtures. They do not send messages, change
bookings, edit calendars, or guarantee compatibility with future website
changes. Read the root `RUNBOOK.md` for local validation commands.
