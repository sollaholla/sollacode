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
- **Agent calls:** an agent ringing you. These follow the **Approval and input requests** setting.

Text is private by default: the notification says that an agent sent an alert or needs your approval/input. Enable **Show notification details** to include message text on the lock screen. Tapping a notification opens the relevant thread or agent in an existing Solla window when possible. That window switches pages without reloading, so a call in progress there keeps going. A tab showing a page the host serves outside the app, such as an image opened from a chat or a sign-in page, is skipped: the tap uses another Solla window or opens a new one. A tap never approves a request automatically.

Settings apply to this browser installation and the primary host serving the web app. For another host, open its HTTPS address and enable notifications there. This is not a subscription to every remote environment shown in the sidebar.

## Agent calls

When an [agent calls you](./custom-agents.md#when-an-agent-calls-you), this device gets a
notification. With **Show notification details** on, it is titled "<agent> is calling" with the
reason as its text. With details off (the default), it says "Incoming call" and "One of your agents
is calling." Tapping it opens the call page. Tap **Answer** there to start the call: a browser needs
that tap before it can use the microphone.

A call notification is sent with a short lifetime, so a phone that is offline for longer than the
ring doesn't get it late. Where the browser supports it, the notification stays on screen until you
act on it, and Android browsers that allow it vibrate in a ring pattern. iPhone and iPad play the
normal notification sound once; a web app can't play a ringtone or open itself.

When the call is answered, declined, or no longer needed, the ringing notification doesn't stay:

- One still queued at the host is withdrawn.
- One that already arrived is replaced, without a sound, by a short notice such as "Answered on
  <device>" or "Call ended". The notice clears itself a few seconds later when the browser lets it;
  a browser that stops the push handler first leaves it until you dismiss it.
- A Solla window that is open on the device also closes the call's notification when it sees the
  call stop ringing. A missed-call notification stays.
- If the host restarts while a call rings, no replacement comes. The next notification that
  arrives on the device clears that ring once its time is up.

A call nobody answers is replaced with a missed-call notification ("Missed call from <agent>" with
details on, "Missed call" without), which opens the agent. Tapping an older call notification opens
the call page, which says how the call went: answered on another device (with **End call**),
declined, missed, ended, or failed. For a few minutes after a call ends, the page on web and
desktop also offers **Call back**.

The phone app has no push notifications. It only rings while it is open; see
[Where a call rings](./custom-agents.md#where-a-call-rings).

## Turn off or troubleshoot

Use **Turn off** in the same settings section to remove the device subscription and its queued notifications. You can re-enable it later. Changing category or privacy preferences also withdraws messages still queued at the host; notifications already accepted by the push service cannot be recalled.

If notification permission is blocked, allow it in the device/browser settings and reopen Solla Code. If the browser subscription, saved host key, or pairing session expires, enable notifications again. Revoked or expired pairing sessions stop receiving push. Clearing site data or removing the Home Screen app may remove its browser subscription.

The host sends encrypted notifications through the browser vendor's push service (Apple, Google, Mozilla, or Microsoft). It needs outbound internet access, but no public inbound port or additional Tailscale service. The phone does not need a live Solla WebSocket to receive a push. Opening a notification for a private Tailscale address still requires access to that tailnet.

Delivery is best effort. Solla retries temporary send failures, discards expired device endpoints, and deduplicates repeated events per device. It does not replay alerts from before the device opted in; pending recovery is limited to the last 24 hours. A host that is off or asleep cannot send new notifications until it resumes.

References: [Apple Web Push support](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), [Tailscale HTTPS](https://tailscale.com/kb/1153/enabling-https).
