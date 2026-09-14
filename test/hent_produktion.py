# -*- coding: utf-8 -*-
"""Hent de rigtige DR-favoritter og deres cachede afsnit fra den live app.

Skriver /tmp/produktion.json, som toerkoersel.php seeder engangsbasen med, saa
toerkoerslen koerer mod en tro kopi af produktionens cache - ikke mod et gaet.
"""
import json
import urllib.parse
import urllib.request

API = "https://aogj.com/podcast/api/index.php"
DEV = "allan-main"


def kald(action, **p):
    p["action"] = action
    p["deviceId"] = DEV
    u = API + "?" + urllib.parse.urlencode(p)
    r = urllib.request.urlopen(urllib.request.Request(
        u, headers={"User-Agent": "AllDKPodcasts/1.0"}), timeout=60)
    return json.load(r)


favs = kald("favorites.list")["items"]
dr = [f for f in favs
      if "dr.dk" in (f.get("feed_url") or "") and "/drtv/" not in (f.get("feed_url") or "")]

ud = []
for f in dr:
    eps = kald("episodes.feed", id=f["feed_id"], max=2000).get("items", [])
    ud.append({"feed_id": f["feed_id"], "title": f["title"],
               "feed_url": f["feed_url"], "episodes": eps})
    med_lyd = sum(1 for e in eps if e.get("audio_url") or e.get("audioUrl"))
    print("%-28s feed %-9s afsnit i cachen: %4d  heraf med lyd: %4d"
          % (f["title"][:28], f["feed_id"], len(eps), med_lyd))

with open("/tmp/produktion.json", "w", encoding="utf-8") as fh:
    json.dump(ud, fh, ensure_ascii=False)
print("\nskrevet til /tmp/produktion.json")
if ud:
    print("felter pr. afsnit:", sorted(ud[0]["episodes"][0].keys()) if ud[0]["episodes"] else "(tom)")
