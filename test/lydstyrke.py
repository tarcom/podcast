"""Læs eller sæt lydstyrken på en Google Home (køres på HTPC med ~/tv/.venv/bin/python, se test_nyt.py):

    ssh htpc ~/tv/.venv/bin/python - "Google home soveværelset" [0.05] < test/lydstyrke.py

Skriver lydstyrken FØR (0-1), så testen kan lægge den tilbage bagefter."""
import sys
import time

import pychromecast

navn = sys.argv[1]
casts, browser = pychromecast.get_listed_chromecasts(friendly_names=[navn], timeout=8)
try:
    cc = casts[0]
    cc.wait(timeout=10)
    print(f'{cc.status.volume_level:.3f}')
    if len(sys.argv) > 2:
        cc.set_volume(float(sys.argv[2]))
        time.sleep(1)
finally:
    pychromecast.discovery.stop_discovery(browser)
