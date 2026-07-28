#!/usr/bin/env bash
# All DK Podcasts — DR Lyd-scraper (HTPC cron)
cd /home/allan/podcast/scraper || exit 1
exec .venv/bin/python scrape_dr.py
