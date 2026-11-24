"""Afspilleren kommer i gang igen, når forbindelsen til lyden er gået tabt (rettet 2026-11-24).

I bilen stod afspilleren stille efter et hul i dækningen, og afspil hjalp ikke: et <audio>, der har
fået en netværksfejl, kommer aldrig i gang igen med play(), kun med en ny indlæsning af kilden.
Testen spiller rigtige afsnit fra test-enhedens kø i headless Chrome og laver hullerne med Chrome
DevTools-protokollen. Service workeren springes over (Network.setBypassServiceWorker), så lydens
hentninger rammer emuleringen direkte. Android-app'en afprøves med et rigtigt netudfald i
emulatoren (podcast-android/test/test_android.py genoptag).

Kræver: npm run build, python test/seed_testenhed.py, python test/testproxy.py (i baggrunden).
Tager 6-8 minutter: Chromium prøver selv i ca. 30 sek., før det giver op.

  1. Dækningen væk, mens der spilles (telefonen tror, den er online): prøver selv igen, spiller videre
  2. Offline, mens der spilles: spiller videre, så snart nettet er tilbage
  3. På pause, fejl imens, så afspil: henter lyden forfra og spiller (det, Allan oplevede 24/11)
  4. Et nyt afsnit, der slet ikke kan hentes: pop-up'en "kunne ikke afspilles" som før
  5. Forbindelsen hænger uden fejl: vagten henter lyden forfra
"""
import json
import os
import sys
import tempfile
import time

from selenium import webdriver
from selenium.webdriver.common.by import By

BASE = 'http://localhost:8572/podcast/'
SHOTS = os.path.join(tempfile.gettempdir(), 'podcast-shots')
os.makedirs(SHOTS, exist_ok=True)
RESULT = []


def ok(cond, msg):
    RESULT.append((bool(cond), msg))
    print(('OK   ' if cond else 'FEJL ') + msg, flush=True)


def wait(fn, timeout=15, step=0.5):
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


opts = webdriver.ChromeOptions()
opts.add_argument('--headless=new')
opts.add_argument('--user-data-dir=' + tempfile.mkdtemp(prefix='podgenoptag-'))
opts.add_argument('--autoplay-policy=no-user-gesture-required')
opts.add_argument('--mute-audio')
opts.add_experimental_option('mobileEmulation', {
    'deviceMetrics': {'width': 412, 'height': 915, 'pixelRatio': 2.0},
    'userAgent': 'Mozilla/5.0 (Linux; Android 16; SM-F9600) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
})
d = webdriver.Chrome(options=opts)
js = d.execute_script
cdp = d.execute_cdp_cmd

# Hændelserne på lydelementet tælles, så testen kan se fejl og nye indlæsninger.
TAEL = """
var a = document.querySelector('audio');
if (a && !a.__taelt) {
  a.__taelt = true; window.__h = {error: 0, loadstart: 0, playing: 0};
  ['error', 'loadstart', 'playing'].forEach(function (n) { a.addEventListener(n, function () { window.__h[n]++; }); });
}
return window.__h;
"""


def lyd():
    return js("""var a = document.querySelector('audio');
        return {t: Math.round(a.currentTime), paused: a.paused, err: a.error ? a.error.code : 0,
                ready: a.readyState, h: window.__h, online: navigator.onLine,
                popup: !!document.querySelector('.modal .linkout'),
                toast: (document.querySelector('.toast') || {}).textContent || ''}""")


def spiller(min_t=None):
    """Spiller lyden — tiden går frem — og (eventuelt) fra mindst min_t sek.?"""
    a = js("return document.querySelector('audio').currentTime")
    time.sleep(2.5)
    s = lyd()
    return (not s['paused'] and s['t'] > a + 1 and (min_t is None or s['t'] >= min_t)) and s


