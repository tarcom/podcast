"""Det nye fra 2026-11-17 i web-bygget, i headless Chrome mod test/testproxy.py (test-enheden claude-test):

- podcastens navn på sin egen linje i køen, og mærkaterne ("#11 i DK", "DR TV", "Fortsætter") knækker
  aldrig midt i; udbyderen (Omny, Simplecast …) vises kun ved afsnit, der ikke kan spilles her
- "Hent uhørte" ligger under Hentet, ikke i køen
- Torrent står nederst i Favoritter — også uden koden (låst); koden låser op
- et DR TV-afsnit, HTPC har hentet som video, står kun én gang i køen
- video fra HTPC: pop-up'en for et DR TV-afsnit og en torrent har tv'et og telefonen (adressen svarer)
- "Afspil på …" med en Google Home-højttaler hele vejen: sendes, bjælken, styringen, pause, spil,
  "Fortsæt på telefonen". Højttaleren sættes på lav lydstyrke først og lægges tilbage bagefter.

    python test/test_nyt.py [--uden-cast]

Kræver: npm run build, python test/seed_testenhed.py, python test/testproxy.py (i baggrunden),
og ssh til htpc (lydstyrken). Torrent-koden er testenhedens egen (samme som i CLAUDE.md)."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

from selenium import webdriver
from selenium.webdriver.common.by import By

HER = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(tempfile.gettempdir(), 'podcast-shots')
os.makedirs(SHOTS, exist_ok=True)
BASE = 'http://localhost:8572/podcast/'
API = 'https://aogj.com/podcast/api/index.php'
TV = 'http://192.168.1.85:8097'
HOEJTTALER = os.environ.get('HOEJTTALER', 'Google home soveværelset')
PIN = '5090'
RESULT = []


def ok(cond, msg):
    RESULT.append((bool(cond), msg))
    print(('OK   ' if cond else 'FEJL ') + msg, flush=True)


def wait(fn, timeout=15, step=0.25):
    t = time.time() + timeout
    while time.time() < t:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(step)
    return None


def api(action, token=None, **params):
    params['action'] = action
    h = {'User-Agent': 'AllDKPodcastsTest/1.0'}
    if token:
        h['X-Torrent-Token'] = token
    req = urllib.request.Request(API + '?' + urllib.parse.urlencode(params), headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def tv_status():
    with urllib.request.urlopen(TV + '/api/status', timeout=10) as r:
        return json.load(r)


def lydstyrke(ny=None):
    args = ['ssh', 'htpc', '~/tv/.venv/bin/python', '-', f'"{HOEJTTALER}"'] + ([str(ny)] if ny is not None else [])
    with open(os.path.join(HER, 'lydstyrke.py'), 'rb') as f:
        ud = subprocess.run(args, stdin=f, capture_output=True, timeout=60).stdout.decode().strip().splitlines()
    return float(ud[-1]) if ud else None


opts = webdriver.ChromeOptions()
opts.add_argument('--headless=new')
opts.add_argument('--user-data-dir=' + tempfile.mkdtemp(prefix='podtest-'))
opts.add_argument('--autoplay-policy=no-user-gesture-required')
opts.add_argument('--mute-audio')
opts.add_experimental_option('mobileEmulation', {
    'deviceMetrics': {'width': 412, 'height': 915, 'pixelRatio': 2.0},
    'userAgent': 'Mozilla/5.0 (Linux; Android 16; SM-F9600) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
})
opts.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
d = webdriver.Chrome(options=opts)
js = d.execute_script


def shot(name):
    d.save_screenshot(os.path.join(SHOTS, name + '.png'))


def faneknap(tekst):
    return next(b for b in d.find_elements(By.CSS_SELECTOR, 'nav.tabs button') if tekst in b.text)


def luk_modal():
    js("var b=document.querySelector('.modal .modal-close'); if (b) b.click()")
    time.sleep(0.4)


gammel_lyd = None
try:
    d.get(BASE)
    n = wait(lambda: len(d.find_elements(By.CSS_SELECTOR, '.episode')) > 50 and len(d.find_elements(By.CSS_SELECTOR, '.episode')), 40)
    ok(n, f'køen er tegnet ({n} afsnit)')

    # --- podcastnavn, mærkater, udbyder ---
    raekker = js("""return Array.from(document.querySelectorAll('.episode')).map(function (li) {
        var p = li.querySelector('.ep-pod'); var src = li.querySelector('.ep-meta .src');
        return {pod: p ? p.textContent : null, spilbar: !li.querySelector('.ep-thumb.link') && !li.querySelector('.ep-thumb.torrent'),
                src: src ? src.textContent : null};
    })""")
    ok(all(r['pod'] for r in raekker), f'alle {len(raekker)} rækker har podcastens navn på sin egen linje')
    ok(any(r['pod'] == 'Store Penge' for r in raekker), 'fx "Store Penge" over titlen')
    ok(not [r for r in raekker if r['spilbar'] and r['src']], 'ingen udbyder-mærkat (Omny, Simplecast …) på afsnit, der kan spilles')
    knaek = js("""return Array.from(document.querySelectorAll('.ep-meta > em')).filter(function (e) {
        return e.getClientRects().length !== 1 || getComputedStyle(e).whiteSpace !== 'nowrap'; }).map(function (e) { return e.textContent })""")
    antal_maerker = js("return document.querySelectorAll('.ep-meta > em').length")
    ok(antal_maerker > 5 and not knaek, f'ingen af de {antal_maerker} mærkater knækker over to linjer ({knaek[:3]})')
    d.execute_script("window.scrollTo(0, 0)")
    shot('20-koe-podcastnavn')

    # --- Hent uhørte ligger under Hentet ---
    ok(not d.find_elements(By.CSS_SELECTOR, '.bulkbar'), '"Hent uhørte" er ikke længere i køen')
    faneknap('Hentet').click()
    ok(wait(lambda: d.find_element(By.CSS_SELECTOR, '.bulkbar'), 5), 'den ligger under Hentet')
    shot('21-hentet')

    # --- Torrent nederst i Favoritter, låst uden koden ---
    faneknap('Favoritter').click()
    kort = wait(lambda: d.find_elements(By.CSS_SELECTOR, '.card') if len(d.find_elements(By.CSS_SELECTOR, '.card')) >= 5 else None, 10)
    sidste = kort[-1] if kort else None
    ok(sidste and 'fast' in sidste.get_attribute('class') and 'Torrent' in sidste.text, 'Torrent står som det sidste kort i Favoritter')
    ok(sidste and 'Låst' in sidste.text, 'og er låst uden koden')
    shot('22-favoritter-torrent-laast')
    sidste.find_element(By.CSS_SELECTOR, '.card-main').click()
    felt = wait(lambda: d.find_element(By.CSS_SELECTOR, '#torrent-pin'), 5)
    ok(felt, 'et tryk på det låste kort beder om koden (i køen)')
    felt.send_keys(PIN)
    d.find_element(By.CSS_SELECTOR, '.pinbox button[type=submit]').click()
    torrent_raekker = wait(lambda: [e for e in d.find_elements(By.CSS_SELECTOR, '.episode .ep-pod') if 'Torrent' in e.text], 20)
    ok(torrent_raekker, f'koden låser op: {len(torrent_raekker or [])} torrents i køen')
    token = js("return localStorage.getItem('podcast_torrent_token')")
    js("var b=document.querySelector('.qchip.clear'); if (b) b.click()")
    time.sleep(0.5)
    faneknap('Favoritter').click()
    time.sleep(0.5)
    sidste = d.find_elements(By.CSS_SELECTOR, '.card')[-1]
    ok('Torrent' in sidste.text and 'Låst' not in sidste.text and sidste.find_elements(By.CSS_SELECTOR, '.rate-star.on')
       and not sidste.find_elements(By.CSS_SELECTOR, '.rate-act'), 'bagefter har Torrent-kortet stjerner og hverken Slet eller Følg')
    shot('23-favoritter-torrent')

    # --- DR TV-dubletterne ---
    koe = api('episodes.newest', deviceId='claude-test')['items']
    import re
    numre = {m.group(1) for e in koe for m in [re.search(r'/drtv/episode/[^?#]*_(\d+)', e.get('link_url') or '')] if m}
    hashes = {hashlib.sha1(f'drtv:{n}'.encode()).hexdigest() for n in numre}
    tor = api('torrents.list', token=token, deviceId='claude-test')['items']
    dubletter = [t for t in tor if t.get('hash') in hashes]
    faneknap('Kø').click()
    time.sleep(0.5)
    vist = len([e for e in d.find_elements(By.CSS_SELECTOR, '.episode .ep-pod') if 'Torrent' in e.text])
    ok(dubletter and vist == len(tor) - len(dubletter),
       f'DR TV-afsnit hentet som video står kun én gang ({len(dubletter)} af {len(tor)} torrents er DR TV-afsnit i køen; {vist} vises)')

    # --- video fra HTPC: et DR TV-afsnit ---
    dr_rows = [li for li in d.find_elements(By.CSS_SELECTOR, '.episode') if li.find_element(By.CSS_SELECTOR, '.ep-pod').text == 'Deadline']
    fundet = None
    for li in dr_rows[:4]:
        li.find_element(By.CSS_SELECTOR, '.ep-text').click()
        tilstand = wait(lambda: d.find_element(By.CSS_SELECTOR, '.linkout.video .video-valg') or None, 15)
        if tilstand:
            fundet = li
            break
        luk_modal()
    ok(fundet, 'et DR TV-afsnit fra køen findes på HTPC (pop-up med tv og telefon)')
    if fundet:
        shot('24-drtv-video')
        knapper = d.find_element(By.CSS_SELECTOR, '.linkout.video').text
        ok("Afspil på tv'et" in knapper and 'Afspil her' in knapper and 'Åbn i DR TV' in knapper,
           f'knapperne: tv, her (telefonen), DR TV ({knapper.splitlines()[-4:]})')
        href = d.find_element(By.CSS_SELECTOR, 'a.linkout-btn.alt').get_attribute('href')
        ok(href.startswith(TV + '/fil/'), f'telefonens adresse er HTPC: {href[:80]}')
        req = urllib.request.Request(href, headers={'Range': 'bytes=0-1023'})
        with urllib.request.urlopen(req, timeout=20) as r:
            ok(r.status == 206 and r.headers['Content-Type'].startswith('video/') and len(r.read()) == 1024,
               f'og den svarer med video, der kan spoles i (HTTP {r.status}, {r.headers["Content-Type"]})')
        luk_modal()

    # --- video fra HTPC: en torrent ---
    tor_li = next((li for li in d.find_elements(By.CSS_SELECTOR, '.episode') if 'Torrent' in li.find_element(By.CSS_SELECTOR, '.ep-pod').text), None)
    if tor_li:
        tor_li.find_element(By.CSS_SELECTOR, '.ep-thumb').click()
        v = wait(lambda: d.find_element(By.CSS_SELECTOR, '.linkout.video .video-valg, .linkout.video .video-filer'), 15)
        ok(v, f'en torrent: pop-up med tv og telefon ({v.get_attribute("class") if v else "intet"})')
        shot('25-torrent-video')
        luk_modal()

    if '--uden-cast' in sys.argv:
        raise SystemExit

    # --- Afspil på … en Google Home ---
    faneknap('Stuen').click()  # så ved siden, at stuen kan nås (ellers vises "Afspil på …" ikke)
    wait(lambda: d.find_elements(By.CSS_SELECTOR, '.stuen-liste li button'), 20)
    faneknap('Kø').click()
    thumb = wait(lambda: next(li for li in d.find_elements(By.CSS_SELECTOR, '.episode:not(.heard)')
                              if li.find_element(By.CSS_SELECTOR, '.ep-pod').text == 'Store Penge').find_element(By.CSS_SELECTOR, '.ep-thumb'))
    js("arguments[0].scrollIntoView({block: 'center'})", thumb)  # ellers ligger den under bundmenuen
    time.sleep(0.4)
    thumb.click()
    ok(wait(lambda: js("var a=document.querySelector('audio'); return a && a.currentTime > 2 && !a.paused"), 30), 'et afsnit spiller på telefonen')
    d.find_element(By.CSS_SELECTOR, '.mini-aabn').click()
    wait(lambda: d.find_element(By.CSS_SELECTOR, '.ark'))
    time.sleep(0.5)
    pille = next(p for p in d.find_elements(By.CSS_SELECTOR, '.ark-ekstra .pille') if 'Afspil på' in p.text)
    pille.click()
    navne = wait(lambda: [b.text.split('\n')[0] for b in d.find_elements(By.CSS_SELECTOR, '.maal-liste button')]
                 if HOEJTTALER in d.find_element(By.CSS_SELECTOR, '.maal').text else None, 15)
    ok(navne and navne[0] == 'Telefonen' and "Tv'et i stuen" in navne and HOEJTTALER in navne, f'"Afspil på …" viser {navne}')
    shot('26-afspil-paa')
    gammel_lyd = lydstyrke()
    if gammel_lyd is not None and gammel_lyd > 0.05:
        lydstyrke(0.05)  # aldrig højere end 5 % under testen
    print(f'     ({HOEJTTALER} stod på {gammel_lyd:.0%}; højst 5 % under testen)')
    next(b for b in d.find_elements(By.CSS_SELECTOR, '.maal-liste button') if HOEJTTALER in b.text).click()
    toast = wait(lambda: d.find_element(By.CSS_SELECTOR, '.toast').text, 8)
    ok(toast and 'Spiller på' in toast, f'besked: {toast}')
    ok(js("return document.querySelector('audio').paused"), 'telefonen er sat på pause')
    # (.text giver teksten, som den vises — linjen over titlen står med store bogstaver)
    bjaelke = wait(lambda: (lambda t: t if ('på ' + HOEJTTALER).lower() in t.lower() else None)(d.find_element(By.CSS_SELECTOR, '.fjernbjaelke').text), 30)
    ok(bjaelke, f'bjælken viser det: {bjaelke and bjaelke.splitlines()}')
    shot('27-fjernbjaelke')
    d.find_element(By.CSS_SELECTOR, '.fjern-aabn').click()
    wait(lambda: d.find_element(By.CSS_SELECTOR, '.ark.fjern'))
    time.sleep(0.6)
    t1 = d.find_elements(By.CSS_SELECTOR, '.ark.fjern .ark-tider span')[0].text
    time.sleep(3.5)
    t2 = d.find_elements(By.CSS_SELECTOR, '.ark.fjern .ark-tider span')[0].text
    ok(t1 != t2, f'styringen viser tiden, og den tikker ({t1} -> {t2})')
    shot('28-fjernspiller')
    d.find_element(By.CSS_SELECTOR, '.ark.fjern .ark-play').click()
    ok(wait(lambda: d.find_element(By.CSS_SELECTOR, '.ark.fjern .ark-titel p').text == 'På pause', 10), 'pause virker')
    st = tv_status().get('fjern') or {}
    ok(st.get('pause') is True, f'og højttaleren står på pause (tv-helper: {st.get("pause")}, {st.get("tid")} s)')
    d.find_element(By.CSS_SELECTOR, '.ark.fjern .ark-play').click()
    ok(wait(lambda: 'Spiller på' in d.find_element(By.CSS_SELECTOR, '.ark.fjern .ark-titel p').text, 10), 'og spil igen')
    time.sleep(2)
    fjern_tid = (tv_status().get('fjern') or {}).get('tid', 0)
    next(p for p in d.find_elements(By.CSS_SELECTOR, '.ark.fjern .pille') if 'Fortsæt på telefonen' in p.text).click()
    ok(wait(lambda: not d.find_elements(By.CSS_SELECTOR, '.fjernbjaelke'), 10), '"Fortsæt på telefonen": bjælken er væk')
    her = wait(lambda: js("var a=document.querySelector('audio'); return !a.paused && a.currentTime > 1 && a.currentTime"), 20)
    ok(her and abs(her - fjern_tid) < 20, f'og telefonen spiller videre derfra ({fjern_tid} s dér, {her and round(her)} s her)')
    st = tv_status().get('fjern')
    ok(not st or not st.get('spiller'), 'højttaleren er stoppet')
    js("var a=document.querySelector('audio'); a.pause()")

    fejl = [e for e in d.get_log('browser') if e['level'] == 'SEVERE' and '192.168' not in e['message']]
    ok(not fejl, f'ingen fejl i konsollen ({[e["message"][:120] for e in fejl]})')
except SystemExit:
    pass
finally:
    if gammel_lyd is not None:
        lydstyrke(gammel_lyd)
        print(f'     ({HOEJTTALER} er sat tilbage til {gammel_lyd:.0%})')
    d.quit()

print('\n%d af %d gik igennem' % (sum(1 for r in RESULT if r[0]), len(RESULT)))
sys.exit(0 if all(r[0] for r in RESULT) else 1)
