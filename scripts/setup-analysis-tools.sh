#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l \
  apt-get install -y --no-upgrade --no-install-recommends percona-toolkit curl ca-certificates

case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64) arch=arm64 ;;
  *) echo 'Unsupported architecture' >&2; exit 1 ;;
esac

version=1.0.22
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
cd "$work_dir"
archive="alp_linux_${arch}.tar.gz"
base_url="https://github.com/tkuchiki/alp/releases/download/v${version}"
curl -fLSs --retry 3 -O "$base_url/$archive"
curl -fLSs --retry 3 -O "$base_url/alp_${version}_checksums.txt"
awk -v archive="$archive" '$2 == archive { print }' "alp_${version}_checksums.txt" > checksum.txt
test -s checksum.txt
sha256sum -c checksum.txt
tar -xzf "$archive" alp
sudo install -m 0755 alp /usr/local/bin/alp
alp --version
pt-query-digest --version
