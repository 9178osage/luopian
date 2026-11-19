#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo "Build the macOS package on a Mac." >&2
  exit 1
fi
mode=$1
shift
if [ "$#" -eq 0 ] && [ -d node_modules/electron/dist/Electron.app ]; then
  set -- -c.electronDist=node_modules/electron/dist
fi
case "$mode" in
  local)
    output=release
    set -- "$@" -c.mac.identity=- -c.mac.hardenedRuntime=false \
      -c.mac.timestamp=none -c.mac.notarize=false
    ;;
  release)
    : "${APPLE_KEYCHAIN_PROFILE:?Set APPLE_KEYCHAIN_PROFILE to a notarytool credentials profile}"
    output=release/signed
    set -- "$@" -c.forceCodeSigning=true -c.mac.type=distribution \
      -c.mac.hardenedRuntime=true -c.mac.notarize=true -c.dmg.sign=true
    ;;
  *) echo "Expected local or release." >&2; exit 1 ;;
esac

# Signing in a local temporary directory keeps Desktop/iCloud metadata out of the bundle.
stage=$(mktemp -d /private/tmp/luopian-package.XXXXXXXX)
trap 'rm -rf "$stage"' EXIT
npm run build:desktop
electron-builder --mac dmg dir "$@" "-c.directories.output=$stage" --publish never

for app in "$stage"/mac*/落片.app; do
  codesign --verify --deep --strict "$app"
  if [ "$mode" = release ]; then
    xcrun stapler validate "$app"
    spctl --assess --type execute "$app"
  fi
done
for dmg in "$stage"/*.dmg; do
  if [ "$mode" = release ]; then
    set --
    if [ -n "${APPLE_KEYCHAIN:-}" ]; then set -- --keychain "$APPLE_KEYCHAIN"; fi
    xcrun notarytool submit "$dmg" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" "$@" --wait
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg"
    spctl --assess --type open --context context:primary-signature "$dmg"
  fi
  hdiutil verify "$dmg"
done

mkdir -p "$output"
# Export the disk image instead of copying an unpacked bundle into Desktop/iCloud.
for dmg in "$stage"/*.dmg; do
  mv -f "$dmg" "$output/"
done
