# Simulators and emulators

Solla Code shows iOS simulators and Android emulators running on the computer running Solla Code,
live, inside the browser panel. Click, drag, scroll, and type to use them, from that computer or
from a connected phone.

## What you need

- **iPhone and iPad:** a Mac with Xcode. Solla Code uses Xcode's simulators and opens their live
  view with [serve-sim](https://github.com/EvanBacon/serve-sim) (downloaded on first use through
  `npx`, so Node.js must be installed).
- **Android:** Android Studio with the Android Emulator and at least one system image, installed
  from Android Studio's SDK Manager. Adding emulators also needs the SDK Command-line Tools.

When a tool is missing, **Settings → Devices** says what to install instead of the device list.

## Open a device

1. Open the browser panel in any chat and start a new tab.
2. Under **Devices**, select a simulator or emulator. Running devices are listed first.
3. The device starts if it is off. A brand-new simulator's first start can take about a minute.

The tab then shows the device screen:

- **iPhone and iPad** use serve-sim's viewer, with Home, screenshot, rotate, and the hardware
  buttons along the frame.
- **Android** shows the screen with Back, Home, and Recent apps, plus rotate, volume, and power.
  Click to tap, drag to swipe, use the scroll wheel to scroll, and type or paste to enter text
  into the focused field. Android's stylus handwriting is turned off on emulators Solla Code
  shows, so mouse clicks behave like a finger.

The device list appears for the computer the app is connected to first (its primary
environment). Live views are served only on that computer's own network interface; phones and
other browsers see them through the browser panel, as with any other tab.

## Manage devices

**Settings → Devices** lists every simulator and emulator, with a **Start** or **Shut down** button
and **Remove**.

Select **Add device** to create one:

- Choose **iPhone & iPad** or **Android** when both are available.
- **Model** lists every phone and tablet the installed tools offer, newest first, such as
  iPhone 17 Pro or Pixel 10 Pro.
- **iOS version** or **Android version** lists the versions installed on the computer that can run
  that model. Install more from Xcode → Settings → Components, or Android Studio's SDK Manager.
- **Name** follows the model until you change it.

**Remove** deletes the simulator or emulator and every app and file on it, after you confirm.

Simulators and emulators keep running when Solla Code restarts. Shut them down from Settings →
Devices, or from Xcode or Android Studio.

## Mobile app

The mobile app does not list devices. Open one from the desktop or web app, then watch and control
it from the phone through that chat's browser panel.
