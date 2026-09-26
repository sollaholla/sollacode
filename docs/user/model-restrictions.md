# Model restrictions

Open an existing conversation's model selector and choose **Model restrictions…**.
For an agent, do this in the agent's main conversation. Its existing and future side chats
inherit the rule. From a side chat, **Apply to** lets you edit either that chat's rule or
its parent's rule. In the native mobile app, use the same action in the model menu.

Choose **Allow all models**, **Block selected models**, or **Allow only selected models**,
then save. An empty allowlist permits no models. Selections identify the exact model and
provider account, so allowing a model on one account does not allow it on another.
Unavailable saved models remain listed so you can remove them.

Child rules can narrow a parent's permission but cannot override a parent block. The picker
disables models excluded by these rules. If the current selection becomes blocked, choose
an allowed model before sending. The server also checks direct requests, queued work,
recovery attempts, and automatic handoffs. Changing a rule does not interrupt an already
running turn; it applies before the next provider request.

## Automatic fallback

Go to **Settings → Providers → Automatic fallback models** to set the environment-wide
rule. In the native mobile app, use **Settings → Automatic fallback models** and select
the environment. This rule covers automatic fallback, same-provider model downshifts,
and automatic return to an earlier model after its quota resets. It does not restrict
manual selection unless a thread or parent rule also excludes that model.

Every applicable rule must allow a fallback candidate. If none qualify, Solla stops and
shows an actionable notice instead of switching to an excluded model. Allow a suitable
model and resume the work. To remove a restriction, save **Allow all models** at the scope
where it was set; parent and environment rules still apply.

Rules are stored by the server and shared across connected devices. Saving requires a
connection and reports success only after the server acknowledges it. These controls govern
the model Solla requests; they do not control undocumented model routing inside a provider.
