#!/bin/bash
# Audio Share - Mac fix-up. Paste into Terminal on the Mac that has the problem.
APP="/Applications/Audio Share.app"
ID="com.audioshare.app"

if [ ! -d "$APP" ]; then
  echo "Audio Share isn't in Applications. Open the .dmg and drag it into Applications first."
  exit 1
fi

echo "== Mac chip: $(uname -m)   App built for: $(lipo -archs "$APP/Contents/MacOS/Audio Share" 2>/dev/null)"
[ "$(uname -m)" = "arm64" ] && ! lipo -archs "$APP/Contents/MacOS/Audio Share" 2>/dev/null | grep -q arm64 && \
  echo "   NOTE: this is the Intel version. Use the 'mac-arm64' download on this Mac."

echo "== Quitting Audio Share"
osascript -e 'quit app "Audio Share"' 2>/dev/null; sleep 1; pkill -f "Audio Share.app" 2>/dev/null

echo "== Removing the 'downloaded from the internet' block (asks for your Mac password)"
sudo xattr -cr "$APP"

echo "== Re-signing the app on this Mac"
sudo codesign --force --deep --sign - "$APP"

echo "== Resetting Audio Share's permissions so macOS asks again"
for s in Camera Microphone ScreenCapture Accessibility; do tccutil reset "$s" "$ID" >/dev/null 2>&1; done

echo "== Opening Audio Share"
open "$APP"

cat <<'EOF'

Done. Now:
  1. Click Allow when Audio Share asks for the camera and microphone.
  2. The first time you share your screen: System Settings > Privacy & Security >
     Screen & System Audio Recording > turn ON Audio Share, then quit and reopen it.
  3. To let a friend control this Mac: Privacy & Security > Accessibility >
     turn ON Audio Share (use the + button if it's not listed).
EOF
