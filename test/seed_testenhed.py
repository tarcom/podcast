"""Giver test-enheden claude-test fire af Allans rigtige favoritter (kun læsning af hans liste),
så testproxy.py har en kø at vise.  python test/seed_testenhed.py [remove]"""
import json, sys, time, urllib.request
API = 'https://aogj.com/podcast/api/index.php'
DEV = 'claude-test'
UA = {'User-Agent': 'AllDKPodcastsTest/1.0', 'Content-Type': 'application/json'}
def call(action, body=None, method=None, **params):
    params['action'] = action
    qs = '&'.join(f'{k}={urllib.parse.quote(str(v))}' for k, v in params.items())
    req = urllib.request.Request(API + '?' + qs, data=json.dumps(body).encode() if body is not None else None,
                                 method=method or ('POST' if body is not None else 'GET'), headers=UA)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)
import urllib.parse
real = {f['feed_id']: f for f in call('favorites.list', deviceId='allan-main')['items']}
WANT = {5046712: 2, 270399: 0, 988198: 1, -1106114806: 0}
if sys.argv[1:] == ['remove']:
    for fid in WANT:
        print(fid, call('favorites.remove', {'deviceId': DEV, 'feedId': fid}, method='DELETE'))
    sys.exit()
for fid, prio in WANT.items():
    f = real[fid]
    r = call('favorites.add', {'deviceId': DEV, 'feedId': fid, 'title': f['title'], 'image': f.get('image') or '',
              'author': f.get('author') or '', 'language': f.get('language') or '', 'feedUrl': f.get('feed_url') or '',
              'addedVia': f.get('added_via') or 'search'})
    if prio:
        call('favorites.setPriority', {'deviceId': DEV, 'feedId': fid, 'priority': prio})
    print('add', fid, f['title'], r.get('status'))
    time.sleep(1)
q = call('episodes.newest', deviceId=DEV)['items']
print('queue', len(q), 'playable', sum(1 for e in q if e.get('audio_url')))
