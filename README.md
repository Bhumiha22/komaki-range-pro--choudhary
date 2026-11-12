# Komaki X1 Range Pro (Android app)

The `index.html` web app wrapped as a single Android app (WebView, all files bundled, works offline).

## Why a native bridge
Web Bluetooth does not exist inside Android WebView. `assets/ble-polyfill.js` provides a
`navigator.bluetooth` shim, and `BleBridge.kt` runs the real Bluetooth LE calls (scan, connect,
notify, read, write by UUID). The web page itself is unchanged apart from one added
`<script src="ble-polyfill.js">` line in `<head>`. The shim also covers:
- `navigator.wakeLock` (keeps the screen on while connected)
- exporting `komaki-packets.json` (saved to the phone's Downloads folder)

## Get the APK (no PC needed)
1. Push to `main` (or run **Actions -> Build APK -> Run workflow**).
2. When it finishes, open **Releases -> latest** on your phone and download `KomakiX1RangePro.apk`.
3. Install it (allow "install unknown apps" for your browser when asked).
4. Open the app, tap **Connect to scooter**, allow Nearby devices permission, pick the scooter in the list.

## Updating the web app
Replace `app/src/main/assets/index.html` and keep this line right after `<head>`:
`<script src="ble-polyfill.js"></script>`

## Notes
- Debug-signed APK, for personal sideloading. To update an installed copy, install the new APK over it.
- Reconnect-after-restart works: the last picked scooter is remembered and reused without the chooser.
- The app only collects data while it is open (as the web version did); the screen stays on while connected.
