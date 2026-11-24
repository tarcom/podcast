#!/usr/bin/env python3
"""Rapport over podcast-app'ens log (api/logg.php, skrevet af web/src/lib/logg.ts og Android-app'en).

  python3 scraper/podcastlog.py                     de sidste 7 dage, en linje pr. dag + hvad der gik galt
  python3 scraper/podcastlog.py --dage 30
  python3 scraper/podcastlog.py --fra "2026-11-24 09:30" --til "2026-11-24 10:15" --tidslinje
  python3 scraper/podcastlog.py --dage 1 --tidslinje --kun-galt
  python3 scraper/podcastlog.py --enhed claude-test   testenes enhed (testproxyen skriver dér)

Tider er dansk tid. Læsning kræver ingest-nøglen fra api/config.php (som tick.py). Kun stdlib.
"""
import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

API = "https://aogj.com/podcast/api/index.php"
CONFIG = Path(__file__).resolve().parent.parent / "api" / "config.php"
TZ = ZoneInfo("Europe/Copenhagen")
UGEDAGE = ["ma", "ti", "on", "to", "fr", "lø", "sø"]
FEJLKODER = {1: "afbrudt", 2: "netværk", 3: "afkodning", 4: "kilde/ingen forbindelse"}
# Hændelser, der viser, at noget gik galt (eller blev rettet) — til --kun-galt
GALT = ("lyd:fejl", "lyd:stalled", "genindlaes", "opgivet", "offline", "online", "start", "genskabt",
        "ny-udgave", "n:afslut", "n:renderer", "n:swipe", "n:webview", "n:service", "kan-ikke", "synk")


def noegle():
    m = re.search(r"'ingest_key'\s*=>\s*'([0-9a-f]{32,})'", CONFIG.read_text())
    if not m:
        sys.exit(f"ingen ingest_key i {CONFIG}")
    return m.group(1)


