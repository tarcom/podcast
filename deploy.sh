#!/usr/bin/env bash
# Deploy NordPod to aogj.com/podcast (one.com, FTP only — no SSH).
#
#   ./deploy.sh api      # upload api/*.php  (config.php included — it's needed on the server)
#   ./deploy.sh web      # build web/ and upload web/dist/* to /podcast
#   ./deploy.sh          # both
#
# Creds in .ftp-credentials (gitignored): FTP_HOST, FTP_USER, FTP_PASS. Shared with the other
# aogj.com projects.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/.ftp-credentials"
REMOTE_ROOT="/podcast"

upload() { # <local> <remote-path>
    curl -sS --fail --ftp-create-dirs --user "${FTP_USER}:${FTP_PASS}" \
        -T "$1" "ftp://${FTP_HOST}${REMOTE_ROOT}/$2" && echo "  OK  $2"
}

do_api() {
    echo "Uploading API to ftp://${FTP_HOST}${REMOTE_ROOT}/api/"
    for f in "$SCRIPT_DIR"/api/*.php; do
        upload "$f" "api/$(basename "$f")"
    done
}

do_web() {
    echo "Building frontend..."
    ( cd "$SCRIPT_DIR/web" && npm run build )
    echo "Uploading web/dist to ftp://${FTP_HOST}${REMOTE_ROOT}/"
    ( cd "$SCRIPT_DIR/web/dist" && find . -type f | while read -r f; do
        rel="${f#./}"
        upload "$f" "$rel"
    done )
}

case "${1:-all}" in
    api) do_api ;;
    web) do_web ;;
    all) do_api; do_web ;;
    *) echo "usage: ./deploy.sh [api|web|all]"; exit 1 ;;
esac
echo "Done."
