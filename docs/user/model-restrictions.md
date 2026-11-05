# Model restrictions

Open an existing conversation's model selector and choose **Model restrictions** at the bottom.
For an agent, do this in the agent's main conversation. Its existing and future side chats
inherit the rule. From a side chat, **Apply to** lets you edit either that chat's rule or
its parent's rule. In the native mobile app, use the same action in the model menu.

Choose **Allow all models**, **Block selected models**, or **Allow only selected models**,
then save. An empty allowlist permits no models. Selections identify the exact model and
provider account, so allowing a model on one account does not allow it on another.
Unavailable saved models remain listed so you can remove them.

Child rules can narrow a parent's permission but cannot override a parent block. The picker
disables models excluded by these rules and marks them with a lock. If the current selection becomes blocked, choose
an allowed model before sending. The server also checks direct requests, queued work,
and recovery attempts. Changing a rule does not interrupt an already
running turn; it applies before the next provider request.
