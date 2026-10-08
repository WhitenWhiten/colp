#!/bin/sh
# deploy/compose.yaml mounts colp-web on /srv/web. Refresh the persistent web volume from the image
# on every start, including upgrades. This volume holds only shipped assets. Caddy serves the same volume read-only.
set -eu

if [ -f /opt/colp-web/index.html ]; then
  mkdir -p /srv/web
  find /srv/web -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  cp -a /opt/colp-web/. /srv/web/
  if [ "$(id -u)" -eq 0 ]; then
    chown -R node:node /srv/web
  fi
fi

if [ "$(id -u)" -eq 0 ]; then
  exec su-exec node "$@"
fi
exec "$@"
