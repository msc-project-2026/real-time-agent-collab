#!/bin/sh
# Minimal OpenClaw sandbox-browser contract for Brave. The browser's real CDP
# endpoint stays on loopback; the authenticated relay is the only endpoint
# exposed to the sandbox network.
set -eu

export HOME=/tmp/openclaw-home
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"

cdp_port="${OPENCLAW_BROWSER_CDP_PORT:-9222}"
cdp_token="${OPENCLAW_BROWSER_CDP_AUTH_TOKEN:-}"
headless="${OPENCLAW_BROWSER_HEADLESS:-1}"
no_sandbox="${OPENCLAW_BROWSER_NO_SANDBOX:-0}"
source_range="${OPENCLAW_BROWSER_CDP_SOURCE_RANGE:-}"

case "$cdp_port" in
  ''|*[!0-9]*) echo "[brave-sandbox] invalid CDP port" >&2; exit 1 ;;
esac

if [ "$cdp_port" -ge 65535 ]; then
  brave_cdp_port=$((cdp_port - 1))
else
  brave_cdp_port=$((cdp_port + 1))
fi

cleanup() {
  [ -n "${relay_pid:-}" ] && kill "$relay_pid" 2>/dev/null || true
  [ -n "${brave_pid:-}" ] && kill "$brave_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

mkdir -p "$HOME/.brave" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"

set -- \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$brave_cdp_port" \
  --user-data-dir="$HOME/.brave" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-breakpad \
  --disable-crash-reporter \
  --no-zygote \
  --password-store=basic \
  --use-mock-keychain \
  --disable-3d-apis \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-extensions \
  --renderer-process-limit=2

[ "$headless" = 1 ] && set -- "$@" --headless=new
[ "$no_sandbox" = 1 ] && set -- "$@" --no-sandbox --disable-setuid-sandbox

/usr/bin/brave-browser "$@" about:blank &
brave_pid=$!

deadline=$(( $(date +%s) + 30 ))
until curl -fsS --max-time 1 "http://127.0.0.1:$brave_cdp_port/json/version" >/dev/null 2>&1; do
  if ! kill -0 "$brave_pid" 2>/dev/null; then
    echo "[brave-sandbox] Brave exited before CDP became ready" >&2
    exit 1
  fi
  [ "$(date +%s)" -lt "$deadline" ] || {
    echo "[brave-sandbox] Brave CDP did not start" >&2
    exit 1
  }
  sleep 1
done

if [ -z "$cdp_token" ]; then
  echo "[brave-sandbox] OPENCLAW_BROWSER_CDP_AUTH_TOKEN is required" >&2
  exit 1
fi

OPENCLAW_RELAY_PORT="$cdp_port" \
OPENCLAW_UPSTREAM_PORT="$brave_cdp_port" \
OPENCLAW_CDP_TOKEN="$cdp_token" \
OPENCLAW_SOURCE_RANGE="$source_range" \
python3 - <<'PY' &
import base64, hmac, ipaddress, os, select, socket, socketserver

listen_port = int(os.environ["OPENCLAW_RELAY_PORT"])
upstream_port = int(os.environ["OPENCLAW_UPSTREAM_PORT"])
token = os.environ["OPENCLAW_CDP_TOKEN"]
source_range = os.environ.get("OPENCLAW_SOURCE_RANGE", "").strip()
network = ipaddress.ip_network(source_range, strict=False) if source_range else None
expected = "Basic " + base64.b64encode(f"openclaw:{token}".encode()).decode()

def allowed(host):
    return network is None or ipaddress.ip_address(host) in network

def relay(left, right):
    try:
        while True:
            readable, _, _ = select.select((left, right), (), ())
            for source in readable:
                target = right if source is left else left
                data = source.recv(65536)
                if not data:
                    return
                target.sendall(data)
    finally:
        left.close()
        right.close()

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        if not allowed(self.client_address[0]):
            return
        self.request.settimeout(5)
        data = b""
        while b"\r\n\r\n" not in data and len(data) <= 65536:
            chunk = self.request.recv(4096)
            if not chunk:
                return
            data += chunk
        auth = next((line.split(b":", 1)[1].strip().decode("iso-8859-1")
                     for line in data.split(b"\r\n")[1:]
                     if line.lower().startswith(b"authorization:")), "")
        if not hmac.compare_digest(auth, expected):
            self.request.sendall(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
            return
        upstream = socket.create_connection(("127.0.0.1", upstream_port), timeout=5)
        upstream.sendall(data)
        self.request.settimeout(None)
        upstream.settimeout(None)
        relay(self.request, upstream)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(("0.0.0.0", listen_port), Handler) as server:
    server.serve_forever()
PY
relay_pid=$!

wait "$brave_pid"
