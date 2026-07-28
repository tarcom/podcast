#!/usr/bin/env python3
"""
All DK Podcasts — DR Lyd-scraper (HTPC, cron).

DR lægger kun en ~40-sekunders TEASER i det offentlige RSS-feed; det fulde afsnit
(fx 57 min) ligger udelukkende i DR Lyd. De rigtige, ældre afsnit hentes af backenden
direkte fra DR's RSS (api/rssfeed.php) — dette script henter de afsnit der KUN findes
i DR Lyd, og gemmer dem som link-out (ingen audio_url), ligesom Podimo.

Hvorfor link-out og ikke afspilning: DR's playback-API svarer 401 uden en x-apikey,
og nøglen eksponeres ikke i browseren (DR kalder serverside). Se CLAUDE.md.

I modsætning til Podimo-scraperen kræver dette INGEN browser: DR's Next.js-side
leverer hele afsnitslisten i <script id="__NEXT_DATA__"> allerede i server-HTML'en.

Flow:
  1. Hent favoritter for DEVICE, behold dem med et api.dr.dk-feed.
  2. Slå DR Lyd-sidens URL op via ?action=podcast (Podcast Index' 'link'-felt).
  3. Hent siden, parse __NEXT_DATA__ → episodesGroups[].items.
  4. POST til ?action=dr.ingest (backenden springer afsnit over der allerede
     findes afspilleligt fra RSS).
"""

import json
import re
import sys
import traceback
from datetime import datetime

import requests

SITE = "https://aogj.com/podcast/api/index.php"
DEVICE = "allan-main"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36")
TIMEOUT = 30


def log(*a):
    print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def iso_to_epoch(s):
    """'2026-06-25T05:00:00+02:00' -> unix-sekunder."""
    if not s:
        return 0
    try:
        return int(datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp())
    except Exception:
        return 0


def image_url(assets):
    """Byg en billed-URL ud fra DR's imageAssets (foretrækker kvadratisk)."""
    if not assets:
        return ""
    pick = next((a for a in assets if a.get("ratio") == "1:1"), assets[0])
    aid = pick.get("id")
    if not aid:
        return ""
    return f"https://asset.dr.dk/drlyd/images/{aid}?im=Resize%3D%28480%2C480%29"


def next_data(html):
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


def scrape_series(page_url):
    """Returnér afsnit fra en DR Lyd-serieside."""
    r = requests.get(page_url, headers={"User-Agent": UA}, timeout=TIMEOUT)
    r.raise_for_status()
    d = next_data(r.text)
    if not d:
        raise RuntimeError("ingen __NEXT_DATA__ på siden")

    groups = (d.get("props", {}).get("pageProps", {}).get("episodesGroups") or [])
    out = []
    for g in groups:
        for e in (g.get("items") or []):
            # kun rigtige afsnit med lyd — ikke trailere/videoklip uden asset
            if not e.get("hasAudioAssets"):
                continue
            pn = e.get("productionNumber")
            if not pn:
                continue
            out.append({
                "productionNumber": str(pn),
                "title": (e.get("title") or "").strip() or "Episode",
                "description": (e.get("description") or "").strip(),
                "publishedAt": iso_to_epoch(e.get("startTime")),
                "durationSec": int(round((e.get("durationMilliseconds") or 0) / 1000)),
                "url": e.get("presentationUrl") or "",
                "image": image_url(e.get("imageAssets")),
            })
    return out


def main():
    log("=== DR Lyd-scraper starter ===")
    favs = requests.get(SITE, params={"action": "favorites.list", "deviceId": DEVICE},
                        timeout=TIMEOUT).json().get("items", [])
    dr = [f for f in favs if "dr.dk" in str(f.get("feed_url") or "")]
    log(f"{len(dr)} DR-podcasts blandt {len(favs)} favoritter")

    total_added = 0
    for f in dr:
        feed_id = int(f["feed_id"])
        title = f.get("title") or feed_id
        try:
            # DR Lyd-sidens URL kommer fra Podcast Index' 'link'-felt
            info = requests.get(SITE, params={"action": "podcast", "id": feed_id},
                                timeout=TIMEOUT).json()
            page = (info.get("feed") or {}).get("link") or ""
            if "dr.dk/lyd" not in page:
                log(f"[{title}] ingen DR Lyd-side kendt ({page or 'tom'}) — springer over")
                continue

            eps = scrape_series(page)
            if not eps:
                log(f"[{title}] ingen afsnit fundet på {page}")
                continue

            res = requests.post(SITE, params={"action": "dr.ingest"},
                                json={"deviceId": DEVICE, "feedId": feed_id, "episodes": eps},
                                timeout=60).json()
            added = res.get("added", 0)
            total_added += added
            log(f"[{title}] {len(eps)} afsnit på siden -> tilføjet {added}, "
                f"sprunget over som dublet {res.get('skippedAsDuplicate', 0)}")
        except Exception:
            log(f"[{title}] FEJL:\n{traceback.format_exc()}")

    log(f"=== færdig, {total_added} nye link-out-afsnit ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