def spring_frem():
    """Ud over det, Chromium har hentet (som når bufferen er spillet), og mindst 5 min. frem.
    Afsnittene er mindst 30 min. og startes 60 sek. inde, så springene ikke rammer slutningen."""
    return js("""var a = document.querySelector('audio'), b = a.buffered;
        var slut = b.length ? b.end(b.length - 1) : a.currentTime;
        a.currentTime = Math.max(a.currentTime + 300, slut + 120);
        return Math.round(a.currentTime)""")


def bloker(paa):
    # Som et hul i dækningen, hvor telefonen stadig tror, den er online (navigator.onLine er true)
    try:
        cdp('Network.setBlockedURLs', {'urls': ['*'] if paa else []})
    except Exception:
        cdp('Network.setBlockedURLs', {'urlPatterns': [{'urlPattern': '*', 'block': True}] if paa else []})


def net(offline=False, latency=0):
    cdp('Network.emulateNetworkConditions',
        {'offline': offline, 'latency': latency, 'downloadThroughput': -1, 'uploadThroughput': -1})


BRUGT = set()  # titler, testen har spillet (eller prøvet at spille)


def minutter(tekst):
    """Afsnittets længde i minutter ud fra rækkens tekst ("45 min" eller "1 t 12 min")."""
    import re
    return max([int(h or 0) * 60 + int(m) for h, m in re.findall(r'(?:(\d+) t )?(\d+) min', tekst)] or [0])


def nyt_afsnit():
    """Et uhørt afsnit på mindst 30 min., testen ikke har rørt endnu, og dets titel."""
    thumbs = wait(lambda: d.find_elements(By.CSS_SELECTOR, '.episode:not(.heard) .ep-thumb:not(.link):not(.torrent)'), 30)
    for thumb in thumbs:
        raekke = thumb.find_element(By.XPATH, '..')
        titel = raekke.find_element(By.CSS_SELECTOR, '.ep-text strong').text
        if titel not in BRUGT and minutter(raekke.text) >= 30:
            BRUGT.add(titel)
            js("arguments[0].scrollIntoView({block: 'center'})", thumb)  # ikke bag bundmenuen
            time.sleep(0.5)
            return thumb, titel
    raise RuntimeError('ingen lange, uhørte afsnit tilbage i test-køen')


def spil_afsnit():
    thumb, titel = nyt_afsnit()
    thumb.click()
    js(TAEL)
    s = wait(lambda: js("var a=document.querySelector('audio'); return a && a.currentTime > 2 && !a.paused"), 40)
    js("document.querySelector('audio').currentTime = 60")
    s = s and wait(lambda: js("var a=document.querySelector('audio'); return !a.paused && a.currentTime > 61"), 30)
    return s, titel


def shot(navn):
    d.save_screenshot(os.path.join(SHOTS, 'genoptag-' + navn + '.png'))


