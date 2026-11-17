"""Fanen Lyd (Sonos og radioen i stuen) i headless Chrome mod test/testproxy.py og den rigtige tv-helper.

Kun handlinger, der ikke larmer: et rum ud af Sonos-gruppen og ind igen, Sonos-lydstyrken op og
tilbage (kun mens gruppen er stoppet) og radioens lydstyrke ét trin op og tilbage. Radioen
startes og stoppes IKKE (det tester htpc/test_radio.py i tv-projektet mod en falsk Denon).

    python test/test_lyd.py
"""
import json
import os
import sys
import tempfile
import time
import urllib.request

from selenium import webdriver
from selenium.webdriver.common.by import By

SHOTS = os.path.join(tempfile.gettempdir(), 'podcast-shots')
os.makedirs(SHOTS, exist_ok=True)
BASE = 'http://localhost:8572/podcast/'
TV = 'http://192.168.1.85:8097'
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


def lyd():
    with urllib.request.urlopen(TV + '/api/lyd', timeout=20) as r:
        return json.load(r)


opts = webdriver.ChromeOptions()
opts.add_argument('--headless=new')
opts.add_argument('--user-data-dir=' + tempfile.mkdtemp(prefix='podtest-'))
opts.add_argument('--mute-audio')
opts.add_experimental_option('mobileEmulation', {
    'deviceMetrics': {'width': 412, 'height': 915, 'pixelRatio': 2.0},
    'userAgent': 'Mozilla/5.0 (Linux; Android 16; SM-F9600) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
})
opts.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
d = webdriver.Chrome(options=opts)
js = d.execute_script


def knap(selector, tekst):
    return next(b for b in d.find_elements(By.CSS_SELECTOR, selector) if tekst in b.text)


def tryk(el):
    # midt på skærmen først — ellers ligger knappen under bundmenuen
    js("arguments[0].scrollIntoView({block: 'center'})", el)
    time.sleep(0.3)
    el.click()


def sonos_kort(coord=None):
    sel = '.lyd-kort.sonos' + (f'[data-coord="{coord}"]' if coord else '')
    return d.find_elements(By.CSS_SELECTOR, sel)


