# Provider background tasks

The Background tasks drawer shows work the provider has started and still owns. Shell commands show their status without agent token or tool-use counters. Agent tasks retain provider-reported usage.

Claude log monitors are labeled **Monitor · Watching**. A monitor can keep watching after the command that writes its log has finished, and after Claude answers. It finishes when its source ends, its timeout expires, or it is stopped. Use its Stop control to end a watch you no longer need; finishing the parent turn does not pretend that the watch has ended.

Claude completed, failed, and killed status updates settle the row immediately, even if the separate final notification arrives later. Final notifications can still supply the result summary. Finished rows leave the drawer after the existing retention window and can be dismissed sooner.

Idle-session cleanup keeps Claude alive while it owns background commands, monitors, or agent tasks, including when those tasks wake Claude between foreground turns. The inactivity clock also accounts for native provider output.

Recent task lifecycle records are included separately from the normal conversation activity window, so reopening a busy thread or side chat still shows task status. If the provider session ends, interrupted commands remain visible as **Stopped** for ten minutes from that session end, rather than disappearing based on when the command began.

Switching providers closes the outgoing provider session, including its background tasks, before starting the replacement. Claude's idle event reader is released during shutdown so it cannot hold the switch open. If a provider fails to acknowledge Stop, the thread still leaves the working state and reports the shutdown failure.
