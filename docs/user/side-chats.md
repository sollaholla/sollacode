# Side chats

A side chat is a temporary conversation fork that opens as its own right-panel surface. It keeps
the provider conversation available at the moment the side chat is created, so later work in the
main thread is not replayed into the side chat. The main thread can keep running while the side chat
is created and used.

Side-chat agents receive private concurrency guidance. They know they are working beside a main
conversation and avoid workspace changes that could interfere with it unless the user explicitly
asks for those changes in the side chat.

Closing a side chat always asks for confirmation. Confirming closes its panel tab and archives the
backing conversation instead of deleting it, so it can be restored later from Archived. Cancelling
leaves both the tab and conversation untouched. A side chat that is still running must be stopped
before it can be archived. Promote it to keep it as a normal thread; promoted threads appear in the
project sidebar and retain their independent provider conversation.

The orchestrator can tell a side chat apart from an ordinary thread and will say so when it
describes one, naming the conversation it hangs off. It could not before: side chats carry the flag
in the data, but nothing surfaced it, so a side chat was described as a normal thread and you went
looking for it in the sidebar - the one place side chats never appear.

Right-clicking a side chat's tab offers **Copy chat ID**. That id is how the collaboration tools
address one side chat from another conversation, and the tab is the only place it is reachable:
side chats are deliberately kept out of the project sidebar, so the sidebar's own "Copy Thread ID"
never applies to them, and the tab's title is user-editable and says nothing about which chat it is.

Voice recording and model controls are owned by the composer where they were invoked. A side-chat
recording can only update and focus the side-chat draft, and side-chat model or trait selections do
not replace the main chat's selection or the default used for new threads.

On narrow screens, the right panel occupies the full viewport. When provider background tasks are
present, they stack below the active side-chat surface and scroll independently instead of
squeezing the two surfaces into side-by-side columns. Grok background commands use the same
panel as Claude sub-agents; agent mode waits for them to finish, and you can stop a running Grok
command from the row.
