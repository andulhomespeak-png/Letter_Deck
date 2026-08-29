# Friendzy Session Contract

Friendzy has one classroom session code and QR for the teacher. Every activity uses that same session; activities must never create their own Friendzy classroom code.

## QR stability is mandatory

- Keep the Friendzy QR and code unchanged while the server process is running.
- Never clear, replace, or regenerate it because of polling, navigation, activity changes, tool synchronization, player changes, temporary request failures, or inactivity/TTL cleanup.
- A new code may be created only when there is no existing session, when the teacher explicitly presses `Reset`, or after the server process has stopped and started again.
- If a room lookup fails during polling, retain and display the existing code. Do not call the create-room endpoint from the polling path.
- Any new game must read the existing Friendzy classroom code and player list from the shared Friendzy session instead of owning a separate QR flow.

