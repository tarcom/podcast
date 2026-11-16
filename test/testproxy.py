"""Testserver: serverer web/dist på http://localhost:8572/podcast/ og sender /podcast/api/* videre
til den rigtige app på aogj.com — med device-id'et allan-main byttet ud med en test-enhed, så en
test aldrig skriver i Allans rigtige lytning. Bruges af både headless Chrome og emulatoren
(10.0.2.2:8572)."""
import http.server
import json
import os
import re
import socketserver
import sys
import urllib.error
import urllib.request

DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'dist')
API = 'https://aogj.com/podcast/api/index.php'
TEST_DEV = os.environ.get('TEST_DEV', 'claude-test')
PORT = int(os.environ.get('PORT', '8572'))


def swap(text):
    return text.replace('allan-main', TEST_DEV)


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIST, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s\n' % (fmt % args))

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _api(self, method):
        qs = self.path.split('?', 1)[1] if '?' in self.path else ''
        url = API + '?' + swap(qs)
        body = None
        if method in ('POST', 'DELETE'):
            n = int(self.headers.get('Content-Length') or 0)
            body = swap(self.rfile.read(n).decode('utf-8')).encode('utf-8') if n else None
        req = urllib.request.Request(url, data=body, method=method, headers={
            'User-Agent': 'AllDKPodcastsTest/1.0', 'Content-Type': 'application/json'})
        tok = self.headers.get('X-Torrent-Token')
        if tok:
            req.add_header('X-Torrent-Token', tok)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data, status = r.read(), r.status
        except urllib.error.HTTPError as e:
            data, status = e.read(), e.code
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self, method):
        p = self.path.split('?', 1)[0]
        if p.startswith('/podcast/api/'):
            return self._api(method)
        if method != 'GET':
            self.send_error(405)
            return
        if p == '/' or p == '/podcast':
            self.send_response(302)
            self.send_header('Location', '/podcast/')
            self.end_headers()
            return
        if p.startswith('/podcast/'):
            rest = p[len('/podcast/'):]
            local = os.path.join(DIST, rest)
            if not rest or not os.path.isfile(local):
                rest = 'index.html' if not os.path.splitext(rest)[1] else rest
            self.path = '/' + rest + (('?' + self.path.split('?', 1)[1]) if '?' in self.path else '')
            return super().do_GET()
        self.send_error(404)

    def do_GET(self):
        self._route('GET')

    def do_POST(self):
        self._route('POST')

    def do_DELETE(self):
        self._route('DELETE')

    def guess_type(self, path):
        if path.endswith('.webmanifest'):
            return 'application/manifest+json'
        return super().guess_type(path)


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    print(f'Serverer {DIST} på http://localhost:{PORT}/podcast/ (device {TEST_DEV})', flush=True)
    S(('0.0.0.0', PORT), H).serve_forever()
