# Status snapshot

Written 2026-11-03. This is a snapshot: check `gh pr list` and `git log origin/main` before acting on it, and update this file in a small PR after a big session.

## Speed (this branch)

Signed-out visits load the landing page only (i18n.js, the active language pack, accounts.js and accounts.css). Other language packs load when the language changes. Music, TV, Discord, gifts, Nostr and nearby chat load when that screen is opened, and again in idle time. Home that has not changed is put back as live DOM instead of rebuilt. The service worker registers from index.html, caches a small core first, and caches the rest when the browser is idle. app.js stays one file: it is a single closure, and splitting it would risk every route.

Baseline on a phone-sized window, slow CPU, cold load: LCP about 7–10s, about 1.86 MB, TTI about 10s. Warm load about 0.5s. Back to Home about 310–340ms. CLS about 0.17 from the alert toast. After numbers are in the pull request.

## Live on main (recent)

- Newsletters as posts: follow Substack, Beehiiv, Buttondown, Ghost, Medium, Mailchimp archives or any RSS site (#359).
- Usage panel in Settings never sticks on "Loading" (#456).
- Profile Games tab: ReGone link/unlink, stats and rooms live in an X-style Games tab instead of the profile header (#457).
- Delete all data on this device, local data encrypted at rest, inactivity expiry (#395).
- Tab shortcut menus (#394), full-screen X-style video viewer (#405), X mobile timeline layout (#358), low-usage playbook (#373).
- Feeds add box keeps text and focus across redraws (#455).
- NZlay Forums as an X-style community with on-device login and ReGone links (#452; switches `nzlay_forum`, `nzlay_forum_post`, `nzlay_forum_regone`). Live posting has not been verified with a real NZlay account.
- Following and Followers lists of external accounts, browsable in full (#451).
- Connected keys: your own spare Discord key kept only on the device (#447), a page per service with the stepped "Get your key" guide (#448), and sending messages you type yourself (#449). Old server-side-key Discord servers stay read-only.
- ReGone social features (#431), TV sign-in with the phone, TV app with controller play (see `docs/TV*.md`).

## Open pull requests

| PR | State | What it needs |
| --- | --- | --- |
| #459 Desktop right column: unified Who to follow + People you may know; collapsed Friends shows who is online | In progress, DIRTY | Merge main, fix the stamp, green CI, then merge. |
| #458 For you: community posts from Reddit, forums and NZlay; titles on their own line; joined row fix | In progress, DIRTY | Finish the Communities rows (below), merge main, green CI. |
| #413 Gift NFTs (off by default) | DIRTY, old base | Owner decision (wallet/minting). Ships switched off. |
| #409 Link cards with inline official video players | DIRTY, old base | Merge main, fix the failing check. |
| #406 Dependabot npm group (wrangler, miniflare; dev tools) | CLEAN, green | Owner approval (dependency change). Low risk. |
| #376 Dependabot actions group (major bumps across about 30 workflows) | CLEAN, green | Owner approval (workflow change). Medium risk: artifact upload/download formats changed. |
| #367 Nearby chat (Bitchat) web fallback | DIRTY | Merge main, fix the failing check. |
| #365 Gifts and store with a payment adapter | DIRTY | Payment keys and owner decision; ships switched off; migration `0090_store.sql` must be renumbered above the latest. |
| #357 X video always in our own player | DIRTY | Merge main, fix the failing check. |
| #355 Messages servers phase 3 (voice, video, screen share) | DIRTY, 1 failing check | Renumber migrations 0082–0084 above the latest, merge main. |
| #352 Messages servers phase 2 (threads, forums, events, polls) | DIRTY, 2 failing checks | Renumber migration 0083, merge main. Ship before #355. |
| #274 Emoji status badges and store | DIRTY, very old | Rebuild on current main (presence privacy changed); migration 0040 collides. |
| #269 Collapse the home composer | DIRTY, very old | Overlaps the shipped composer collapse; rebuild or close (owner). |
| #145 Lives and new posts on a Worker schedule | DIRTY, very old | Recommend closing: main already runs a per-minute Worker cron; it also edits workflows and `wrangler.toml`. Owner decides. |

## Needs the owner

- Approve or decline Dependabot #406 (npm) and #376 (GitHub Actions).
- Close or keep #145 (obsolete; edits workflows).
- Payments: #365 and #413 stay switched off until payment keys are added and you decide.
- Migration renumbering for #365, #352, #355, #274 before they can merge.
- Keys still needed (set as Worker or GitHub secrets from the exact steps in each doc):
  - SMSPool (`SMSPOOL_API_KEY`, Inbox › SMS codes, `docs/sms-codes.md`).
  - IMAP mail relay (Inbox mail, `docs/INBOX-MAIL.md`).
  - SimpleLogin (email aliases).
  - YouTube API key (steps still to be written for you).
- Optional: Telegram alerts (`OWNER_ALERT_CHAT_ID`), TURN for Go live, Turnstile, the short TV address (`docs/HANDOFF.md`).
- A real-TV test of controller play in ReGone (`docs/TV-CONTROLLER.md`) and real-iPhone checks.
- Optional third origin on Deno Deploy (free) next to the Worker and Render; not set up.

## In progress

1. **Sign-up fix (top priority).** The Temporary account screen fails with "Something went wrong" and its title is not translated. Branch `fix/signup-temp-account`, no PR yet. Every sign-up path must work end to end on the live site (temporary account, username and number, passkey), and every title must be in en, es, ru and hi.
2. **Usage loading.** Fixed in #456; confirm on the live owner account that the panel loads.
3. **Profile Games tab.** Shipped in #457; owner wants before/after screenshots.
4. **For you and Communities (#458).**
   - Community posts from Reddit, forums and NZlay show in For you.
   - Forum posts show the title on its own bold line above the body, X style.
   - The Communities row on Home (Inicio) shows only communities the person joined, and all of them (Reddit sources they follow, NZlay once joined). It can be organized into folders: a folder is one tile the same size as a community tile, showing a small grid of its communities' pictures; tap opens it; create, rename, reorder, move communities between folders; folders are private to each person.
   - A new row in Explore (Explorar) shows all communities. The owner can pin featured communities, which appear first; only the owner can pin, reorder or unpin.
5. **Desktop right panel (#459).** "People you may know" merges permanently with "Who to follow" into one detailed panel (picture, name, short bio, why suggested, Follow, dismiss). The Friends panel shows green online dots and a count even when collapsed. Phones unchanged.
6. **Old PR queue.** Bring every open PR above to green and merge one at a time, except the owner items.

## Where to look next

- Rules and how to ship: `AGENTS.md`.
- History and merge-queue details: `docs/HANDOFF.md`.
- Opening the repo in Antigravity and starter prompts: `docs/ANTIGRAVITY.md`.
