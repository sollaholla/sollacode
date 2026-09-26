# Touch actions in remote control

On the web or desktop remote-control viewer, including mobile Safari:

- **Tap and release** sends one left mouse-down/mouse-up pair on release. Touching down alone sends nothing.
- **Hold still** for 400 ms opens the action menu without clicking. Move your finger over an option and hold there for 450 ms; its ring fills and the action activates without lifting.
- **Scroll** uses subsequent finger movement as scroll deltas at the original target. Moving through the menu does not move or scroll the remote pointer.
- **Drag** presses left at the original target, then moves it by subsequent finger deltas. Lift to drop.
- **Right-click** sends one right mouse-down/mouse-up pair at the original target as soon as the selection ring completes.
- **Hold** opens Left hold and Right hold. Dwell over either to press that button at the original target. Finger movement does not move the pointer. Lift to release.

Lifting before selecting a menu action dismisses it without clicking. Moving more than 10 pixels before the menu opens cancels the tap, so a swipe is not mistaken for a click or drag. Two-finger pinch remains available and cancels a pending menu or held button. Lost capture, leaving the viewer, and control revocation also release held input.

The phone browser mirror of a desktop browser tab uses the same menu; there, a swipe scrolls without opening the menu, Drag and Hold are sent when you lift, and Right-click opens the page's menu on your screen (see [Controlling the Desktop Browser from Your Phone](./remote-browser-control.md)).

The dedicated FPS controls and desktop mouse/keyboard retain their separate input paths. This menu is part of the web viewer, not a change to the React Native client.

The app’s outer page suppresses pinch zoom while leaving single-finger scrolling and text selection available. Remote-viewer gestures still reach their own handlers. This does not disable operating-system accessibility magnification or browser-level zoom commands.
