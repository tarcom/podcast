#!/usr/bin/env bash
# All DK Podcasts — feeds + torrents hvert 10. minut (HTPC cron). Se tick.py.
cd /home/allan/podcast/scraper || exit 1
exec /usr/bin/python3 tick.py
