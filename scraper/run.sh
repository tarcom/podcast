#!/usr/bin/env bash
# All DK Podcasts — Podimo-scraper (HTPC cron)
cd /home/allan/podcast/scraper || exit 1
exec .venv/bin/python scrape_podimo.py
