# Loobee

## Run
Extract the ZIP and open `index.html` in a modern browser.

## Current demo features
- Sign-in screen required before viewing the homepage.
- Search/category with a clear `404 — Can't find videos` empty state.
- Responsive video cards, video detail modal, like/subscribe demo controls.
- Upload preview form (adds a card locally only).

## Important authentication note
The sign-in screen is a front-end demo, not secure authentication. It accepts any valid-looking email and a password of 6 or more characters; it remembers the signed-in email for the current browser tab session. Anyone with access to the source can bypass this. A real public site needs a backend/auth provider (e.g. Supabase Auth), server-side authorization, and secure storage.
