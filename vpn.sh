#!/usr/bin/env bash
# Turn the sidecar's VPN on or off, or show which way it is running.
#   bash vpn.sh on       route the sidecar through the VPN (needs ./vpn/wg0.conf)
#   bash vpn.sh off      back to the normal direct connection
#   bash vpn.sh status   which mode, and the address IQ Option sees
# Run it from the iqOS folder on the server. A fresh IQ login may be needed after switching, because IQ sees a different address.
set -euo pipefail
cd "$(dirname "$0")"
VPN="-f docker-compose.yml -f docker-compose.vpn.yml"
BASE="-f docker-compose.yml"
mode() { local nm; nm=$(docker inspect -f '{{.HostConfig.NetworkMode}}' iqos-sidecar 2>/dev/null || echo "none"); case "$nm" in container:*) echo "VPN";; none) echo "not running";; *) echo "direct";; esac; }
case "${1:-status}" in
  on)
    [ -f vpn/wg0.conf ] || { echo "Missing vpn/wg0.conf - put your WireGuard config there first."; exit 1; }
    docker compose $VPN up -d gluetun
    docker compose $VPN up -d --force-recreate iqos-sidecar
    echo "Sidecar is now routed through the VPN."
    ;;
  off)
    if ! curl -sS -o /dev/null -m 8 https://iqoption.com 2>/dev/null; then
      echo "WARNING: this server still CANNOT reach iqoption.com directly. Without the VPN the sidecar will not connect."
      read -r -p "Turn the VPN off anyway? [y/N] " a; [ "$a" = "y" ] || [ "$a" = "Y" ] || { echo "Left as it was."; exit 0; }
    fi
    # recreate the sidecar on the normal network FIRST, then remove the VPN container
    docker compose $BASE up -d --force-recreate --no-deps iqos-sidecar
    docker rm -f iqos-vpn >/dev/null 2>&1 || true
    echo "Sidecar is back on the direct connection."
    ;;
  status)
    echo "Sidecar mode: $(mode)"
    echo -n "Address the sidecar uses: "; docker exec iqos-sidecar python -c "import urllib.request;print(urllib.request.urlopen('https://api.ipify.org',timeout=10).read().decode())" 2>/dev/null || echo "(could not check)"
    echo -n "This server's own address: "; curl -sS -m 8 https://api.ipify.org 2>/dev/null || echo "(could not check)"; echo
    ;;
  *) echo "usage: bash vpn.sh on|off|status"; exit 1;;
esac
