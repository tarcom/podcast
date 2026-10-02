# -*- coding: utf-8 -*-
"""HTPC-cron hvert 10. minut (run_tick.sh). To ting, hver for sig:

1. Opdatér ALLE feeds på serveren, så køen er frisk, før appen overhovedet åbnes. Appen
   tjekker stadig selv ved åbning (den skal virke uden denne cron), men finder så som regel
   intet forældet. episodes.refresh tager højst 8 feeds pr. kald, så vi kalder til den er tom.
2. Send de torrents, qBittorrent har gjort færdige de sidste 7 dage, til torrent.ingest. Det
   er idempotent (nøglen er torrentens hash), så der sendes det samme hver gang — det der er
   nyt, er det serveren svarer med i `added`.

Kun standardbiblioteket. Skriver kun til loggen når der skete noget, eller noget fejlede.
"""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

API = "https://aogj.com/podcast/api/index.php"
DEV = "allan-main"
UA = "AllDKPodcasts/1.0"  # simply/one.com's WAF afviser urllib's egen user-agent
QBT = "http://localhost:8080/api/v2/torrents/info?filter=completed"  # WebUI\LocalHostAuth=false
CONFIG = Path(__file__).resolve().parent.parent / "api" / "config.php"
MAX_AGE = 300          # 5 min (serverens minimum): 540 sprang feeds over, som appen havde hentet 8 min. før
PER_CALL = 8           # = PODCAST_MAX_REFRESH_PER_CALL i podcast_store.php
TORRENT_DAYS = 7


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M} {msg}", flush=True)


def call(action, body=None, **params):
    params["action"] = action
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + "?" + urllib.parse.urlencode(params), data=data,
        method="POST" if body is not None else "GET",
        headers={"User-Agent": UA, "Content-Type": "application/json"})
    for forsoeg in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            # Varnish foran one.com svarer 429 ved mange kald i træk
            if e.code != 429 or forsoeg == 3:
                # API'et lægger årsagen i `details` — uden den er en 500 umulig at fejlsøge
                raise RuntimeError(f"{action}: HTTP {e.code} {e.read()[:300]!r}") from None
            time.sleep(5)


def refresh_feeds():
    feeds = inserted = 0
    for _ in range(10):
        res = call("episodes.refresh", deviceId=DEV, maxAge=MAX_AGE)
        feeds += int(res.get("feeds", 0))
        inserted += int(res.get("inserted", 0))
        if int(res.get("feeds", 0)) < PER_CALL:
            break
        time.sleep(1)
    if inserted:
        log(f"feeds: {inserted} nye afsnit ({feeds} feeds tjekket)")


def ingest_key():
    m = re.search(r"'ingest_key'\s*=>\s*'([0-9a-f]{32,})'", CONFIG.read_text())
    if not m:
        raise RuntimeError(f"ingen ingest_key i {CONFIG}")
    return m.group(1)


def send_torrents():
    with urllib.request.urlopen(QBT, timeout=20) as r:
        alle = json.load(r)
    graense = time.time() - TORRENT_DAYS * 86400
    nye = [
        {"hash": t.get("infohash_v1") or t["hash"], "name": t["name"],
         "size": int(t.get("size") or t.get("total_size") or 0),
         "completedAt": int(t["completion_on"])}
        for t in alle
        if int(t.get("completion_on") or 0) > graense and int(t.get("amount_left") or 0) == 0
    ]
    if not nye:
        return
    res = call("torrent.ingest", {"key": ingest_key(), "torrents": nye})
    for navn in res.get("added", []):
        log(f"torrent: {navn}")


if __name__ == "__main__":
    for opgave in (refresh_feeds, send_torrents):
        try:
            opgave()
        except Exception as e:  # den ene må ikke vælte den anden
            log(f"{opgave.__name__} FEJL: {e!r}")
