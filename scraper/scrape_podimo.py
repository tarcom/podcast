#!/usr/bin/env python3
"""Podimo-scraper til All DK Podcasts.

Podimo er paywalled og kræver en rigtig browser (JS + Cloudflare) at scrape — det
kan one.com's PHP ikke, så denne kører på HTPC'en via cron og fodrer NordPod/All DK
Podcasts' database over dens PHP-API.

Flow:
  1. Hent favoritter (deviceId=allan-main), filtrér added_via=='podimo'.
  2. For hvert show: render show-siden headless, træk afsnit ud af de indlejrede
     ld+json PodcastEpisode-blokke (uuid, navn, dato, beskrivelse, varighed) + show-titel/billede.
  3. POST til ?action=podimo.ingest → gemmes som link-out-afsnit (ingen audio_url).

Kør via cron, fx hvert 30. min.
"""
import html as ihtml
import json
import re
import sys
import time
import traceback
from datetime import datetime

import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By

SITE = "https://aogj.com/podcast/api/index.php"
DEVICE = "allan-main"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36")


def log(*a):
    print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def chrome():
    o = Options()
    for a in ("--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
              "--window-size=1300,2400", "--lang=da-DK", f"--user-agent={UA}",
              "--disable-blink-features=AutomationControlled"):
        o.add_argument(a)
    d = webdriver.Chrome(options=o)
    d.set_page_load_timeout(45)
    return d


def iso_to_epoch(s):
    if not s:
        return 0
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except Exception:
        return 0


def iso_duration_to_sec(s):
    # "PT5099S" / "PT1H24M30S"
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return 0
    h, mi, se = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + se


def meta(html, prop):
    m = re.search(r'<meta[^>]+(?:property|name)="' + re.escape(prop) + r'"[^>]+content="([^"]*)"', html)
    return m.group(1) if m else ""


def scrape_show(d, show_url):
    d.get(show_url)
    time.sleep(7)
    # scroll lidt for at loade evt. flere afsnit
    for y in range(0, 5000, 800):
        d.execute_script(f"window.scrollTo(0,{y})")
        time.sleep(0.4)
    html = d.page_source

    # h1 er den rene show-titel (fx "Her Går Det Godt"); og:title har tagline+"| Podimo"
    show_title = ""
    try:
        show_title = d.find_element(By.CSS_SELECTOR, "h1").text.strip()
    except Exception:
        pass
    if not show_title:
        show_title = ihtml.unescape(meta(html, "og:title")).split(" | ")[0].split(": ")[0].strip()
    show_image = meta(html, "og:image")

    # DOM-kort: uuid -> artwork
    art = {}
    for a in d.find_elements(By.CSS_SELECTOR, 'a[data-testid^="podcast-episode-"]'):
        href = a.get_attribute("href") or ""
        mm = re.search(r"/episode/([0-9a-f-]{36})", href)
        if not mm:
            continue
        try:
            img = a.find_element(By.CSS_SELECTOR, "img").get_attribute("src")
        except Exception:
            img = ""
        art[mm.group(1)] = img or ""

    # ld+json PodcastEpisode-blokke (uuid i script-id)
    episodes = []
    for m in re.finditer(r'<script id="episodeSeo([0-9a-f-]{36})"[^>]*>(.*?)</script>', html, re.S):
        uuid, blob = m.group(1), m.group(2)
        try:
            j = json.loads(blob)
        except Exception:
            continue
        episodes.append({
            "uuid": uuid,
            "name": ihtml.unescape((j.get("name") or "").strip()),
            "datePublished": iso_to_epoch(j.get("datePublished")),
            "description": ihtml.unescape((j.get("description") or "").strip()),
            "duration": iso_duration_to_sec(j.get("duration")),
            "url": j.get("url") or f"{show_url}/episode/{uuid}",
            "image": art.get(uuid) or show_image,
        })
    return {"title": show_title, "image": show_image, "episodes": episodes}


def main():
    try:
        favs = requests.get(SITE, params={"action": "favorites.list", "deviceId": DEVICE},
                            timeout=30).json().get("items", [])
    except Exception:
        log("Kunne ikke hente favoritter:\n" + traceback.format_exc())
        sys.exit(1)

    shows = [f for f in favs if f.get("added_via") == "podimo" and f.get("feed_url")]
    if not shows:
        log("Ingen Podimo-shows at scrape")
        return

    d = chrome()
    try:
        for f in shows:
            url = f["feed_url"]
            try:
                data = scrape_show(d, url)
            except Exception:
                log(f"[{url}] scrape-FEJL:\n{traceback.format_exc()}")
                continue
            payload = {"url": url, "title": data["title"], "image": data["image"],
                       "episodes": data["episodes"]}
            try:
                r = requests.post(SITE, params={"action": "podimo.ingest"}, json=payload, timeout=60)
                r.raise_for_status()
                log(f"[{data['title'] or url}] {len(data['episodes'])} afsnit → {r.json()}")
            except Exception:
                log(f"[{url}] ingest-FEJL:\n{traceback.format_exc()}")
    finally:
        d.quit()


if __name__ == "__main__":
    main()