def hent(enhed, fra_ms, til_ms):
    """Alle hændelser i perioden (i bidder på 50.000)."""
    key, ud = noegle(), []
    while True:
        q = urllib.parse.urlencode({"action": "log.list", "deviceId": enhed, "fra": fra_ms, "til": til_ms, "limit": 50000})
        req = urllib.request.Request(f"{API}?{q}", headers={"X-Log-Key": key, "User-Agent": "AllDKPodcastsLog/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r:
            items = json.load(r)["items"]
        ud += items
        if len(items) < 50000:
            return ud
        fra_ms = items[-1]["t"] + 1


def lokal(ms):
    return datetime.fromtimestamp(ms / 1000, TZ)


def varighed(sek):
    sek = int(sek)
    if sek < 60:
        return f"{sek} s"
    t, m = divmod(sek // 60, 60)
    return f"{t} t {m:02d}" if t else f"{m} min"


def afsender(pkg):
    """Hvem sendte en kommando til Android-app'ens afspiller (n:kommando)."""
    p = (pkg or "").lower()
    if "bluetooth" in p:
        return "bil/Bluetooth"
    if "systemui" in p:
        return "notifikation/låseskærm"
    if p == "dk.aogj.podcast":
        return "app'en selv"
    return p or "ukendt"


def kort_data(d):
    if not d:
        return ""
    vis = []
    for k, v in d.items():
        if k in ("titel", "podcast", "besked"):
            v = f'"{v}"'
        vis.append(f"{k}={v}")
    return " ".join(vis)


def tidslinje(items, kun_galt):
    titler = {}
    for i in items:
        d = i.get("data") or {}
        if i["type"] in ("afsnit", "genskabt") and d.get("ep"):
            titler[d["ep"]] = d.get("titel", "")
    forrige = None
    for i in items:
        if kun_galt and not i["type"].startswith(GALT):
            continue
        t = lokal(i["t"])
        if forrige and (t - forrige) > timedelta(minutes=30):
            print("   ⋯")
        forrige = t
        d = dict(i.get("data") or {})
        ep = d.get("ep")
        extra = f'  ({titler[ep][:40]})' if ep in titler and i["type"] not in ("afsnit", "genskabt") else ""
        print(f"{t:%d.%m %H:%M:%S}.{t.microsecond // 1000:03d}  {i['type']:<13} {kort_data(d)}{extra}")


def rapport(items, fra, til, enhed):
    print(f"Podcast-loggen for {enhed}, {fra:%d.%m %H:%M} - {til:%d.%m %H:%M}: {len(items)} hændelser\n")
    if not items:
        return
    dage = defaultdict(Counter)
    lyttet = defaultdict(float)
    fejlkoder, fejlbeskeder, kilder, afsendere, afslut = Counter(), Counter(), Counter(), Counter(), Counter()
    genindl, genindl_ok = Counter(), Counter()
    ventetider, versioner, net = [], Counter(), Counter()
    aaben = None  # (start-ms, sidste-ms) for et stykke, der spiller
    for n, i in enumerate(items):
        d, typ, t = i.get("data") or {}, i["type"], i["t"]
        dag = lokal(t).date()
        if typ == "start":
            if aaben:
                lyttet[lokal(aaben[0]).date()] += (aaben[1] - aaben[0]) / 1000
                aaben = None
            dage[dag]["sider"] += 1
            versioner[f"web {d.get('build', '?')}" + (f", app {d['app']}" if d.get("app") else "")] += 1
        if d.get("net"):
            net[d["net"]] += 1
        if typ == "lyd:spiller":
            if not aaben:
                aaben = [t, t]
            if (d.get("ventetMs") or 0) > 5000:
                ventetider.append((d["ventetMs"] / 1000, t))
        elif aaben and typ in ("lyd:pause", "lyd:venter", "lyd:fejl", "lyd:slut", "luk"):
            lyttet[lokal(aaben[0]).date()] += (t - aaben[0]) / 1000
            aaben = None
        elif aaben:
            aaben[1] = t
        if typ == "afsnit":
            dage[dag]["afsnit"] += 1
        elif typ == "afspil":
            kilder[d.get("kilde", "?")] += 1
        elif typ == "lyd:fejl":
            dage[dag]["fejl"] += 1
            kode = d.get("err")
            fejlkoder[f"{kode} {FEJLKODER.get(kode, '')}".strip()] += 1
            if d.get("besked"):
                fejlbeskeder[d["besked"][:90]] += 1
            if d.get("kurs") in ("proev-igen", "paa-pause"):
                dage[dag]["udfald"] += 1
            elif d.get("kurs") == "kan-ikke":
                dage[dag]["popup"] += 1
        elif typ == "genindlaes":
            hv = d.get("hvorfor", "?")
            genindl[hv] += 1
            dage[dag]["genindl"] += 1
            # lykkedes det? spillede samme afsnit inden for 60 sek.?
            for j in items[n + 1:]:
                if j["t"] - t > 60_000:
                    break
                if j["type"] == "lyd:spiller" and (j.get("data") or {}).get("ep") == d.get("ep"):
                    genindl_ok[hv] += 1
                    break
        elif typ == "opgivet":
            dage[dag]["opgivet"] += 1
        elif typ == "n:kommando":
            afsendere[f"{afsender(d.get('pkg'))}: {d.get('cmd', '?')}"] += 1
        elif typ == "n:afslut":
            afslut[f"{d.get('proces', '?')}: {d.get('grund', '?')}"] += 1
        elif typ == "n:renderer":
            dage[dag]["renderer"] += 1
    if aaben:
        lyttet[lokal(aaben[0]).date()] += (aaben[1] - aaben[0]) / 1000

    print(f"{'Dag':<9} {'Sider':>5} {'Lyttet':>8} {'Afsnit':>6} {'Fejl':>5} {'Udfald':>6} {'Genindl.':>8} {'Opgivet':>7} {'Pop-up':>6}")
    dag = fra.date()
    while dag <= til.date():
        c = dage.get(dag, Counter())
        if c or lyttet.get(dag):
            print(f"{UGEDAGE[dag.weekday()]} {dag:%d.%m}  {c['sider']:>5} {varighed(lyttet.get(dag, 0)):>8} {c['afsnit']:>6} "
                  f"{c['fejl']:>5} {c['udfald']:>6} {c['genindl']:>8} {c['opgivet']:>7} {c['popup']:>6}")
        dag += timedelta(days=1)
    print()
    if fejlkoder:
        print("Lydens fejl:", ", ".join(f"{k} × {v}" for k, v in fejlkoder.most_common()))
        for b, v in fejlbeskeder.most_common(5):
            print(f"   {v} × {b}")
    if genindl:
        print("Hentet forfra:", ", ".join(f"{k} {v} (spillede igen {genindl_ok[k]})" for k, v in genindl.most_common()))
    if ventetider:
        laengst = max(ventetider)
        print(f"Ventede over 5 sek. på data: {len(ventetider)} gange, i alt {varighed(sum(v for v, _ in ventetider))}, "
              f"længst {laengst[0]:.0f} s ({lokal(laengst[1]):%d.%m %H:%M})")
    if kilder:
        print("Afspil kom fra:", ", ".join(f"{k} {v}" for k, v in kilder.most_common()),
              "  (ui = knapperne, ms = notifikation/låseskærm/bil, koe = tryk i køen, tv = Fortsæt på telefonen)")
    if afsendere:
        print("Android, kommandoer:", ", ".join(f"{k} × {v}" for k, v in afsendere.most_common()))
    if afslut:
        print("Android, processer lukket:", ", ".join(f"{k} × {v}" for k, v in afslut.most_common()))
    if net:
        print("Net (skift):", ", ".join(f"{k} {v}" for k, v in net.most_common()))
    print("Versioner:", ", ".join(f"{k} ({v} sider)" for k, v in versioner.most_common()))


def tid(tekst, slut=False):
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            t = datetime.strptime(tekst, fmt).replace(tzinfo=TZ)
            return t + timedelta(days=1) if slut and fmt == "%Y-%m-%d" else t
        except ValueError:
            pass
    sys.exit(f'forstår ikke tiden "{tekst}" (brug "2026-11-24 09:30" eller "2026-11-24")')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dage", type=float, default=7)
    p.add_argument("--fra")
    p.add_argument("--til")
    p.add_argument("--enhed", default="allan-main")
    p.add_argument("--tidslinje", action="store_true", help="hver hændelse for sig")
    p.add_argument("--kun-galt", action="store_true", help="i tidslinjen: kun fejl, udfald, genstarter o.l.")
    p.add_argument("--type", help="kun hændelser, hvis type begynder sådan (fx lyd: eller n:)")
    a = p.parse_args()
    til = tid(a.til, True) if a.til else datetime.now(TZ)
    fra = tid(a.fra) if a.fra else til - timedelta(days=a.dage)
    items = hent(a.enhed, int(fra.timestamp() * 1000), int(til.timestamp() * 1000))
    if a.type:
        items = [i for i in items if i["type"].startswith(a.type)]
    if a.tidslinje:
        tidslinje(items, a.kun_galt)
    else:
        rapport(items, fra, til, a.enhed)


if __name__ == "__main__":
    main()
