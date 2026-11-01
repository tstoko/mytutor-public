#!/usr/bin/python3
"""Offline empty-scan memory profile. No browser, installed state or network access.

Use --source-root to compare a saved source tree in a separate Python process.
The optional synthetic journal models history growth; it never authorises sends.
"""
import argparse
import gc
import importlib.util
import json
from pathlib import Path
import resource
import sys
import tempfile
import time
import tracemalloc


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--scans',type=int,default=600)
    parser.add_argument('--journal-entries',type=int,default=0)
    args=parser.parse_args()
    if args.scans<1 or args.journal_entries<0:parser.error('Invalid profile size')
    source=args.source_root.resolve()
    sys.path[:0]=[str(source),str(source/'live-watcher/native')]
    spec=importlib.util.spec_from_file_location('profiled_host',source/'live-watcher/native/host.py')
    host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
    with tempfile.TemporaryDirectory(prefix='mytutor-offline-profile-') as folder:
        root=Path(folder)
        (root/'mytutor-policy.json').write_bytes((source/'mytutor-policy.json').read_bytes())
        (root/'action-log.json').write_text(json.dumps({'actions':[
            {'id':str(i),'entity_id':'historical:'+str(i),'kind':'introduction',
             'status':'completed','details':{},'evidence':'x'*1000}
            for i in range(args.journal_entries)]}))
        loads=0
        original_load=host.workflow.load
        def counted_load(path,default):
            nonlocal loads
            if path.name=='action-log.json':loads+=1
            return original_load(path,default)
        host.workflow.load=counted_load
        now=[0.0]
        def reject_action(message):
            if message['type']=='introduce':raise AssertionError('Profile must never submit an action')
        watcher=host.Host(reject_action,root,lambda:now[0])
        empty={'text':"Ah shucks, there's nothing to see here",'headings':[],'cards':[]}
        stamp='2026-10-28T00:00:00+00:00'
        message={'started_at':stamp,'finished_at':stamp,'snapshot':{
            'account':'ACCOUNT_NAME','url':'https://www.mytutor.co.uk/tutors/secure/marketplace.html',
            'observed_at':stamp,'matching_team':empty,'tutor_requests':empty}}
        gc.collect();tracemalloc.start();start=time.process_time()
        watcher.start(protocol=2)
        try:
            for i in range(args.scans):
                now[0]=i*host.INTERVAL
                watcher.tick();watcher.snapshot(message)
            gc.collect()
            retained,peak=tracemalloc.get_traced_memory()
            result={'scans':args.scans,'synthetic_journal_entries':args.journal_entries,
                    'journal_loads':loads,'python_retained_bytes':retained,
                    'python_peak_bytes':peak,'cpu_seconds':round(time.process_time()-start,3),
                    'process_peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)}
        finally:watcher.stop('Offline profile completed')
        print(json.dumps(result,indent=2))


if __name__=='__main__':main()
