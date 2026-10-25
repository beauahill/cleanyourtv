#!/usr/bin/env python3
"""Sign guests out of the streaming apps on the bar TV after each checkout.

Run every few minutes from a timer on a machine that has adb access to the box. It reads the stay
from Home Assistant (Rental Control's sensor.rental_calendar_check_in) through the box itself, since
Home Assistant is only reachable on the rental LAN. Once WIPE_DELAY after a checkout has passed, it
clears each app's data (`pm clear`, which signs the guest out) and brings the dashboard back.

Google sign-ins (YouTube) are device accounts: clearing YouTube's data does not remove an account a
guest added under Settings > Accounts. That needs removing by hand.

Usage: checkout_wipe.py            check, and wipe when a checkout is due
       checkout_wipe.py --dry-run  print what it would do
       checkout_wipe.py --now      wipe straight away
"""
import datetime as dt
import json
import os
import subprocess
import sys

TV = os.environ.get("TV_SERIAL", "100.74.181.47:5555")
HA_HOST, HA_PORT = "192.168.4.141", 8123
TOKEN_FILE = os.path.expanduser("~/.config/laradise/ha-token")
STATE_FILE = os.path.expanduser("~/.local/state/laradise/checkout-wipe.json")
STAY_ENTITY = "sensor.rental_calendar_check_in"
WIPE_DELAY = dt.timedelta(minutes=30)
DASHBOARD = "com.laradise.dashboard/.DashboardActivity"
APPS = [
    "com.netflix.ninja",
    "com.amazon.amazonvideo.livingroom",
    "com.disney.disneyplus",
    "com.hulu.livingroomplus",
    "com.wbd.stream",
    "com.cbs.ott",
    "com.apple.atve.androidtv.appletv",
    "com.espn.score_center",
    "com.google.android.youtube.tv",
]


def adb(*args, timeout=60):
    return subprocess.run(["adb", "-s", TV, *args], capture_output=True, text=True, timeout=timeout)


def stay():
    """The stay sensor's state and attributes, fetched from Home Assistant by the box."""
    token = open(TOKEN_FILE).read().strip()
    req = (f"printf 'GET /api/states/{STAY_ENTITY} HTTP/1.0\\r\\nHost: {HA_HOST}\\r\\n"
           f"Authorization: Bearer {token}\\r\\n\\r\\n' | timeout 10 toybox nc {HA_HOST} {HA_PORT}")
    out = adb("shell", req).stdout
    body = out[out.index("{"):] if "{" in out else ""
    if not out.startswith("HTTP/1.0 200") or not body:
        raise RuntimeError("Home Assistant did not answer: " + out[:80].replace("\r", " ").replace("\n", " "))
    return json.loads(body.replace("\r\n", "\n"))


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(st):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(st, f)


def wipe(dry_run):
    installed = adb("shell", "pm list packages").stdout
    for pkg in APPS:
        if f"package:{pkg}\n" not in installed.replace("\r", "") + "\n":
            print(f"  {pkg}: not installed, skipped")
            continue
        if dry_run:
            print(f"  {pkg}: would clear")
            continue
        print(f"  {pkg}: {adb('shell', 'pm clear ' + pkg).stdout.strip()}")
    if not dry_run:
        # am start does not wake a sleeping TV, unlike the Home key.
        adb("shell", f"am start -n {DASHBOARD}")


def main():
    dry_run = "--dry-run" in sys.argv
    now = dt.datetime.now(dt.timezone.utc)
    st = load_state()
    if "--now" in sys.argv:
        print(f"{now.isoformat()} wiping now (--now)")
        wipe(dry_run)
        return

    s = stay()
    end = s.get("attributes", {}).get("end")
    if s.get("state") in ("checked_in", "awaiting_checkin") and end:
        if dt.datetime.fromisoformat(end) > now and st.get("pending_end") != end:
            st["pending_end"] = end
            save_state(st)
            print(f"{now.isoformat()} next checkout {end}")

    pending = st.get("pending_end")
    if pending and pending != st.get("wiped_end") and now >= dt.datetime.fromisoformat(pending) + WIPE_DELAY:
        print(f"{now.isoformat()} checkout {pending} passed, signing guests out")
        wipe(dry_run)
        if not dry_run:
            st["wiped_end"] = pending
            save_state(st)
    elif dry_run:
        print(f"state={s.get('state')} end={end} pending={pending} wiped={st.get('wiped_end')}: nothing due")


if __name__ == "__main__":
    main()
