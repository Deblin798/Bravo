# Bravo – macOS & Windows Desktop App (Electron)

Text‑first desktop UI for Bravo with a Siri‑style floating orb and a built‑in backend launcher.

## Features
- Floating orb (always‑on‑top). Click it to open the main Bravo window.
- Text‑first chat UI with solid dark bubbles for agent and user.
- Uniform feature bubbles (pills) shown before first interaction.
- “Get Plus” CTA with a subtle left‑to‑right sheen highlight.
- Input field now has a circular + button on the left with a soft glow.
- Mic button mirrors pill styling; click it to trigger voice mode (if backend supports).
- Builds for macOS (DMG/ZIP) and Windows (NSIS/ZIP).

## Prerequisites
- macOS 12+ or Windows 10+
- Node.js 18+ (`https://nodejs.org`)
 - Python 3.10+ in PATH (for launching the ElevenLabs Voice Agent backend)

## Setup (dev)
```bash
npm install
npm run start
```

## Backend / Agent
On launch, the renderer asks the main process to start the ElevenLabs Voice Agent located at `../Coral-ElevenlabsVoice-Agent`.

- Ensure Python 3 is installed and discoverable (the app probes common paths on macOS and Windows).
- Configure API keys in `Coral-ElevenlabsVoice-Agent/.env` as required by that project.
- The app streams agent stdout/stderr into the chat as status lines and suppresses noisy logs.

No agent ID is configured in `index.html` anymore; the backend handles session/voice.

## UI overview & controls
- Top overlay: Menu, “Get Plus” sheen button, and Chat icon.
- Feature bubbles: three rows of uniform pills centered before first message.
- Input row: left + button (decorative by default), text field, mic button.
- Enter sends a message. Click Mic to start voice mode (if supported by backend).

## Build installers
```bash
# macOS (from macOS)
npm run dist

# Windows (from Windows)
npm run dist
```
Output files are in `dist/`:
- macOS: `Bravo-<version>.dmg`, `Bravo-<version>-mac.zip`
- Windows: `Bravo Setup <version>.exe`, `Bravo-<version>-win.zip`

## Sharing with others
- Share the DMG (macOS) or EXE/ZIP (Windows) from `dist/`.
- First launch:
  - macOS: right‑click `Bravo` → Open → Open, or allow in System Settings → Privacy & Security.
  - Windows: SmartScreen may warn for unsigned apps; click More info → Run anyway, or sign the build.

## Code signing (recommended)
Signing reduces OS warnings.

### macOS signing + notarization
Set env vars then build:
```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOURTEAMID"
npm run dist
```

### Windows signing
```bash
setx CSC_LINK "file:///C:/path/to/cert.pfx"
setx CSC_KEY_PASSWORD "yourPfxPassword"
# restart terminal, then
npm run dist
```

## Behavior notes
- Clicking the orb opens the main window; quitting the app stops mic capture.
- The renderer requests the backend to start on load; if Python is missing, you’ll see an error toast.

## Styling knobs (quick refs)
- Feature pill width: `.feature-pill { width: 180px; }`
- Solid bubble colors: `.message-inner`, `.feature-pill`, `.message-input`, `.mic-btn` use `#2a2a2a`
- Get Plus sheen speed: `@keyframes plusSheen` + `.get-plus::after { animation: ... }`
- Input + button size/offset: `.pill-wrap .add-btn { left: 8px; width/height: 36px; }`

## Troubleshooting
- macOS mic access: System Settings → Privacy & Security → Microphone → enable Bravo.
- Windows mic access: Settings → Privacy & security → Microphone → allow apps to access your mic.
- If the widget doesn’t load, ensure `https://unpkg.com` is reachable.
 - If backend doesn’t start, verify Python 3 is installed and `Coral-ElevenlabsVoice-Agent/.env` is configured.

## License
MIT


