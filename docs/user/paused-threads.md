# Paused threads

Solla Code runs the model you picked. It never moves a thread to another model or provider on its own, and it never slows your work down to save usage.

When a provider stops a turn, the thread pauses instead of showing an error. That covers running out of usage or credits, a refused request such as a 403, a model that is gone, and an outage. A short outage is retried quietly for about two minutes first. Requests that cannot work, such as a usage limit, pause straight away.

The pause card sits above the composer and says what stopped, in one line. Nothing is lost. Choose one:

- **Resume** carries on with the same model. If your last message never reached the provider, Resume sends it.
- **Switch model** resumes on another model. On web and desktop each one shows how much usage is known to be left, with the most room first, and a model known to be spent is not offered.
- **Switch account** resumes on another signed-in account of the same provider, or signs this provider in to a different account. On the phone app this opens Settings.

**Details** shows the provider's own words and offers **Reset session**. Sending a new message also clears the pause.

Paused threads show **Paused** in the sidebar and thread list.

A provider that needs you to sign in again keeps its own sign-in prompt instead of this card.
