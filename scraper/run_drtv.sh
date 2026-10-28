#!/usr/bin/env bash
# All DK Podcasts — DR TV-afsnit som video i /5TB_DISK/Torrents (HTPC cron). Se drtv_hent.py.
cd /home/allan/podcast/scraper || exit 1
exec 9>/tmp/drtv_hent.lock
flock -n 9 || exit 0  # forrige kørsel henter stadig
# yt-dlp skal følge med, når DR ændrer noget: opdatér højst én gang i døgnet
if [ -z "$(find .yt-dlp-opdateret -mtime -1 2>/dev/null)" ]; then
  .venv/bin/pip install -q --disable-pip-version-check -U yt-dlp && touch .yt-dlp-opdateret
fi
.venv/bin/python drtv_hent.py
