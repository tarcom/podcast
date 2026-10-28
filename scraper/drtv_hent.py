# -*- coding: utf-8 -*-
"""HTPC-cron hver halve time (run_drtv.sh): henter nye afsnit af de DR TV-programmer, der følges i
appen, som video til /5TB_DISK/Torrents/<Program>.<dato>.<titel>/. Så ligger de mellem
torrents i Kodi, og tick.py sender dem til appens 🧲 Torrent.

- Programmerne er favoritterne med added_via 'drtv' (Debatten, Deadline, Kommissionen …).
  Robinson er Viaplay og kopibeskyttet, så den kommer ikke med.
- Afsnitslisten er appens egen cache (episodes.feed), som tick.py holder frisk hvert 10. min.
- Kun afsnit udgivet de sidste DAGE dage. Hentede står i drtv_hentet.json, så et afsnit,
  oprydning.py har slettet, ikke hentes igen; et afsnit der fejler, opgives efter MAX_FORSOEG.
- Bedste opløsning (DR's egne programmer er uden DRM, op til 1080p50), ingen undertekster.
  Hentes i /5TB_DISK/.drtv-tmp og flyttes først ind i Torrents, når filen er færdig, så hverken
  Kodi eller appen ser en halv fil.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

API = "https://aogj.com/podcast/api/index.php"
DEV = "allan-main"
UA = "AllDKPodcasts/1.0"  # simply/one.com's WAF afviser urllib's egen user-agent
DISK = "/5TB_DISK"
TORRENTS = Path(DISK) / "Torrents"
TMP = Path(DISK) / ".drtv-tmp"  # samme disk, så flytningen er et rename; uden for Torrents
STATE = Path(__file__).resolve().parent / "drtv_hentet.json"
YTDLP = Path(sys.executable).parent / "yt-dlp"
DAGE = 7
MAX_FORSOEG = 6
MIN_FRI = 50 * 10**9  # oprydning.py holder 500 GB fri; det her er kun nødbremsen


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M} {msg}", flush=True)


def call(action, **params):
    params["action"] = action
    req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params),
                                 headers={"User-Agent": UA})
    for forsoeg in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            # Varnish foran one.com svarer 429 ved mange kald i træk
            if e.code != 429 or forsoeg == 3:
                raise RuntimeError(f"{action}: HTTP {e.code} {e.read()[:300]!r}") from None
            time.sleep(5)


def laes_state():
    try:
        return json.loads(STATE.read_text())
    except FileNotFoundError:
        return {}


def gem_state(state):
    # tick.py læser filen samtidig, så den skrives hel eller slet ikke
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1))
    os.replace(tmp, STATE)


def drtv_id(link):
    m = re.search(r"/drtv/episode/[^?#]*_(\d+)", link or "")
    return m.group(1) if m else None


def mappenavn(titel, udgivet):
    """'Deadline: Drenge der hader piger' -> 'Deadline.2026-10-28.Drenge.der.hader.piger'"""
    program, _, rest = titel.partition(": ")
    s = " ".join(x for x in (program, f"{datetime.fromtimestamp(udgivet):%Y-%m-%d}", rest) if x)
    s = re.sub(r'[\\/:*?"<>|]', "", s)  # ikke tilladt i Windows/SMB
    s = re.sub(r"[\s.]+", ".", s.strip())
    return s[:150].strip(".")


def hent(ep_id, link, navn):
    arbejde = TMP / navn
    shutil.rmtree(arbejde, ignore_errors=True)
    arbejde.mkdir(parents=True)
    r = subprocess.run(
        [str(YTDLP), "--quiet", "--no-warnings", "--no-progress",
         # DR har også et spor med oplæste undertekster ("SpokenSubtitles"), det skal ikke med
         "-f", "bv*[format_id!*=SpokenSubtitles]+ba[format_id!*=SpokenSubtitles]"
               "/b[format_id!*=SpokenSubtitles]",
         "--merge-output-format", "mp4",
         "--no-write-subs", "--no-embed-subs",  # ingen undertekster (Allans valg)
         "--concurrent-fragments", "4", "--retries", "10", "--fragment-retries", "10",
         "-o", str(arbejde / f"{navn}.%(ext)s"), link],
        capture_output=True, text=True, timeout=3 * 3600)
    videoer = [f for f in arbejde.iterdir() if f.suffix in (".mp4", ".mkv")]
    if r.returncode != 0 or not videoer:
        shutil.rmtree(arbejde, ignore_errors=True)
        raise RuntimeError((r.stderr or r.stdout).strip()[-400:] or f"yt-dlp exit {r.returncode}")
    maal = TORRENTS / navn
    if maal.exists():
        maal = TORRENTS / f"{navn}.{ep_id}"
    os.rename(arbejde, maal)
    return maal, sum(f.stat().st_size for f in maal.iterdir())


def main():
    if not os.path.ismount(DISK) or not TORRENTS.is_dir():
        log(f"FEJL: {DISK} er ikke monteret")
        return
    TMP.mkdir(exist_ok=True)
    state = laes_state()
    nu = time.time()
    favoritter = [f for f in call("favorites.list", deviceId=DEV)["items"]
                  if f.get("added_via") == "drtv"]
    for fav in favoritter:
        afsnit = call("episodes.feed", deviceId=DEV, id=fav["feed_id"]).get("items") or []
        for ep in sorted(afsnit, key=lambda e: int(e.get("published_at") or 0)):
            udgivet = int(ep.get("published_at") or 0)
            ep_id = drtv_id(ep.get("link_url"))
            if not ep_id or not nu - DAGE * 86400 < udgivet <= nu:
                continue
            post = state.get(ep_id, {})
            if post.get("mappe") or post.get("forsoeg", 0) >= MAX_FORSOEG:
                continue
            s = os.statvfs(DISK)
            if s.f_bavail * s.f_frsize < MIN_FRI:
                log("FEJL: under 50 GB fri på disken — henter ikke")
                return
            try:
                maal, stoerrelse = hent(ep_id, ep["link_url"], mappenavn(ep["title"], udgivet))
            except Exception as e:
                post.update(titel=ep["title"], forsoeg=post.get("forsoeg", 0) + 1)
                state[ep_id] = post
                gem_state(state)
                log(f"FEJL {ep['title']} (forsøg {post['forsoeg']}/{MAX_FORSOEG}): {e}")
                continue
            state[ep_id] = {"titel": ep["title"], "mappe": maal.name,
                            "hentet": int(time.time()), "size": stoerrelse}
            gem_state(state)
            log(f"hentet: {maal.name} ({stoerrelse / 1e9:.1f} GB)")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FEJL: {e!r}")
