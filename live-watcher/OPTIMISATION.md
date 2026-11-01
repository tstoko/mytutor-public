# Background resource optimisation — 28 October 2026

Version 0.3.4 changes the local source only. The installed native runtime has not
been upgraded, the extension has not been reloaded, and monitoring has not been
started. No live sends, bookings or Calendar writes were used for validation.

## Changes

- The helper blocks on incoming messages until the next scan, timeout or Calendar
  check is due. It previously woke every 200 ms. A five-second idle interval now
  needs one timer wake instead of about 25; browser messages still wake it
  immediately. Scan cadence, operation timeouts and Calendar retries are retained.
- The native input queue holds at most four messages instead of growing without
  a limit when work is slow. The reader applies backpressure without dropping
  messages. Each incoming frame already has a 512 KiB limit.
- Empty and ineligible scans avoid loading the action journal. Eligible requests
  still read the current policy and current validated journal before starting an
  action. The journal is not cached or pruned.
- A stopped health response disconnects the native keepalive after ownership has
  been released. The process can exit and the browser can reclaim the idle
  extension worker. Stop reasons survive both disconnect races and process exit.
- Scan telemetry rotates at 2 MiB with two backups, rather than growing forever.
  Existing oversized files are preserved as backups until rotated out. Action
  journals are never rotated. Health, state and journal durability are retained.
- Health remains current on every scan, but an unchanged badge is not redrawn.
  Panel reading also reuses its list of visible headings.

## Offline measurements

`profile_idle.py` runs the real Host against a temporary policy and journal,
using empty snapshots and a simulated clock. It never opens a browser or touches
the installed runtime. Each comparison ran in a separate `/usr/bin/python3`
process on the same Mac. These are single-run diagnostic figures, not guarantees.

Across 600 empty scans (50 simulated minutes), journal reads dropped from 604 to
4. The remaining reads are the existing Calendar reconciliation checks.

With an empty journal, measured CPU time was 0.613 seconds before and 0.549 seconds
after. Peak process RSS was approximately 18 MB in both versions. With 1,000
synthetic historical entries containing 1,000-byte evidence fields, CPU time was
4.201 seconds before and 0.630 seconds after; peak RSS was approximately 23–24 MB
in both versions. The Calendar check still loads that journal, so the change
reduces repeated allocation and parsing rather than its peak allocation.

These measurements include profiling overhead, exclude Brave and the MyTutor
page, and do not measure real-time idle CPU or sustained browser memory growth.
The process-name snapshot showed no running Python watcher, so there was no
active watcher session to profile. Brave renderer processes cannot be attributed
to individual tabs from process names alone.

Repeat the isolated profiles with:

```sh
python3 live-watcher/profile_idle.py
python3 live-watcher/profile_idle.py --journal-entries 1000
```

Use `--source-root /absolute/path/to/saved/source` to profile an older source tree
in a separate process. No baseline source tree is required for normal operation.

Validation passed: 41 Python tests and 35 Node tests. Coverage includes the real
native subprocess handshake/stop/exit against an isolated runtime, deadline
selection, bounded scan-log rotation, fresh journal validation before eligible
actions, native disconnection races, and the existing offline send/confirmation/
restoration safeguards. Run with:

```sh
python3 -m unittest test_workflow.py test_relay.py live-watcher/test_host.py live-watcher/test_actions.py
node --test live-watcher/test_sandbox.cjs live-watcher/test_background.cjs live-watcher/test_actions.cjs
```

## Remaining limits and choices

### Follow-up memory check — 28 October 2026

Brave Task Manager identified the Requests tab as renderer PID 92472 and reported
a memory footprint of 308 MB, CPU 0.5, and zero network traffic at that instant.
The page URL was subsequently verified as the marketplace URL. The installed
watcher was stopped, with its run finished; no matching worker was visible in
the filtered Task Manager view. Its active-scanning memory therefore remains
unmeasured. No live monitoring or automatic actions were started for this check.

A separate 60.2-second check ran the saved pre-optimisation and current native
hosts in isolated temporary runtimes with fake empty snapshots, protocol 1
(detection only), and no browser connection. Six OS samples were taken at
5, 15, 25, 35, 45 and 55 seconds. Both hosts settled at about 10.2 MiB resident
RAM. CPU-time increments over those 50 seconds were 0.07 seconds before and
0.05 seconds after; both are very small and the timer resolution/sample length
does not support a strong percentage-saving claim. This check confirms no
meaningful reduction in steady resident helper memory. It does not test Calendar
work or action execution.

During that same sampling window, the identified MyTutor renderer ranged from
67.7 to 100.6 MiB of OS resident memory and accumulated 0.09 seconds of CPU time.
Brave's memory-footprint counter and OS RSS are different metrics and must not be
added or compared as if interchangeable. A short changing RSS sample does not
establish a leak or long-term growth.

The original instrumented profiles were also rerun: 600 empty scans loaded the
journal four times, with peak process RSS of 18.1 MB for an empty journal and
22.9 MB for 1,000 synthetic historical entries. These include the profiling
process and instrumentation, explaining why they exceed the uninstrumented
helper's steady resident measurements. The approximately 85% CPU reduction
previously reported applies only to the synthetic history-heavy offline workload,
not total browser use or ordinary idle operation.

### Architectural limits

The current design reloads the signed-in MyTutor Requests tab and checks both
panels after every five-second wait. It needs Brave and that page resident. A
language change does not remove either cost. Avoiding reloads requires evidence
of a reliable live update mechanism; merely observing an unchanged DOM would
miss requests if the website is not updating it.

The native connection keeps the extension worker alive while watching, and
five-second scanning leaves too little idle time for normal worker suspension.
Chrome's standard alarm minimum is 30 seconds, so replacing the helper with
alarms would change detection latency. A slower scan mode is a separate product
choice, not an optimisation included in this version.

Rust could reduce the native interpreter footprint if a lower absolute RAM
budget is needed. These results do not establish a large memory saving from the
current changes or justify moving the DOM adapter into WebAssembly. First
measure the MyTutor tab, worker and helper separately during a user-started
watching session; then take a longer sample to look for growth. Preserve the
existing no-send restriction unless the user explicitly changes it.

Chrome references: [worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
and [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
