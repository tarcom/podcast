#!/usr/bin/env bash
# Oprydning i /5TB_DISK/Torrents (HTPC cron). Se oprydning.py.
cd /home/allan/podcast/scraper || exit 1
exec 9>/tmp/oprydning.lock
flock -n 9 || exit 0
exec /usr/bin/python3 oprydning.py "$@"
