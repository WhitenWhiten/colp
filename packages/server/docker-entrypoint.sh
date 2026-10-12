#!/bin/sh
# deploy/compose.yaml mounts colp-web on /srv/web. Refresh the persistent web volume from the image
# on every start, including upgrades. This volume holds only shipped assets. Caddy serves the same volume read-only.
set -eu

if [ -f /opt/colp-web/index.html ]; then
  # Open tabs may still request a previous release's lazy CSS/JS. Keep hashed
  # assets and publish every dependency before atomically replacing the HTML.
  mkdir -p /srv/web/assets
  cp -a /opt/colp-web/assets/. /srv/web/assets/
  for source in /opt/colp-web/*; do
    case "$source" in
      /opt/colp-web/assets|/opt/colp-web/index.html) continue ;;
    esac
    cp -a "$source" /srv/web/
  done
  cp -a /opt/colp-web/index.html /srv/web/.index.html.next
  mv -f /srv/web/.index.html.next /srv/web/index.html
  if [ "$(id -u)" -eq 0 ]; then
    chown -R node:node /srv/web
  fi
fi

if [ "$(id -u)" -eq 0 ]; then
  exec su-exec node "$@"
fi
exec "$@"
