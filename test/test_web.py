"""Afprøver web-bygget i headless Chrome mod test/testproxy.py (test-enheden claude-test).

Kræver: npm run build, python test/seed_testenhed.py, python test/testproxy.py (i baggrunden).
Rører kun stuen med læsning (status og liste) — intet tændes. Skærmbilleder i %TEMP%/podcast-shots."""
import json
import os
import sys
import tempfile
import time
import urllib.request

from selenium import webdriver
from selenium.webdriver.common.by import By

HER = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(tempfile.gettempdir(), 'podcast-shots')
os.makedirs(SHOTS, exist_ok=True)
BASE = 'http://localhost:8572/podcast/'
API = 'https://aogj.com/podcast/api/index.php'
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


def api(action, body=None, **params):
    import urllib.parse
    params['action'] = action
    req = urllib.request.Request(API + '?' + urllib.parse.urlencode(params),
                                 data=json.dumps(body).encode() if body is not None else None,
                                 method='POST' if body is not None else 'GET',
                                 headers={'User-Agent': 'AllDKPodcastsTest/1.0', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


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


try:
    d.get(BASE)
    n = wait(lambda: len(d.find_elements(By.CSS_SELECTOR, '.episode')))
    ok(n and n > 50, f'køen er tegnet ({n} afsnit)')
    nav = d.find_element(By.CSS_SELECTOR, 'nav.tabs')
    ok(js("return getComputedStyle(arguments[0]).position", nav) == 'fixed', 'fanerne ligger fast i bunden på mobil')
    ok(len(d.find_elements(By.CSS_SELECTOR, 'nav.tabs button')) == 6, 'seks faner: Kø, Favoritter, Hentet, Udforsk, Stuen, Lyd')
    time.sleep(1.5)
    shot('01-koe-lys')

    # mørkt tema
    d.execute_cdp_cmd('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': 'dark'}]})
    time.sleep(0.6)
    bg = js("return getComputedStyle(document.body).backgroundColor")
    ok('15, 21, 19' in bg, f'mørkt tema slår igennem (body {bg})')
    shot('02-koe-moerk')
    d.execute_cdp_cmd('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': 'light'}]})

    # filtre huskes på enheden
    stjerner = d.find_elements(By.CSS_SELECTOR, '.qchip.stars')
    stjerner[2].click()  # ★★★
    d.find_element(By.CSS_SELECTOR, '.qchip.cat-podcast').click()
    time.sleep(0.4)
    vist = len(d.find_elements(By.CSS_SELECTOR, '.episode'))
    sub = d.find_element(By.CSS_SELECTOR, '.panel-sub').text
    ok('Viser' in sub, f'filteret viser antal: "{sub}"')
    d.refresh()
    wait(lambda: len(d.find_elements(By.CSS_SELECTOR, '.episode')))
    on = [b.text for b in d.find_elements(By.CSS_SELECTOR, '.qchip.on')]
    ok(on == ['★★★', '🎙 Podcast'], f'filteret er husket efter genindlæsning: {on}')
    ok(len(d.find_elements(By.CSS_SELECTOR, '.episode')) == vist, 'samme antal afsnit efter genindlæsning')
    d.find_element(By.CSS_SELECTOR, '.qchip.clear').click()
    time.sleep(0.3)

    # afspil et afsnit
    thumb = wait(lambda: d.find_element(By.CSS_SELECTOR, '.episode:not(.heard) .ep-thumb:not(.link):not(.torrent)'))
    titel = thumb.find_element(By.XPATH, '..').find_element(By.CSS_SELECTOR, '.ep-text strong').text
    thumb.click()
    spiller = wait(lambda: js("var a=document.querySelector('audio'); return a && a.currentTime > 1 && !a.paused"), 30)
    ok(spiller, f'afsnittet spiller: {titel[:50]}')
    ok(wait(lambda: d.find_element(By.CSS_SELECTOR, '.mini-tekst strong').text) == titel, 'mini-afspilleren viser afsnittet')
    shot('03-mini-spiller')

    # fuld afspiller: hastighed og sove-timer
    d.find_element(By.CSS_SELECTOR, '.mini-aabn').click()
    wait(lambda: d.find_element(By.CSS_SELECTOR, '.ark'))
    time.sleep(0.5)
    shot('04-fuld-spiller')
    piller = d.find_elements(By.CSS_SELECTOR, '.ark-ekstra .pille')
    piller[0].click()
    time.sleep(0.2)
    ok(abs(js("return document.querySelector('audio').playbackRate") - 1.2) < 0.01, 'hastighed 1,2× slår igennem på lyden')
    piller[1].click()
    time.sleep(0.2)
    ok('15 min' in d.find_elements(By.CSS_SELECTOR, '.ark-ekstra .pille')[1].text, 'sove-timeren står på 15 min')
    shot('05-fuld-spiller-valg')
    # spol frem og pause
    d.find_elements(By.CSS_SELECTOR, '.ark-skip')[1].click()
    time.sleep(0.5)
    d.find_element(By.CSS_SELECTOR, '.ark-play').click()
    time.sleep(1)
    pos = js("return document.querySelector('audio').currentTime")
    np = json.loads(js("return localStorage.getItem('podcast_nowplaying')") or 'null')
    ok(np and np['ep']['title'] == titel and abs(np['pos'] - pos) < 3, f'positionen er gemt på enheden ved pause ({np and np["pos"]} ~ {pos:.0f})')
    ep_id = np['ep']['episodeId']
    feed_id = np['ep']['feedId']

    # genindlæs: afspilleren står der igen, på pause, samme sted
    d.refresh()
    ok(wait(lambda: d.find_element(By.CSS_SELECTOR, '.mini-tekst strong').text) == titel, 'afspilleren er genskabt efter genindlæsning')
    gen = wait(lambda: js("var a=document.querySelector('audio'); return a.readyState>0 && a.paused && a.currentTime"), 20)
    ok(gen and abs(gen - pos) < 3, f'genskabt på pause og samme sted ({gen} ~ {pos:.0f})')
    ok(abs(js("return document.querySelector('audio').playbackRate") - 1.2) < 0.01, 'hastigheden er husket')

    # en anden enhed lytter videre: serveren får en nyere position
    time.sleep(6)
    api('state.set', {'deviceId': 'claude-test', 'episodeId': ep_id, 'feedId': feed_id, 'positionSec': int(pos) + 600, 'durationSec': 0})
    js("window.dispatchEvent(new Event('online'))")  # tvinger en opdatering (ellers højst hvert minut)
    ny = wait(lambda: (lambda t: t if t > pos + 500 else None)(js("return document.querySelector('audio').currentTime")), 20)
    ok(ny, f'pauset afspiller fortsætter, hvor en anden enhed slap ({ny})')
    toast = wait(lambda: d.find_element(By.CSS_SELECTOR, '.toast').text, 5)
    ok(toast and 'Fortsætter' in toast, f'besked om det: {toast}')
    shot('06-fortsaetter-andetsteds')

    # ny udgave af siden: banner, når den er synlig
    vf = os.path.join(HER, '..', 'web', 'dist', 'version.json')
    gammel = open(vf).read()
    open(vf, 'w').write('{"build":"test-ny"}\n')
    try:
        js("window.dispatchEvent(new Event('online'))")
        ok(wait(lambda: d.find_element(By.CSS_SELECTOR, '.banner.fresh'), 10), 'banner om ny udgave vises')
    finally:
        open(vf, 'w').write(gammel)

    # luk afspilleren
    d.find_element(By.CSS_SELECTOR, '.mini-aabn').click()
    wait(lambda: d.find_element(By.CSS_SELECTOR, '.ark'))
    time.sleep(0.5)  # afspilleren glider op (0,22 s) — et tryk midt i rammer ved siden af ✕
    d.find_elements(By.CSS_SELECTOR, '.ark-top .ark-ikon')[1].click()
    time.sleep(0.5)
    ok(not d.find_elements(By.CSS_SELECTOR, '.mini'), 'afspilleren er væk efter ✕')
    ok(js("return localStorage.getItem('podcast_nowplaying')") is None, 'og glemt på enheden')

    # Udforsk + Favoritter (bare at de tegnes)
    d.find_elements(By.CSS_SELECTOR, 'nav.tabs button')[1].click()
    ok(wait(lambda: len(d.find_elements(By.CSS_SELECTOR, '.card')) >= 4), 'Favoritter tegnes')
    shot('07-favoritter')

    # Stuen: kun læsning (status + liste) — ingen tryk, der tænder noget
    d.find_elements(By.CSS_SELECTOR, 'nav.tabs button')[4].click()
    n = wait(lambda: len(d.find_elements(By.CSS_SELECTOR, '.stuen-liste li button')), 30)
    ok(n and n > 5, f'Stuen viser disken fra HTPC ({n} poster)')
    tilstand = wait(lambda: d.find_element(By.CSS_SELECTOR, '.stuen-tilstand').text not in ('', 'Henter …') and d.find_element(By.CSS_SELECTOR, '.stuen-tilstand').text, 15)
    ok(tilstand, f'Stuen viser tv-status: {tilstand}')
    time.sleep(1)
    shot('08-stuen')
    d.execute_cdp_cmd('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': 'dark'}]})
    time.sleep(0.5)
    shot('09-stuen-moerk')
    # søg og åbn en mappe (kun navigation)
    mappe = [b for b in d.find_elements(By.CSS_SELECTOR, '.stuen-liste li button') if b.find_elements(By.CSS_SELECTOR, '.pil')]
    if mappe:
        # Midt på skærmen: ellers kan den første mappe ligge bag bundmenuen (sket 24/11)
        js("arguments[0].scrollIntoView({block: 'center'})", mappe[0])
        time.sleep(0.3)
        mappe[0].click()
        ok(wait(lambda: d.find_element(By.CSS_SELECTOR, '.stuen-op')), 'en mappe kan åbnes, og der er en Tilbage-knap')
        ok(js("return window.__dkPodTilbage()") is True, "Androids tilbage-knap går en mappe op")
        time.sleep(0.5)
        ok(not d.find_elements(By.CSS_SELECTOR, '.stuen-op'), 'og står så i den samlede liste igen')

    fejl = [e for e in d.get_log('browser') if e['level'] == 'SEVERE' and '192.168' not in e['message']]
    ok(not fejl, f'ingen fejl i konsollen ({[e["message"][:120] for e in fejl]})')
finally:
    d.quit()

print('\n%d af %d gik igennem' % (sum(1 for r in RESULT if r[0]), len(RESULT)))
sys.exit(0 if all(r[0] for r in RESULT) else 1)
