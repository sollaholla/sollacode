# Provider background tasks

The background-tasks chip at the top right of the composer counts work the provider has started and still owns: running tasks while any run, then failed or silent ones that still need a look. Select it to see every task. Shell commands show their status without agent token or tool-use counters. Agent tasks retain provider-reported usage.

A subagent's tokens count only on its own row. They never move the chat's context meter, which measures the main conversation that the provider compacts. Before version 0.1.740, Claude wrote each subagent's running total into the meter, which often pinned it at 100% while the chat had plenty of room. The meter now skips those old readings and shows the chat's last real one.

A thread whose tasks are still running reads as **Working** everywhere, even after the turn that started them has ended. This covers the sidebar, the phone thread list, the status pill, and the thread lists agents read: the orchestrator's `list_threads` and `thread_collaboration`'s related chats. The conversation keeps a working row such as **3 background tasks running…** in place of the finished turn's silence. A task stops counting once its provider session ends or once it has gone 30 minutes without reporting, the same window after which the task list marks a row as having had no updates. Background shell commands report nothing until they finish, so one that runs longer than 30 minutes stops counting before it ends. A thread that leaves a dev server or another long-lived command running in the background reads as working for up to 30 minutes after it starts.

Nothing a provider runs survives a Solla Code restart. When the server starts, every task the previous run left open is marked **Stopped** with "Solla Code restarted before this task finished", so an app update never leaves a thread claiming work it lost.

Claude log monitors are labeled **Monitor · Watching**. A monitor can keep watching after the command that writes its log has finished, and after Claude answers. It finishes when its source ends, its timeout expires, or it is stopped. Use its Stop control to end a watch you no longer need; finishing the parent turn does not pretend that the watch has ended.

Claude completed, failed, and killed status updates settle the row immediately, even if the separate final notification arrives later. Final notifications can still supply the result summary. Completed and stopped tasks leave the list as soon as they finish; the conversation keeps the record. Before 0.1.752 they stayed for ten minutes. Failed tasks stay for an hour so a failure is not missed, and **Clear** or the row's dismiss button removes them sooner.

Idle-session cleanup keeps Claude alive while it owns background commands, monitors, or agent tasks, including when those tasks wake Claude between foreground turns. The inactivity clock also accounts for native provider output.

Recent task lifecycle records are included separately from the normal conversation activity window, so reopening a busy thread or side chat still shows task status. If the provider session ends, interrupted commands are marked stopped and leave the list with it, rather than lingering as running.

Switching providers closes the outgoing provider session, including its background tasks, before starting the replacement. Claude's idle event reader is released during shutdown so it cannot hold the switch open. If a provider fails to acknowledge Stop, the thread still leaves the working state and reports the shutdown failure.
