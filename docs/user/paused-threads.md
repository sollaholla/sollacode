# Paused threads

Solla Code runs the model you picked. It never moves a thread to another model or provider on its own, and it never slows your work down to save usage.

When a provider stops a turn, the thread pauses instead of showing an error. That covers running out of usage or credits, a refused request such as a 403, a model that is gone, and an outage. A short outage is retried quietly for about two minutes first. Requests that cannot work, such as a usage limit, pause straight away.

The pause card sits above the composer and says what stopped, in one line. Nothing is lost. Choose one:

- **Resume** carries on with the same model. If your last message never reached the provider, Resume sends it.
- **Switch model** resumes on another model. On web and desktop each one shows how much usage is known to be left, with the most room first, and a model known to be spent is not offered.
- **Switch account** resumes on another signed-in account of the same provider, or signs this provider in to a different account. On the phone app this opens Settings.

## Other chats that stopped too

When other chats stopped on the same model, **Resume** asks which of them to bring back. Everything is ticked, so one click resumes them all, and **Only this chat** leaves the rest paused. On a phone the card offers **Resume all** beside **Resume**.

**Switch account** moves the other chats too, without asking: a new account is the fix for all of them, so they shouldn't each wait for you. Signing the provider in to a different account works the same way.

Chats come back one at a time, each once the last has actually replied. That reply is the proof there's room, so if the provider refuses again the run stops and the rest stay paused instead of all failing together. You can stop a run from the notice it shows, or by stopping any chat in it. **Switch model** only ever moves the chat you're in.

**Details** shows the provider's own words and offers **Reset session**. Sending a new message also clears the pause.

Paused threads show **Paused** in the sidebar and thread list.

A provider that needs you to sign in again keeps its own sign-in prompt instead of this card.
