#!/usr/bin/env bash
# Clean-install test for the .deb package.
#
# Builds the snapshot package with goreleaser, installs it in a throwaway
# Debian container (podman if available, else docker), then checks that
# `faztudo init`, `faztudo doctor` and `faztudo serve` work, that the API
# answers 401 without the local token and 200 with it, and that the systemd
# user unit is installed. No credentials go into the container; the only
# network use is pulling the base image and apt installing the package
# dependencies.
#
#   scripts/install-test.sh             build the snapshot, then test it
#   DEB=path/to/faztudo.deb scripts/install-test.sh   test an existing package
#   DESKTOP_DEB=path/to/faztudo-desktop.deb   also install the desktop app and
#                                       check its files and libraries
#   IMAGE=debian:12-slim                base image (default)
#   GORELEASER=goreleaser               goreleaser binary
set -euo pipefail

IMAGE="${IMAGE:-debian:12-slim}"
GORELEASER="${GORELEASER:-goreleaser}"
cd "$(dirname "$0")/.."

if command -v podman >/dev/null 2>&1; then
	engine=podman
elif command -v docker >/dev/null 2>&1; then
	engine=docker
else
	echo "install-test: SKIPPED, neither podman nor docker is installed"
	exit 0
fi

case "$(uname -m)" in
x86_64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*)
	echo "install-test: SKIPPED, unsupported machine $(uname -m)"
	exit 0
	;;
esac

if [ -z "${DEB:-}" ]; then
	"$GORELEASER" release --snapshot --clean --skip=publish
	DEB=$(find dist -name "faztudo_*_linux_${arch}.deb" | head -n 1)
fi
[ -f "$DEB" ] || {
	echo "install-test: no .deb for $arch found in dist/" >&2
	exit 1
}

work=$(mktemp -d)
name="faztudo-install-test-$$"
cleanup() {
	"$engine" rm -f "$name" >/dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT

cp "$DEB" "$work/faztudo.deb"
if [ -n "${DESKTOP_DEB:-}" ]; then
	cp "$DESKTOP_DEB" "$work/faztudo-desktop.deb"
fi
cat >"$work/inside.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl /work/faztudo.deb >/dev/null

test -x /usr/bin/faztudo
test -f /usr/lib/systemd/user/faztudo.service
grep -q '^ExecStart=/usr/bin/faztudo serve' /usr/lib/systemd/user/faztudo.service

if [ -f /work/faztudo-desktop.deb ]; then
	apt-get install -y -qq --no-install-recommends /work/faztudo-desktop.deb >/dev/null
	test -x /usr/bin/faztudo-desktop
	test -f /usr/share/applications/faztudo-desktop.desktop
	grep -q '^Name=faztudo$' /usr/share/applications/faztudo-desktop.desktop
	test -f /usr/share/icons/hicolor/128x128/apps/faztudo-desktop.png
	if ldd /usr/bin/faztudo-desktop | grep 'not found'; then
		echo "faztudo-desktop is missing libraries"
		exit 1
	fi
	echo "desktop: installed with all libraries"
fi

useradd -m -s /bin/bash tester
su tester -c '
set -euo pipefail
cd "$HOME"
faztudo version
faztudo init --template solo
faztudo doctor || true   # no agent CLIs in the container; it must still run
faztudo serve --no-open >serve.log 2>&1 &
pid=$!
for i in $(seq 1 50); do
	curl -fsS http://127.0.0.1:7457/api/v1/health >/dev/null 2>&1 && break
	sleep 0.2
done
curl -fsS http://127.0.0.1:7457/api/v1/health
echo
code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7457/api/v1/channels)
[ "$code" = 401 ] || { echo "expected 401 without token, got $code"; cat serve.log; exit 1; }
token=$(cat "$HOME/.local/share/faztudo/local-token")
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $token" http://127.0.0.1:7457/api/v1/channels)
[ "$code" = 200 ] || { echo "expected 200 with token, got $code"; cat serve.log; exit 1; }
faztudo connect --json | grep -q "\"code\""
stop=$(faztudo stop --json)
echo "$stop"
echo "$stop" | grep -q "\"daemon\":\"left_running\"" || { echo "unexpected stop result"; exit 1; }
kill "$pid"
echo "install-test: all checks passed"
'
EOF
chmod +x "$work/inside.sh"

"$engine" run --rm --name "$name" -v "$work:/work:ro" "$IMAGE" /work/inside.sh
