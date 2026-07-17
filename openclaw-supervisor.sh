#!/bin/sh
# Supervise the gateway so a stale Chromium/Brave profile lock can recover
# without an operator. The entrypoint clears stale Singleton* files before
# every gateway start; this wrapper only requests that restart when it sees a
# lock but the profile's CDP endpoint has remained unavailable long enough to
# rule out a normal browser startup.

set -eu

state_dir="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
cdp_port="${WEBEX_AUTO_JOIN_CDP_PORT:-18801}"
check_interval=5
failure_grace=20

node openclaw.mjs gateway &
gateway_pid=$!

stop_gateway() {
	if kill -0 "$gateway_pid" 2>/dev/null; then
		kill -TERM "$gateway_pid" 2>/dev/null || true
	fi
}

trap 'stop_gateway; wait "$gateway_pid"; exit 0' INT TERM

unhealthy_since=''
while kill -0 "$gateway_pid" 2>/dev/null; do
	locks=$(find "$state_dir" \( -name 'SingletonLock' -o -name 'SingletonSocket' -o -name 'SingletonCookie' \) -print -quit 2>/dev/null || true)
	if [ -n "$locks" ] && ! curl -fsS --max-time 1 "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1; then
		now=$(date +%s)
		if [ -z "$unhealthy_since" ]; then
			unhealthy_since="$now"
		elif [ $((now - unhealthy_since)) -ge "$failure_grace" ]; then
			echo "Stale browser profile lock with unavailable CDP; restarting OpenClaw for automatic recovery" >&2
			stop_gateway
			break
		fi
	else
		unhealthy_since=''
	fi
	sleep "$check_interval" &
	wait $! || true
done

wait "$gateway_pid"
