#!/bin/sh
set -eu

invalid_origin() {
    echo 'COLP_SERVER_ORIGIN must be an HTTPS origin with a hostname or bracketed IPv6 address' >&2
    exit 1
}

# IP clients omit SNI. Docker's local address is the container address, so
# Caddy needs the origin host as its default certificate selection name.
case "${COLP_SERVER_ORIGIN:-}" in
    https://*) authority=${COLP_SERVER_ORIGIN#https://} ;;
    *) invalid_origin ;;
esac
authority=${authority%/}
case "$authority" in
    ''|*[[:space:]]*|*'/'*|*'@'*|*'?'*|*'#'*|*'{'*|*'}'*|*'"'*|*"'"*|*\\*) invalid_origin ;;
esac

case "$authority" in
    \[*\]*)
        server_name=${authority#\[}
        server_name=${server_name%%\]*}
        suffix=${authority#*\]}
        case "$server_name" in *:*) ;; *) invalid_origin ;; esac
        ;;
    *)
        server_name=${authority%%:*}
        suffix=${authority#"$server_name"}
        ;;
esac
test -n "$server_name" || invalid_origin
case "$server_name" in *'['*|*']'*) invalid_origin ;; esac
case "$suffix" in
    '') ;;
    :*)
        port=${suffix#:}
        case "$port" in ''|*[!0-9]*) invalid_origin ;; esac
        ;;
    *) invalid_origin ;;
esac

COLP_TLS_SERVER_NAME=$(printf '%s' "$server_name" | tr '[:upper:]' '[:lower:]')
export COLP_TLS_SERVER_NAME
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
