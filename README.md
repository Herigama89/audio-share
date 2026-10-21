# Audio Share

Video calls with friends, plus:

- **Chat and file sending.** Files go straight from computer to computer and are never uploaded anywhere.
- **DAW audio sharing** in full-quality stereo (48 kHz, up to 510 kbps, all voice processing off).
- **Screen sharing with remote control.** A friend can ask to control your screen, and you click Allow. Take control back any time with the Stop button or **Ctrl/Cmd + Shift + X**.

It works on Mac and Windows, is free, and has no accounts.

## Getting the app

Download the newest installer from the **Releases** page of this repository:

- **Windows:** `Audio-Share-Setup-x.x.x.exe`
- **Mac with Apple chip (M1 and newer):** `Audio-Share-x.x.x-mac-arm64.dmg`
- **Older Intel Mac:** `Audio-Share-x.x.x-mac-x64.dmg`

### First launch on Windows
Windows may show a blue **"Windows protected your PC"** screen. Click **More info**, then **Run anyway**. This happens because the app isn't paid-signed. It only happens once.

### First launch on Mac
1. Open the `.dmg` and drag **Audio Share** into **Applications**.
2. Open it. macOS will say it can't verify the app. Click **Done**.
3. Go to **System Settings → Privacy & Security**. Scroll down and click **Open Anyway** next to Audio Share, then confirm.
4. When asked, allow the camera and microphone.

## Using it

1. Type your name, click **Start a new room**, and send your friends the 6-character code.
2. Friends type the code and click **Join**.
3. Use the buttons at the bottom: Mute, Video, **Share DAW audio**, **Share screen**, Settings, Leave.
4. Drag files onto the chat, or click the paperclip, to send them.

## Sharing your DAW

Open **Share DAW audio** in the app. The help section there explains the setup for your computer:

- **Mac:** install the free [BlackHole 2ch](https://existential.audio/blackhole/) and set your DAW output to it. In Audio Share, pick *BlackHole 2ch* and tick **Let me hear it too**.
- **Windows:** pick **Whole computer sound** (easiest), or install the free [VB-CABLE](https://vb-audio.com/Cable/), set your DAW output to *CABLE Input*, and pick *CABLE Output* in Audio Share.

Wear headphones so your mic doesn't pick up the music.

## Remote control setup (only for the person being controlled)

- **Mac:** the first time, macOS asks you to allow Audio Share under **System Settings → Privacy & Security → Accessibility**, and also **Screen & System Audio Recording** for sharing. Turn both on, then quit and reopen the app.
- **Windows:** nothing to set up.

Only whole screens can be controlled, not single windows.

## Good to know

- Calls are direct between computers. This works best with up to about 5–6 people.
- The free PeerJS service is only used to find each other. If a friend can't connect at all because of a strict network, add a TURN relay under **Settings → Advanced**.
- If the person who started the room leaves, everyone else stays connected, but new people can't join with that code.

## Building it yourself

The installers are built automatically by GitHub Actions on every push. Pushing a tag like `v1.0.1` also attaches them to a Release.

To build locally, install Node.js 20+ and run:

```
npm install
npm start          # run the app
npm run dist:mac   # build the Mac installer (on a Mac)
npm run dist:win   # build the Windows installer (on Windows)
```