try:
    cdp('Network.enable', {})
    cdp('Network.setBypassServiceWorker', {'bypass': True})
    d.get(BASE)
    ok(wait(lambda: len(d.find_elements(By.CSS_SELECTOR, '.episode')) > 20, 30), 'køen er tegnet')

    # ---------- 1. dækningen væk, mens der spilles ----------
    s, titel = spil_afsnit()
    ok(s, f'1: afsnittet spiller: {titel[:50]}')
    bloker(True)
    maal = spring_frem()
    faldt = wait(lambda: lyd()['h']['error'] > 0, 90, 1)
    ok(faldt, f'1: lyden faldt ud ved {maal} sek. uden dækning ({lyd()})')
    time.sleep(12)
    s = lyd()
    ok(not s['popup'], '1: ingen "kunne ikke afspilles"-pop-up for et afsnit, der har spillet')
    ok(s['h']['loadstart'] > 1, f"1: app'en har selv prøvet at hente lyden igen ({s['h']['loadstart'] - 1} gange)")
    shot('1-uden-daekning')
    bloker(False)
    t0 = time.time()
    s = wait(lambda: spiller(maal - 5), 90, 0.5)
    ok(s, f'1: spiller videre fra {s and s["t"]} sek. efter {time.time() - t0:.0f} sek. med dækning igen (faldt ud ved {maal})')

    # ---------- 2. offline, mens der spilles ----------
    js("window.__h.error = 0")
    net(offline=True)
    maal = spring_frem()
    ok(wait(lambda: lyd()['h']['error'] > 0 and not lyd()['online'], 90, 1), '2: offline: lyden faldt ud, navigator.onLine er false')
    js("window.__h.error = 0")
    time.sleep(8)
    ok(lyd()['paused'], '2: afspilleren står på pause, mens der intet net er')
    net(offline=False)
    t0 = time.time()
    s = wait(lambda: spiller(maal - 5), 30, 0.5)
    ok(s and time.time() - t0 < 15, f'2: spiller videre {time.time() - t0:.0f} sek. efter, at nettet kom tilbage (fra {s and s["t"]}, faldt ud ved {maal})')

    # ---------- 3. på pause, fejl imens, så afspil (Allans tilfælde) ----------
    d.find_element(By.CSS_SELECTOR, '.mini-play').click()
    ok(wait(lambda: lyd()['paused'], 5), '3: pause med knappen')
    js("window.__h.error = 0")
    bloker(True)
    maal = spring_frem()
    ok(wait(lambda: lyd()['h']['error'] > 0, 90, 1), f'3: forbindelsen faldt ud under pausen ({lyd()["err"]})')
    bloker(False)
    time.sleep(6)
    ok(lyd()['paused'], '3: den starter ikke af sig selv, når man har trykket pause')
    shot('3-foer-afspil')
    d.find_element(By.CSS_SELECTOR, '.mini-play').click()
    t0 = time.time()
    s = wait(lambda: spiller(maal - 5), 30, 0.5)
    ok(s, f'3: afspil spiller igen efter {time.time() - t0:.0f} sek., fra {s and s["t"]} (stod ved {maal})')
    shot('3-efter-afspil')

    # ---------- 4. et nyt afsnit, der slet ikke kan hentes ----------
    thumb, titel = nyt_afsnit()
    bloker(True)
    thumb.click()
    ok(wait(lambda: lyd()['popup'], 30), f"4: et afsnit, der aldrig har kunnet hentes, giver pop-up'en som før ({titel[:40]})")
    msg = wait(lambda: d.find_element(By.CSS_SELECTOR, '.modal .linkout-msg').text, 5) or ''
    ok('kunne ikke afspilles' in msg, f'4: teksten: {msg[:70]}')
    shot('4-popup')
    bloker(False)
    d.find_element(By.CSS_SELECTOR, '.modal-close').click()
    time.sleep(0.5)

    # ---------- 5. forbindelsen hænger (ingen fejl): vagten ----------
    s, titel = spil_afsnit()
    ok(s, f'5: et andet afsnit spiller: {titel[:50]}')
    js("window.__h.loadstart = 0")
    net(latency=150_000)  # hvert svar tager 2½ minut: lyden venter uden fejl
    maal = spring_frem()
    t0 = time.time()
    vagt = wait(lambda: lyd()['h']['loadstart'] > 0, 75, 1)
    ok(vagt, f'5: vagten hentede lyden forfra efter {time.time() - t0:.0f} sek. i stå')
    net()
    t0 = time.time()
    s = wait(lambda: spiller(maal - 5), 100, 0.5)
    ok(s, f'5: spiller igen efter {time.time() - t0:.0f} sek., fra {s and s["t"]} (stod ved {maal})')
    ok(not lyd()['popup'], '5: ingen pop-up')
    d.find_element(By.CSS_SELECTOR, '.mini-play').click()
finally:
    try:
        shot('slut')
    except Exception:
        pass
    d.quit()

fejl = [m for g, m in RESULT if not g]
print(f'\n{len(RESULT) - len(fejl)} af {len(RESULT)} OK')
if fejl:
    print('FEJL:\n  ' + '\n  '.join(fejl))
sys.exit(1 if fejl else 0)
