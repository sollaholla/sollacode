# Push notifications

Solla Code can send notifications to a supported browser or Home Screen web app even when its page is closed. You do not need an App Store app. The host computer must be running Solla Code and have internet access.

## Enable on a phone

1. Open your host's **HTTPS** address, such as its Tailscale `https://…ts.net` link. Plain HTTP LAN addresses do not support Web Push.
2. On **iPhone or iPad with iOS/iPadOS 16.4 or later**, use Safari's **Share → Add to Home Screen**. Open Solla Code from that icon and pair/sign in if prompted. Apple only supports Web Push in Home Screen web apps, not an ordinary Safari tab.
3. Open **Settings → Agents → Push notifications on this device**.
4. Tap **Enable notifications** and allow the device's permission prompt.
5. Tap **Send test notification**. “Accepted by the push service” means the service accepted it; check the device to confirm it appeared. Focus modes, notification settings, and connectivity can delay or hide delivery.

Android and supported desktop browsers can enable notifications from the HTTPS site without a native app. Each browser or Home Screen installation opts in separately. The installed desktop app continues using its existing desktop agent alerts.

## What arrives

- **Agent alerts:** agent messages and task notifications that the agent's own notification preferences allow.
- **Approval and input requests:** provider approvals, questions, tool action approvals, and agent blockers.

Text is private by default: the notification says that an agent sent an alert or needs your approval/input. Enable **Show notification details** to include message text on the lock screen. Tapping a notification opens the relevant thread or agent in an existing Solla window when possible. It never approves a request automatically.

Settings apply to this browser installation and the primary host serving the web app. For another host, open its HTTPS address and enable notifications there. This is not a subscription to every remote environment shown in the sidebar.

## Turn off or troubleshoot

Use **Turn off** in the same settings section to remove the device subscription and its queued notifications. You can re-enable it later. Changing category or privacy preferences also withdraws messages still queued at the host; notifications already accepted by the push service cannot be recalled.

If notification permission is blocked, allow it in the device/browser settings and reopen Solla Code. If the browser subscription, saved host key, or pairing session expires, enable notifications again. Revoked or expired pairing sessions stop receiving push. Clearing site data or removing the Home Screen app may remove its browser subscription.

The host sends encrypted notifications through the browser vendor's push service (Apple, Google, Mozilla, or Microsoft). It needs outbound internet access, but no public inbound port or additional Tailscale service. The phone does not need a live Solla WebSocket to receive a push. Opening a notification for a private Tailscale address still requires access to that tailnet.

Delivery is best effort. Solla retries temporary send failures, discards expired device endpoints, and deduplicates repeated events per device. It does not replay alerts from before the device opted in; pending recovery is limited to the last 24 hours. A host that is off or asleep cannot send new notifications until it resumes.

References: [Apple Web Push support](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), [Tailscale HTTPS](https://tailscale.com/kb/1153/enabling-https).
