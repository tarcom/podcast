# -*- coding: utf-8 -*-
"""HTPC-cron hver halve time (run_oprydning.sh): holder 5 TB-disken fri. To ting, hver for sig:

1. Torrents, der har seedet i over 7 døgn, fjernes fra qBittorrent — FILERNE BLIVER LIGGENDE.
   Mappen er derefter en almindelig mappe i Torrents og ryger med i punkt 2, når dens tid kommer.
2. Er der under MIN_FRI fri, slettes de ældste mapper i /5TB_DISK/Torrents, til der er nok igen.
   Torrents og DR TV-afsnit (drtv_hent.py) behandles ens. /5TB_DISK/Series røres aldrig.

- Alder = hvornår mappen blev hentet: qBittorrents completion_on for de torrents, den stadig
  kender, ellers den nyeste mtime i mappen (filerne ændres ikke af at blive set i Kodi).
- Hele mappen slettes. Kender qBittorrent torrenten, slettes den dér med filerne (ellers står den
  bagefter med "manglende filer"), og hvad der er tilbage, fjernes bagefter.
- Aldrig noget hentet de sidste MIN_ALDER, aldrig noget qBittorrent ikke er færdig med, og intet
  overhovedet, hvis qBittorrent ikke svarer eller disken ikke er monteret.

`--dry-run` viser hvad der ville blive gjort; `--min-fri 900` lader som om grænsen er 900 GB.
Kun standardbiblioteket. Skriver kun til loggen når der skete noget, eller noget fejlede.
"""
import argparse
import json
import os
import shutil
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

DISK = "/5TB_DISK"
TORRENTS = Path(DISK) / "Torrents"
QBT = "http://localhost:8080/api/v2/torrents"  # WebUI\LocalHostAuth=false
MIN_FRI = 500          # GB
MIN_ALDER = 7 * 86400  # sletter aldrig noget hentet den sidste uge
SEED_DAGE = 7          # fjernes fra qBittorrent efter så lang seeding


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M} {msg}", flush=True)


def fri():
    s = os.statvfs(DISK)
    return s.f_bavail * s.f_frsize


def gb(n):
    return f"{n / 1e9:.1f} GB"


def qbt_info():
    with urllib.request.urlopen(QBT + "/info", timeout=20) as r:
        return json.load(r)


def qbt_delete(hashes, med_filer):
    data = urllib.parse.urlencode({"hashes": "|".join(hashes),
                                   "deleteFiles": "true" if med_filer else "false"}).encode()
    urllib.request.urlopen(urllib.request.Request(QBT + "/delete", data=data), timeout=20).close()


def topnavn(sti):
    """Navnet på mappen (eller filen) direkte i Torrents, som en torrents indhold ligger i."""
    rel = os.path.relpath(sti, TORRENTS)
    return None if rel == "." or rel.startswith("..") else rel.split(os.sep)[0]


def maal(sti):
    """(nyeste mtime, plads på disken) for en mappe eller fil."""
    st = sti.lstat()
    nyeste, plads = st.st_mtime, st.st_blocks * 512
    if sti.is_dir() and not sti.is_symlink():
        for rod, mapper, filer in os.walk(sti):
            for n in mapper + filer:
                s = os.lstat(os.path.join(rod, n))
                nyeste = max(nyeste, s.st_mtime)
                plads += s.st_blocks * 512
    return nyeste, plads


def fjern_seedede(torrents, dry):
    """Punkt 1: ud af qBittorrent efter SEED_DAGE seeding, filerne bliver liggende."""
    gamle = [t for t in torrents
             if int(t.get("amount_left") or 0) == 0
             and int(t.get("seeding_time") or 0) >= SEED_DAGE * 86400]
    if not gamle:
        return torrents
    if not dry:
        qbt_delete([t["hash"] for t in gamle], med_filer=False)
    for t in gamle:
        log(f"{'ville fjerne' if dry else 'fjernet'} fra qBittorrent (filerne bliver): "
            f"{t['name']} (seedet {int(t['seeding_time']) / 86400:.1f} døgn)")
    fjernede = {t["hash"] for t in gamle}
    return [t for t in torrents if t["hash"] not in fjernede]


def slet(sti, hashes):
    if sti.parent != TORRENTS:  # aldrig noget uden for Torrents, heller ikke ved en fejl
        raise RuntimeError(f"{sti} ligger ikke direkte i {TORRENTS}")
    if hashes:
        qbt_delete(hashes, med_filer=True)
        for _ in range(30):
            if not sti.exists():
                break
            time.sleep(1)
    if sti.is_dir() and not sti.is_symlink():
        shutil.rmtree(sti)
    elif sti.exists() or sti.is_symlink():
        sti.unlink()


def ryd_op(torrents, min_fri, dry):
    """Punkt 2: de ældste mapper i Torrents, til der er min_fri fri."""
    ledig = fri()
    if ledig >= min_fri:
        return
    kendte = {}  # topnavn -> hashes, hentet, færdig
    for t in torrents:
        navn = topnavn(t["content_path"])
        if not navn:
            continue
        k = kendte.setdefault(navn, {"hashes": [], "hentet": 0, "faerdig": True})
        k["hashes"].append(t["hash"])
        k["hentet"] = max(k["hentet"], int(t.get("completion_on") or 0))
        if int(t.get("amount_left") or 0) > 0 or int(t.get("completion_on") or 0) <= 0:
            k["faerdig"] = False
    kandidater = []
    for sti in TORRENTS.iterdir():
        if sti.name.startswith("."):
            continue
        k = kendte.get(sti.name)
        if k and not k["faerdig"]:
            continue
        nyeste, plads = maal(sti)
        kandidater.append((k["hentet"] if k else nyeste, sti.name, plads, k["hashes"] if k else []))
    kandidater.sort()

    graense = time.time() - MIN_ALDER
    slettet = 0
    for hentet, navn, plads, hashes in kandidater:
        if ledig >= min_fri:
            break
        if hentet > graense:
            log(f"ADVARSEL: {gb(ledig)} fri, under {gb(min_fri)}, men resten er hentet den sidste "
                f"uge — sletter ikke mere")
            break
        tekst = f"{datetime.fromtimestamp(hentet):%Y-%m-%d} {navn} ({gb(plads)}{', torrent' if hashes else ''})"
        if dry:
            log("ville slette: " + tekst)
        else:
            slet(TORRENTS / navn, hashes)
            log("slettet: " + tekst)
            slettet += 1
        ledig += plads
    if slettet:
        log(f"fri nu: {gb(fri())}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="vis kun hvad der ville ske")
    p.add_argument("--min-fri", type=float, default=MIN_FRI, help=f"GB (standard {MIN_FRI})")
    a = p.parse_args()
    if not os.path.ismount(DISK) or not TORRENTS.is_dir():
        log(f"FEJL: {DISK} er ikke monteret — gør intet")
        return
    torrents = qbt_info()  # svarer qBittorrent ikke, sker der intet (vi ved ikke hvad der er i gang)
    try:
        torrents = fjern_seedede(torrents, a.dry_run)
    except Exception as e:  # den ene må ikke vælte den anden
        log(f"fjern_seedede FEJL: {e!r}")
    ryd_op(torrents, int(a.min_fri * 1e9), a.dry_run)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FEJL: {e!r}")
