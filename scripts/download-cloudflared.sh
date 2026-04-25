#!/usr/bin/env bash
# Download cloudflared binaries for all four supported platforms into
# resources/cloudflared/<platform>/. Run before packaging a release.
#
# Platforms:
#   darwin-arm64    macOS Apple Silicon
#   darwin-amd64    macOS Intel
#   linux-amd64     Linux x86_64
#   linux-arm64     Linux aarch64
#   windows-amd64   Windows x86_64 (.exe)
#   windows-arm64   Windows aarch64 (.exe) — currently falls back to amd64
#
# Upstream releases: https://github.com/cloudflare/cloudflared/releases
# We pin a known-good version so builds are reproducible.

set -euo pipefail

VERSION="${CLOUDFLARED_VERSION:-2025.2.1}"
BASE_URL="https://github.com/cloudflare/cloudflared/releases/download/${VERSION}"

root="$(cd "$(dirname "$0")/.." && pwd)"
dst_root="${root}/resources/cloudflared"
mkdir -p "${dst_root}"

download() {
  local platform="$1"
  local upstream="$2"
  local out_name="$3"
  local dst_dir="${dst_root}/${platform}"
  local dst_file="${dst_dir}/${out_name}"

  if [[ -f "${dst_file}" ]]; then
    echo "[skip] ${platform} already present at ${dst_file}"
    return
  fi

  mkdir -p "${dst_dir}"
  echo "[get]  ${platform} <- ${upstream}"
  # --retry-all-errors so transient 5xx (e.g. GitHub release-asset CDN
  # 502s, which broke the v1.4.3 build twice) trigger a retry instead
  # of failing the whole release. Requires curl 7.71+ — fine on
  # GitHub-hosted runners.
  curl -fL --retry 6 --retry-delay 4 --retry-all-errors --connect-timeout 30 \
    -o "${dst_file}" "${BASE_URL}/${upstream}"
  chmod +x "${dst_file}" || true
}

download "darwin-arm64"  "cloudflared-darwin-arm64.tgz" "cloudflared.tgz"
if [[ -f "${dst_root}/darwin-arm64/cloudflared.tgz" ]]; then
  tar -xzf "${dst_root}/darwin-arm64/cloudflared.tgz" -C "${dst_root}/darwin-arm64"
  rm -f "${dst_root}/darwin-arm64/cloudflared.tgz"
  chmod +x "${dst_root}/darwin-arm64/cloudflared"
fi

download "darwin-amd64"  "cloudflared-darwin-amd64.tgz" "cloudflared.tgz"
if [[ -f "${dst_root}/darwin-amd64/cloudflared.tgz" ]]; then
  tar -xzf "${dst_root}/darwin-amd64/cloudflared.tgz" -C "${dst_root}/darwin-amd64"
  rm -f "${dst_root}/darwin-amd64/cloudflared.tgz"
  chmod +x "${dst_root}/darwin-amd64/cloudflared"
fi

download "linux-amd64"   "cloudflared-linux-amd64"      "cloudflared"
download "linux-arm64"   "cloudflared-linux-arm64"      "cloudflared"
download "windows-amd64" "cloudflared-windows-amd64.exe" "cloudflared.exe"
# Cloudflare does not publish windows-arm64 builds yet; mirror amd64.
if [[ ! -f "${dst_root}/windows-arm64/cloudflared.exe" ]]; then
  mkdir -p "${dst_root}/windows-arm64"
  cp "${dst_root}/windows-amd64/cloudflared.exe" "${dst_root}/windows-arm64/cloudflared.exe"
fi

echo "[done] cloudflared v${VERSION} installed under resources/cloudflared/"
