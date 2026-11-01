#!/usr/bin/python3
"""Run only after explicit installation approval. No Calendar prompt or UI."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import shlex

parser=argparse.ArgumentParser()
parser.add_argument('--approved',action='store_true')
args=parser.parse_args()
if not args.approved:
    parser.error('Review the extension and native host, then authorize installation first.')
root=Path(__file__).resolve().parent
source=root/'native/uk.local.mytutor_watcher.json'
manifest=json.loads(source.read_text())
assert len(manifest['allowed_origins'])==1
base=Path.home()/'Library/Application Support/MyTutorLive'
runtime=base/'runtime'
# Stop before upgrades; never copy over an active journal or lease.
for state_root in (root.parent,runtime):
    lease=state_root/'workflow-run.json'
    if lease.exists() and json.loads(lease.read_text()).get('status')=='running':
        raise SystemExit('Stop the existing owned watcher before installing/upgrading.')
(runtime/'live-watcher/native').mkdir(parents=True,exist_ok=True)
for name in ('workflow.py','mytutor-policy.json'):
    shutil.copyfile(root.parent/name,runtime/name)
for name in ('action-log.json','workflow-run.json','health.json','run-results.jsonl'):
    old=root.parent/name;new=runtime/name
    if old.exists() and not new.exists():shutil.copyfile(old,new)
for name in ('host.py','actions.py','calendar_sync.py','installed-origin.json'):
    shutil.copyfile(root/'native'/name,runtime/'live-watcher/native'/name)
host=runtime/'live-watcher/native/host.py';host.chmod(0o700)
launcher=base/'launch-host'
launcher.write_text('#!/bin/sh\nexec /usr/bin/python3 '+shlex.quote(str(host))+' "$@" 2>>'+shlex.quote(str(base/'native-stderr.log'))+'\n')
launcher.chmod(0o700)
(root.parent/'runtime-location.json').write_text(json.dumps({'root':str(runtime)},indent=2)+'\n')
manifest['path']=str(launcher)
# Brave's macOS main delegate overrides its lookup to Chrome's per-user
# directory, rather than the Brave profile directory used on Linux.
# https://github.com/brave/brave-core/blob/master/app/brave_main_delegate.cc
destination=Path.home()/'Library/Application Support/Google/Chrome/NativeMessagingHosts'/source.name
destination.parent.mkdir(parents=True,exist_ok=True)
if destination.exists():
    existing=json.loads(destination.read_text())
    if existing.get('name')!=manifest['name'] or existing.get('allowed_origins')!=manifest['allowed_origins']:
        raise SystemExit('Existing different host identity; inspect before replacement.')
destination.write_text(json.dumps(manifest,indent=2)+'\n')
destination.chmod(0o600)
calendar_source=Path('/private/tmp/mytutor-live-review/MyTutor Calendar Helper.app')
calendar_destination=Path.home()/'Library/Application Support/MyTutorLive/MyTutor Calendar Helper.app'
if calendar_source.exists():
    calendar_destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copytree(calendar_source,calendar_destination,dirs_exist_ok=True,copy_function=shutil.copyfile)
    (calendar_destination/'Contents/MacOS/CalendarHelper').chmod(0o755)
    for attr in ('com.apple.FinderInfo','com.apple.ResourceFork'):
        subprocess.run(['xattr','-dr',attr,str(calendar_destination)],capture_output=True)
    subprocess.run(['codesign','--verify','--deep','--strict',str(calendar_destination)],check=True)
print(json.dumps({'registered_native_host':str(destination),'extension_directory':str(root/'extension'),'extension_installed':False,'calendar_helper':str(calendar_destination)}))
