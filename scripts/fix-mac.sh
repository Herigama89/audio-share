#!/bin/bash
# Audio Share - Mac install & fix. Paste into Terminal.
# Installs a fresh copy from the .dmg in Downloads, removes macOS's block,
# re-signs it on this Mac, resets permissions, and opens it.
APP="/Applications/Audio Share.app"
ID="com.audioshare.app"
ARCH=$(uname -m)
[ "$ARCH" = "arm64" ] && WANT="arm64" || WANT="x64"

DMG=$(ls -t ~/Downloads/Audio-Share-*mac-$WANT*.dmg 2>/dev/null | head -1)
[ -z "$DMG" ] && DMG=$(ls -t ~/Downloads/Audio-Share*.dmg ~/Downloads/Audio*Share*.dmg 2>/dev/null | head -1)

osascript -e 'quit app "Audio Share"' 2>/dev/null; sleep 1; pkill -f "Audio Share.app" 2>/dev/null

if [ -n "$DMG" ]; then
  echo "== Installing from: $DMG"
  xattr -c "$DMG" 2>/dev/null
  MNT=$(mktemp -d /tmp/audioshare.XXXX)
  if hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null; then
    SRC=$(find "$MNT" -maxdepth 1 -name "*.app" | head -1)
    echo "== Replacing the copy in Applications (asks for your Mac password)"
    sudo rm -rf "$APP"
    sudo ditto "$SRC" "$APP"
    hdiutil detach "$MNT" -quiet
  else
    echo "!! Could not open the .dmg. It may be damaged - download/send it again."
  fi
else
  echo "== No Audio Share .dmg found in Downloads - fixing the copy already in Applications"
fi

if [ ! -d "$APP" ]; then
  echo "!! Audio Share isn't in Applications. Put the .dmg in Downloads and run this again."
else
  echo "== Mac chip: $ARCH   App built for: $(lipo -archs "$APP/Contents/MacOS/Audio Share" 2>/dev/null)"
  echo "== Removing macOS's download block"
  sudo xattr -cr "$APP"
  sudo chmod -R u+rwX,go+rX "$APP"
  sudo chmod +x "$APP/Contents/MacOS/"* "$APP/Contents/Frameworks/"*.app/Contents/MacOS/* 2>/dev/null
  echo "== Re-signing the app on this Mac"
  sudo codesign --force --deep --sign - "$APP" 2>&1 | tail -1
  codesign --verify --deep "$APP" 2>/dev/null && echo "   Signature OK" || echo "   !! Signature check failed - send me this output"
  echo "== Resetting permissions"
  for s in Camera Microphone ScreenCapture Accessibility; do tccutil reset "$s" "$ID" >/dev/null 2>&1; done
  echo "== Opening Audio Share"
  open "$APP" || echo "!! Still can't open - send me everything shown above"
  echo ""
  echo "Allow camera + mic when asked."
  echo "Screen sharing: System Settings > Privacy & Security > Screen & System Audio Recording > turn ON Audio Share, then reopen it."
  echo "Being controlled: Privacy & Security > Accessibility > turn ON Audio Share."
fi
