# Local development runbook

## Validation

Run the offline Python checks from the repository root:

```sh
python3 -m unittest test_workflow.py test_relay.py live-watcher/test_host.py live-watcher/test_actions.py
```

Run the browser-extension checks with Node.js:

```sh
node --test live-watcher/test_sandbox.cjs live-watcher/test_background.cjs live-watcher/test_actions.cjs
```

These checks use temporary data and simulated pages. They do not validate a
live account or authorize external actions.

## Before installing

Review `mytutor-policy.json`, account-name checks in the extension, calendar
names in the native helper, and the permissions requested by the manifest.
Confirm each setting against the account you intend to use. Begin with
detection-only behavior and inspect the journals after each run.

## Recovery rules

- Use one exclusive workflow owner for browser and calendar operations.
- Record a pending action before submitting it.
- Verify the result from current live state. Treat timeouts and missing
  confirmations as uncertain, not as proof that an action failed.
- Reconcile uncertain actions before retrying; never replay a completed send or
  acceptance.
- Create calendar events only for confirmed bookings with verified times.
- Keep runtime journals and screenshots out of version control.