try:
    foer = lyd()
    g0 = foer['sonos']['groups']
    print(f"     før: Sonos {[(g['coord'], g['members'], g['state'], g['volume']) for g in g0]}, "
          f"radio {foer['radio'].get('station')} {foer['radio'].get('lydstyrke')} spiller={foer['radio'].get('spiller')}")
    d.get(BASE)
    wait(lambda: len(d.find_elements(By.CSS_SELECTOR, '.episode')) > 20, 40)
    faner = [b.text.replace('\n', ' ') for b in d.find_elements(By.CSS_SELECTOR, 'nav.tabs button')]
    ok(len(faner) == 6 and any('Lyd' in f for f in faner), f'seks faner, den sidste er Lyd ({faner})')
    knap('nav.tabs button', 'Lyd').click()
    kort = wait(lambda: d.find_elements(By.CSS_SELECTOR, '.lyd-kort') if len(d.find_elements(By.CSS_SELECTOR, '.lyd-kort')) >= 2 else None, 20)
    ok(kort, f'fanen viser {len(kort or [])} kort (Sonos-grupper og radioen)')
    time.sleep(1.5)
    d.save_screenshot(os.path.join(SHOTS, '40-lyd.png'))

    alle = sonos_kort()
    tekst = ' '.join(k.text for k in alle)
    ok('Soveværelse' in tekst or 'Køkken' in tekst or 'Stue' in tekst, f'Sonos-kortet viser rummene: {tekst.splitlines()[:2]}')
    rum = [b.text for b in d.find_elements(By.CSS_SELECTOR, '.lyd-chips')[0].find_elements(By.CSS_SELECTOR, 'button')]
    ok(len(rum) >= 3, f'rummene: {rum}')
    fav = [b.text for b in d.find_elements(By.CSS_SELECTOR, '.lyd-chips')[1].find_elements(By.CSS_SELECTOR, 'button')]
    ok(fav == foer['sonos']['favorites'], f'favoritter og playlister: {fav}')
    radio = d.find_element(By.CSS_SELECTOR, '.lyd-kort.radio').text
    kanaler = [b.text for b in d.find_elements(By.CSS_SELECTOR, '.lyd-kort.radio .qchip')]
    ok('Denon' in radio and len(kanaler) == 6, f'radioen: {radio.splitlines()[:2]}, kanaler {kanaler}')

    # --- lydløst: et rum ud af gruppen og ind igen (kun en gruppe, der ikke spiller) ---
    g = next((g for g in g0 if len(g['members']) > 1 and g['state'] != 'PLAYING'), None)
    n0 = len(sonos_kort())
    if g:
        ud = g['members'][-1]
        navn = {'Kokken': 'Køkken', 'Sove': 'Soveværelse'}.get(ud, ud)
        if g['coord'] != (foer['sonos']['active'] or {}).get('coord'):
            g = None  # rum-knapperne gælder den aktive gruppe; den er ikke denne
    if g:
        tryk(knap('.lyd-chips button', navn))
        skilt = wait(lambda: not any(ud in x['members'] and x['coord'] == g['coord'] for x in lyd()['sonos']['groups']), 15, 1)
        ok(skilt, f'{navn} er taget ud af gruppen')
        ok(wait(lambda: len(sonos_kort()) == n0 + 1, 10), 'og står nu som sin egen gruppe')
        tryk(knap('.lyd-chips button', navn))
        samlet = wait(lambda: any(set(x['members']) == set(g['members']) for x in lyd()['sonos']['groups']), 15, 1)
        ok(samlet, f'og sat ind igen: {[(x["coord"], x["members"]) for x in lyd()["sonos"]["groups"]]}')
        wait(lambda: len(sonos_kort()) == n0, 10)

    # --- lydløst: Sonos-lydstyrken op og tilbage (kun når gruppen er stoppet) ---
    gruppe = next((x for x in lyd()['sonos']['groups'] if len(x['members']) > 1), lyd()['sonos']['groups'][0])
    if gruppe['state'] != 'PLAYING':
        v0 = int(gruppe['volume'])
        kort0 = sonos_kort(gruppe['coord'])[0]
        tryk(kort0.find_elements(By.CSS_SELECTOR, '.lyd-skru')[1])
        vist = kort0.find_element(By.CSS_SELECTOR, '.lyd-niveau b').text
        ok(vist == str(v0 + 2), f'+ viser den nye lydstyrke med det samme ({v0} -> {vist})')
        ok(wait(lambda: int(next(x for x in lyd()['sonos']['groups'] if x['coord'] == gruppe['coord'])['volume']) == v0 + 2, 10, 1),
           'og Sonos er skruet op')
        kort0 = sonos_kort(gruppe['coord'])[0]
        tryk(kort0.find_elements(By.CSS_SELECTOR, '.lyd-skru')[0])
        ok(wait(lambda: int(next(x for x in lyd()['sonos']['groups'] if x['coord'] == gruppe['coord'])['volume']) == v0, 10, 1),
           f'− skruer tilbage til {v0}')

    # --- radioens lydstyrke: ét trin op og ned ---
    r0 = lyd()['radio'].get('lydstyrke')
    if r0 is not None:
        rk = d.find_element(By.CSS_SELECTOR, '.lyd-kort.radio')
        tryk(rk.find_elements(By.CSS_SELECTOR, '.lyd-skru')[1])
        ok(wait(lambda: lyd()['radio'].get('lydstyrke') == r0 + 1, 10, 1), f'radioen: + ({r0} -> {r0 + 1})')
        tryk(rk.find_elements(By.CSS_SELECTOR, '.lyd-skru')[0])
        ok(wait(lambda: lyd()['radio'].get('lydstyrke') == r0, 10, 1), f'og − tilbage til {r0}')

    # --- spaen (den gamle S1-forstærker): kortet, timeren og lydstyrken ---
    sp0 = lyd().get('spa') or {}
    spa = wait(lambda: d.find_element(By.CSS_SELECTOR, '.lyd-kort.spa'), 10)
    ok(spa, 'spaen har sit eget kort (det tredje)')
    if spa and sp0.get('spiller') is not None:
        tekst = spa.text
        chips = [b.text for b in spa.find_elements(By.CSS_SELECTOR, '.qchip')]
        ok(all(v in chips for v in ('30 min', '1 t', '2 t', '3 t', '4 t')) and 'DR P4 Nordjylland' in chips,
           f'sluk-timer og favoritter: {chips[:6]}')
        valgt = [b.text for b in spa.find_elements(By.CSS_SELECTOR, '.qchip.on')]
        ok(f"{sp0['minutter'] // 60} t" in valgt or f"{sp0['minutter']} min" in valgt, f'den valgte længde er tændt: {valgt}')
        if sp0.get('spiller'):
            ok('slukker kl.' in tekst, f"viser hvornår den slukker: {[l for l in tekst.splitlines() if 'slukker' in l]}")
            m0 = sp0['minutter']
            andet = 180 if m0 != 180 else 240
            navn = {180: '3 t', 240: '4 t'}[andet]
            tryk(next(b for b in spa.find_elements(By.CSS_SELECTOR, '.qchip') if b.text == navn))
            ok(wait(lambda: abs((lyd()['spa'].get('sluk_om') or 0) - andet * 60) < 120, 10, 1), f'{navn}: forstærkerens timer følger med')
            tilbage = {30: '30 min', 60: '1 t', 120: '2 t', 180: '3 t', 240: '4 t'}[m0]
            spa = d.find_element(By.CSS_SELECTOR, '.lyd-kort.spa')
            tryk(next(b for b in spa.find_elements(By.CSS_SELECTOR, '.qchip') if b.text == tilbage))
            ok(wait(lambda: lyd()['spa'].get('minutter') == m0, 10, 1), f'og tilbage til {tilbage}')
        v0 = sp0.get('lydstyrke')
        if v0 is not None:
            spa = d.find_element(By.CSS_SELECTOR, '.lyd-kort.spa')
            tryk(spa.find_elements(By.CSS_SELECTOR, '.lyd-skru')[1])
            ok(wait(lambda: lyd()['spa'].get('lydstyrke') == v0 + 2, 10, 1), f'spaen: + ({v0} -> {v0 + 2})')
            tryk(spa.find_elements(By.CSS_SELECTOR, '.lyd-skru')[0])
            ok(wait(lambda: lyd()['spa'].get('lydstyrke') == v0, 10, 1), f'og − tilbage til {v0}')
        d.save_screenshot(os.path.join(SHOTS, '41-lyd-spa.png'))

    efter = lyd()
    ok([sorted(x['members']) for x in efter['sonos']['groups']] == [sorted(x['members']) for x in g0]
       and efter['radio'].get('spiller') == foer['radio'].get('spiller')
       and (efter.get('spa') or {}).get('spiller') == (foer.get('spa') or {}).get('spiller'), 'alt står som før testen')
    fejl = [e for e in d.get_log('browser') if e['level'] == 'SEVERE' and '192.168' not in e['message']]
    ok(not fejl, f'ingen fejl i konsollen ({[e["message"][:120] for e in fejl]})')
finally:
    d.quit()

print('\n%d af %d gik igennem' % (sum(1 for r in RESULT if r[0]), len(RESULT)))
sys.exit(0 if all(r[0] for r in RESULT) else 1)
