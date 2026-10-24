#!/usr/bin/env bash
# Keep a fixed adb port (5555) open on a Google TV box that only has Wireless debugging.
#
# A reboot closes adb on 5555, but Wireless debugging comes back on its own random port and the
# pairing survives. This finds that port, connects, and runs `adb tcpip 5555` again. Run it from a
# timer (see the systemd example at the bottom); it does nothing while 5555 is already up.
#
# Usage: TV_HOST=100.74.181.47 tools/adb-keepalive.sh
# Needs: adb, and the box paired once with `adb pair <ip>:<pairing port> <code>`.
set -uo pipefail
HOST="${TV_HOST:?set TV_HOST to the box address, e.g. its Tailscale IP}"
PORT=5555
RANGE_START="${SCAN_FROM:-30000}"
RANGE_END="${SCAN_TO:-50000}"

up() { [ "$(timeout 10 adb -s "$1" get-state 2>/dev/null)" = device ]; }

timeout 15 adb connect "$HOST:$PORT" >/dev/null 2>&1
if up "$HOST:$PORT"; then exit 0; fi
adb disconnect "$HOST:$PORT" >/dev/null 2>&1

echo "$(date -Is) $HOST:$PORT down, looking for the Wireless debugging port"
for p in $(seq "$RANGE_START" "$RANGE_END" | xargs -P 400 -I{} bash -c \
    "timeout 1 bash -c '</dev/tcp/$HOST/{}' 2>/dev/null && echo {}"); do
  timeout 15 adb connect "$HOST:$p" >/dev/null 2>&1
  if up "$HOST:$p"; then
    echo "$(date -Is) Wireless debugging on $p, reopening $PORT"
    timeout 20 adb -s "$HOST:$p" tcpip "$PORT"
    sleep 4
    adb disconnect "$HOST:$p" >/dev/null 2>&1
    timeout 15 adb connect "$HOST:$PORT"
    up "$HOST:$PORT" && exit 0
  else
    adb disconnect "$HOST:$p" >/dev/null 2>&1
  fi
done
echo "$(date -Is) could not reach adb on $HOST (is the box on, on Tailscale, with Wireless debugging on?)"
exit 1

# systemd user timer, every 5 minutes (loginctl enable-linger $USER keeps it running logged out):
#   ~/.config/systemd/user/adb-keepalive.service
#     [Service]
#     Type=oneshot
#     Environment=TV_HOST=100.74.181.47
#     ExecStart=/path/to/tv-vibehack/tools/adb-keepalive.sh
#   ~/.config/systemd/user/adb-keepalive.timer
#     [Timer]
#     OnBootSec=2min
#     OnUnitActiveSec=5min
#     [Install]
#     WantedBy=timers.target
#   systemctl --user enable --now adb-keepalive.timer
