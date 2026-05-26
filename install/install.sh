#!/bin/sh
set -eu

REPO="${MANGO_LSP_REPO:-juliopolycarpo/mango-lsp-proxy}"
INSTALL_DIR="${MANGO_LSP_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${MANGO_LSP_VERSION:-}"
TAG="${MANGO_LSP_TAG:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    *)
      echo "usage: install.sh [--version <version>] [--install-dir <dir>]" >&2
      exit 2
      ;;
  esac
done

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
    return
  fi
  echo "curl or wget is required" >&2
  exit 1
}

latest_tag() {
  tmp_url="$(mktemp)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o /dev/null -w "%{url_effective}" "https://github.com/$REPO/releases/latest" > "$tmp_url"
  else
    wget -qO- "https://github.com/$REPO/releases/latest" > /dev/null
    echo "Set MANGO_LSP_VERSION when curl is unavailable." >&2
    exit 1
  fi
  tag="$(sed 's#.*/tag/##' "$tmp_url")"
  rm -f "$tmp_url"
  printf "%s" "$tag"
}

target_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf "x64" ;;
    aarch64 | arm64) printf "arm64" ;;
    *)
      echo "unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

target_libc() {
  if ldd --version 2>&1 | grep -qi musl; then
    printf "musl"
    return
  fi
  printf "glibc"
}

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *)
    echo "install.sh supports Linux and macOS. Use install.ps1 on Windows." >&2
    exit 1
    ;;
esac

if [ -z "$TAG" ]; then
  if [ -z "$VERSION" ]; then
    TAG="$(latest_tag)"
    VERSION="${TAG#v}"
  else
    TAG="$VERSION"
  fi
fi

arch="$(target_arch)"
target="$os-$arch"
# macOS ships a single libc; only Linux varies between glibc and musl.
if [ "$os" = "linux" ] && [ "$(target_libc)" = "musl" ]; then
  target="$target-musl"
fi

asset="mango-lsp-$VERSION-$target.tar.gz"
url="https://github.com/$REPO/releases/download/$TAG/$asset"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

download "$url" "$tmp_dir/$asset"
tar -xzf "$tmp_dir/$asset" -C "$tmp_dir"
mkdir -p "$INSTALL_DIR"
cp "$tmp_dir/mango-lsp" "$INSTALL_DIR/mango-lsp"
chmod 755 "$INSTALL_DIR/mango-lsp"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    profile="${PROFILE:-$HOME/.profile}"
    touch "$profile"
    if ! grep -F "$INSTALL_DIR" "$profile" >/dev/null 2>&1; then
      printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$profile"
    fi
    echo "Added $INSTALL_DIR to PATH in $profile. Open a new shell to use it."
    ;;
esac

echo "Installed mango-lsp to $INSTALL_DIR/mango-lsp"
