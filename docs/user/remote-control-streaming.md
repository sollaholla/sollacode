# Remote-control streaming

Remote control automatically uses a low-latency video path when both the host and
viewer support it. The image follows the viewer's window size and zoom; a phone
need not download the host's full desktop resolution. Stream quality adapts when
the link becomes congested, keeping the picture current instead of playing a long
backlog. Stop sharing or close the viewer to stop capture.

Older clients and browsers without the required video APIs continue to use the
existing video/image path. If the newer path cannot connect or decode, the viewer
falls back automatically. Remote control remains available through the web and
desktop clients, including phone browsers. It is not currently a feature of the
native mobile app.

Remote mouse buttons preserve the controller’s primary and secondary actions.
If the Windows host has swapped its primary mouse button, Solla accounts for that
setting so a normal click still selects and a secondary click opens the context
menu. The host’s mouse preference stays unchanged. A drag releases the same
physical button it pressed, even if the preference changes while it is held.
