#!/bin/sh
# deploy/compose.yaml mounts colp-web on /srv/web. An empty mount hides the
# image files there, so seed from /opt/colp-web. A mount that already has
# index.html is left unchanged. Caddy serves the same volume read-only.
set -eu

if [ ! -e /srv/web/index.html ] && [ -f /opt/colp-web/index.html ]; then
  mkdir -p /srv/web
  cp -a /opt/colp-web/. /srv/web/
  if [ "$(id -u)" -eq 0 ]; then
    chown -R node:node /srv/web
  fi
fi

if [ "$(id -u)" -eq 0 ]; then
  exec su-exec node "$@"
fi
exec "$@"
