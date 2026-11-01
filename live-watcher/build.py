#!/usr/bin/python3
"""Build reviewable artifacts. Does not install or request Calendar access."""
import base64
import hashlib
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import tempfile
import zlib

ROOT=Path(__file__).resolve().parent
extension=ROOT/'extension'
manifest=json.loads((extension/'manifest.json').read_text())
if 'key' not in manifest:
    with tempfile.TemporaryDirectory() as folder:
        private=Path(folder)/'key.pem'
        subprocess.run(['openssl','genrsa','-out',str(private),'2048'],check=True,capture_output=True)
        public=subprocess.run(['openssl','rsa','-in',str(private),'-pubout','-outform','DER'],check=True,capture_output=True).stdout
        manifest['key']=base64.b64encode(public).decode()
        (extension/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
digest=hashlib.sha256(base64.b64decode(manifest['key'])).hexdigest()[:32]
extension_id=''.join(chr(ord('a')+int(c,16)) for c in digest)
origin=f'chrome-extension://{extension_id}/'
(ROOT/'native/installed-origin.json').write_text(json.dumps({'origin':origin},indent=2)+'\n')

# Small locally generated green checker icon, no remote assets or dependencies.
def chunk(tag,data):return struct.pack('>I',len(data))+tag+data+struct.pack('>I',zlib.crc32(tag+data)&0xffffffff)
pixels=b''.join(b'\0'+b''.join(bytes((25,105,77,255) if ((x//32+y//32)%2) else (57,169,127,255)) for x in range(128)) for y in range(128))
(extension/'icon.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',128,128,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b''))
# File-provider metadata in Documents can invalidate a Mac app's signature.
# Build the review bundle outside iCloud; installation will copy/sign it locally.
app=Path('/private/tmp/mytutor-live-review/MyTutor Calendar Helper.app/Contents')
(app/'MacOS').mkdir(parents=True,exist_ok=True)
with (app/'Info.plist').open('wb') as out:
    plistlib.dump({'CFBundleIdentifier':'uk.local.mytutor.calendarhelper','CFBundleName':'MyTutor Calendar Helper','CFBundleExecutable':'CalendarHelper','CFBundlePackageType':'APPL','CFBundleVersion':'1','LSUIElement':True,'NSCalendarsFullAccessUsageDescription':'Read configured calendars to prevent double-bookings. Sync confirmed meetings to the selected calendar.'},out)
subprocess.run(['xcrun','swiftc','-parse-as-library','-module-cache-path',str(ROOT/'build/swift-cache'),str(ROOT/'native/CalendarHelper.swift'),'-framework','EventKit','-framework','Foundation','-o',str(app/'MacOS/CalendarHelper')],check=True)
for attribute in ('com.apple.FinderInfo','com.apple.ResourceFork'):
    subprocess.run(['xattr','-dr',attribute,str(app.parent)],check=False,capture_output=True)
subprocess.run(['codesign','--force','--sign','-',str(app.parent)],check=True)
host=ROOT/'native/host.py';host.chmod(0o700)
native={'name':'uk.local.mytutor_watcher','description':'Local persistent MyTutor watcher','path':str(host),'type':'stdio','allowed_origins':[origin]}
(ROOT/'native/uk.local.mytutor_watcher.json').write_text(json.dumps(native,indent=2)+'\n')
print(json.dumps({'extension_id':extension_id,'extension_directory':str(extension),'native_manifest':str(ROOT/'native/uk.local.mytutor_watcher.json'),'calendar_helper':str(app.parent),'installed':False},indent=2))
