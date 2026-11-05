# Status snapshot

Written 2026-11-04 (UTC). Main is `241ec93a`. Latest D1 migration is `0131_shorts_on.sql`. This is a snapshot: check `gh pr list` and `git log origin/main` before acting on it. Update this file at the end of every PR.

## How to work on this repo

Any person or agent can take over from this section. Rules for shipping, checks and merges are here. Longer history is in `docs/HANDOFF.md`. The agent guide is `AGENTS.md`.

**Shipping.** Ship the part that already passes. If one part keeps failing CI, drop it from the pull request and redo it later as its own pull request. Do not loop on the same red check. After a split, parts that already passed only need the quick checks: `node --check` on the scripts you touched, `python3 scripts/check_i18n.py`, `python3 scripts/assemble_site.py --selftest`, `python3 scripts/handle_guard.py --selftest`, and `python3 scripts/secret_scan.py --staged`.

**One change per pull request.** One fix per pull request. Do not bundle a doc change, a workflow change and a product fix in the same pull request.

**This file.** Every pull request updates `docs/STATUS.md`: what merged, what is live, the paused roadmap, the current plan, the working rules and the owner to-dos.

**CI.** Page smoke is sharded and finishes in about 2.5 minutes. Locally, `scripts/smoke-all.sh` runs those scripts in parallel (`--jobs` sets how many at once; `--shard` runs one job). A pull request that only touches `**/*.md` and `docs/**` does not run that suite. `.github/workflows/smoke-docs.yml` still reports the required check named `smoke` and succeeds, so the pull request can merge. A pull request that also changes code runs the real Page smoke workflow as well, and that result must pass. Fix the root cause of a failure. Never weaken a test, drop an assertion or skip a check to make CI green, except by moving a still-failing part into a later pull request as described above.

**Merge.** Squash-merge only when every check is success or skipped and the pull request is clean. Pin the merge to the head commit (`gh pr merge <n> --squash --match-head-commit <sha>`). After a merge to main, rebase or merge main into any open pull request whose state becomes dirty.

**Verify live.** After a merge, the published `version.json` shows main's commit, and the accounts watchdog returns HTTP 200. If a deploy fails on a transient Cloudflare API error (for example error 10013), the owner re-runs the failed jobs, Accounts first and then Sync feeds. Agent tokens cannot re-run Actions.

**Hard rules.** No usernames, handles, display names or account identifiers in the public repository, pull requests, commits or logs. Never weaken the handle guard. Secrets live only in GitHub Actions secrets and Cloudflare Worker secrets. Do not edit `.github/` without the owner's approval; put a ready patch in `docs/owner-patches/` instead. No force-push and no history rewrite without asking. No paid APIs. Do not bypass a block, a guard or a failed check.

**Current state.** Main is `f70a4ef5` (a setting the person just changed keeps its stamp). This pull request stops a sync echo from writing an older block list over a block made while that request was in flight, so the other open tab still drops those posts. Page smoke `shard-home` failed on `53ce5e57` because a link-preview navigation was aborted (already retried before this) and on `031b4912` because blocking in one tab did not reach the other. The cross-tab check is unchanged. Still open: the phone sign-up welcome step (`scripts/signup_flow_test.mjs`, no part flag and no assertion changes; it is not in the sharded jobs). The TikTok and Shorts roadmap stays paused. X-style replies and quotes wait for the owner's go.

## Speed log

Desktop, CPU slowed 4×, unless a row says otherwise. Each row is the change that landed.

| Change | Before | After |
| --- | --- | --- |
| For You first page | Phone, CPU slowed 4×, repo feeds. The first paint and every later feed arrival rebuilt up to 33 cards at once (largest single insert 25 to 33 cards). After the first posts showed, long tasks were 1.1 to 1.3s in total, the longest 210 to 234ms. Time to 3 posts about 2.7s. | The first paint draws 6 cards. Until the reader scrolls, repaints from later feed arrivals draw only those 6, and the rest of the first page (25) is added 4 cards per idle slot. Scrolling adds 4 per frame. Largest single insert 6 cards. Long tasks after the first posts 0.68 to 0.72s in total, the longest 114 to 117ms. Time to 3 posts unchanged (about 2.7s, network bound). Six scroll flicks reach 48 to 50 posts (38 to 40 before). Test: `scripts/foryou_chunks_test.mjs` (`foryou-chunks`, `home` shard). |
| Main tabs, return | Explore 69ms, Notifications 75ms, Messages 52ms, Profile 74ms, Following 235ms, Communities 330ms. Scroll from that visit was not kept. | Explore 44ms, Notifications 34ms, Messages 39ms, Profile 43ms, Following 64ms, Communities 108ms. Explore, Notifications, Messages and Communities came back at 420px. Profile and Following settle at 96px, as they did before. |
| Music code | `music.js` 125 KB, `ytm.js` 58 KB and `music.css` 27 KB (210 KB) download with every visit | Those files load when music is opened, or when a song is already queued so the mini player returns. The dock check passed on phone, desktop, tablet and landscape. Live at `f38acb31`. |
| Signed-out first paint | Phone, 4G, CPU slowed 4×, live site: first paint and largest text 2.0s, the landing paragraph, layout shift 0. `styles.css` (273 KB) finished at 1.8s and held that paint. | Live after: first paint and largest text 1.55s. `styles.css` finished at 2.3s, after the paint. Layout shift 0.015. Signed-in visits still wait for the sheet. Live at `6ac5caa8`. |
| Home scroll, next page | CPU slowed 4×, phone width. Loading the next posts rebuilt the whole shell inside the scroll observer: 226ms of script, frame 287ms (237ms blocking). | The new cards are inserted eight at a time on later frames. The longest app script in that scroll was 36ms. Feed clicks and community scroll still passed. |
| Like, repost, follow, compose | The new state waited for a full page redraw inside the tap. | The control flips (or presses) before that redraw. The redraw runs on the next frame. |
| Open a post or profile | A post was rebuilt on every return. A profile fetch started at the click. | Leaving a post keeps that page and puts it back, same as the main tabs. A profile link starts its fetch on hover or touch. Live at `93c99f1a`. |
| Saved home, per account | Phone, CPU slowed 4×. The last account's home was painted for the next account on the device (the restored screen included that home). Same-account warm open, feed held 3s: content at 203ms. | The other account does not get that screen. Same-account warm open, feed held 3s: content at 166ms. Route copies are stored per account. IndexedDB still fills them in and the page paints when that copy arrives. Sign-out still wipes the store. Likes, reposts, follows and posts still apply immediately and retry from the outbox when online. |
| Scroll, remaining long tasks | Phone, CPU slowed 4×. During a scroll the feed response body read took 112ms and persistent storage took about 80ms. Worst frame 118ms (58ms blocking). | Those two wait until scrolling is quiet or the thread is idle. Worst frame in the same scroll was 83ms (18ms blocking). Longest app script 25ms. Live at `4dbba231`. |
| Public media from a peer | A segment already saved on the device still waited for a peer reply before that copy was returned. The reply is given up to 700ms, and the CDN request started only after it. | The saved copy is returned without that wait. The CDN request starts while the peer is asked. The first good answer is used. Peer bytes stay the public segment files the page already checked by hash. A peer miss or a bad answer does not hold the CDN. Live at `924ea183`. |

## Version publish

Sync feeds on `d1e84bbd` deployed the service worker, then `pages-mirror` failed at `node scripts/smoke_page.mjs --site _mirror` with `Chrome did not open a debugger`. The log only had dbus noise after the old fixed wait, so `publish-version` was skipped. Installed apps keep the update screen because `version.json` still names `2fd7f0d` until a later deploy publishes. Each launch now uses a fresh profile, `--no-sandbox`, `--disable-dev-shm-usage`, and `--remote-debugging-port=0`. The check reads the port from Chrome's stderr (`DevTools listening on ws://…`) or from `DevToolsActivePort`, waits up to 30 seconds, and tries the launch at most three times. A page assertion that fails is not retried.

Main's Page smoke run 41735261194 failed `shard-ui-fast` on privacy. The log line is `locator.scrollIntoViewIfNeeded: Element is not attached to the DOM` at `scripts/external_following_test.mjs:170`, then `external following checks failed`. That failure is not part of the landing paint.

The phone signup flow was run five times locally on the 390×844 size after the static landing. The autoplay choice saved every time. A later CI run reported `phone full: autoplay choice did not save` once; the same shard had passed on the previous run of this change.

## App updates

The build the service worker is already running is the version on the device. `version.json` is published only after the live check, so it can lag that build when the check has not passed. A mismatch does not offer an update. The live loop was service worker `c2b9cb09` with `version.json` still `3a6f2de`: that difference does not reload the page or open the update screen, and each service-worker build reloads at most once. The next publish writes `version.json` from the sha already stamped into `sw.js`, and fails if those shas differ. A missing or unreadable `version.json` leaves the open copy alone. Each build is offered and applied at most once on a device, and the page reloads at most once for that build. The new files download in the background. While that download is ready, a small pill stays on the page (Update ready · Tap to refresh). A swipe or a tap outside does not remove it, and Later only means not right now: it does not skip that build. The pill goes away when the build is applied. Tap applies it immediately. Otherwise it applies the next time the app is hidden or opened again, or on the next navigation. An open composer, a modal, or typed text holds that apply until it closes. Each service-worker build still reloads at most once. Right after that build is applied, What's new appears once: a bottom sheet on a phone and a centered card on a desktop, with the changelog and Got it. It does not block the page, and it does not come back for that build. A full-screen step is only for a critical update or a failed one. Unchanged files already on the device, matched by hash, are not downloaded again. `skipWaiting` and `clients.claim` run once for a worker, so the page does not reload twice.

## Fast update apply
An apply that starts before the quiet background download finished (`runApply` in `sw.js`) waits only for `SHELL_CORE` (about 20 files, 0.5 MB), switches over, then downloads the rest of the shell in the background, still pinned to the same version by `shell-manifest.json` hashes. Activate keeps the older shell and the download cache until that finishes (`keepShells`), so unchanged files are copied instead of downloaded, then `dropOtherShells` removes them. A shell file that is not saved yet is fetched with `cache: "no-store"`, so an older HTTP-cache copy is never mixed in. Measured locally (phone viewport, 226-file shell, no matching manifest, 120 ms latency, 2 MB/s per file): apply to new worker 9.4 s → 2.5 s, 227 → 22 files before the switch; at 200 ms and 0.5 MB/s, 18.8 s → 4.7 s. The background-download toast was the "Updating" popup that stayed up the whole download (7.7 s → 0 s in the same run).

## For You switch

Settings › Display has a For you switch, like uninstalling a module. Off removes the For You tab and the For you menu row, Home opens on Following (`#/` and `#/home` too), and `shared/for-you.js` is never requested: `index.html` leaves it out of the late scripts and the service worker leaves it out of the shell download (`FEATURE_FILES.forYou`). Turning it off also clears For You's saved memory (`viktorychapp-foryou-v1`, `foryou-communities-v1`), its scroll and saved Home copy. On brings the tab and script back after one reload. The owner switch `foryou_off` (feature-flags.js, Settings › Owner) turned off hides the choice and keeps For You on for everyone. Test: `scripts/foryou_off_test.mjs` (`foryou-off`, `home` shard).

## Tab title privacy

On a desktop (700px and wider, with a mouse) the tab title is only `ViktorychApp` on every page: no page name, unread count, search words or person's name in the tab, the window list or browser history. `withUnreadTitle` returns the app name there, and a watcher on `<title>` puts it back when any other script (Spaces, Inbox, the landing) writes one. Phones and touch tablets keep page titles. The TV app keeps the name the person picked for it (`FeedsTV.appTitle`). Test: `scripts/title_privacy_test.mjs` (`title-privacy`, `ui-fast` shard).

## Desktop corner buttons

On a desktop (700px and wider with a mouse) the + post button and the Local AI button are 56px squares with 16px corners, like the corner dock launchers, and they stack in one column above the right dock square with 12px gaps. Before, the round Local AI button sat on top of the dock's messages square. Above a bottom bar the column lifts 53px with the dock. Phones and touch tablets keep the round buttons. Test: `scripts/desktop_squares_test.mjs` (`desktop-squares`, `ui-fast` shard).
## Viktrych

The on-device AI (Local AI in the code, `#/ai`, flags `local_ai` and `local_ai_setup`) is called Viktrych in every language; the app is still ViktorychApp. Only the translated values changed, so the `tr("Local AI…")` keys stay. Its logo is a V with a small spark (`icon("viktrych")`, class `vk-logo`, file `logo/viktrych.svg`). It is on the floating AI button, the Home header icon, the drawer row, the Settings entry, the chat page and the dock square, and on the explain button on posts. A post shows one AI button: with Viktrych on, the on-device summary button is not added next to it. On phones the Viktrych button is the + button's size (56px), on the same right edge, 12px above it, and it follows it above the music player and a docked Space. Test: `scripts/viktrych_test.mjs` (`viktrych`, `nav-shell` shard).


**Chat home.** With a model installed, the phone chat page looks like the Grok app home: a large plain Viktrych logo in the middle with a short line under it, suggestion chips, and a rounded box (28px) pinned to the bottom. Quick settings sit behind a "Quick settings" chip on phones and stay inline on desktop. The box takes focus whenever the page opens (not during setup, and never over a field being typed in elsewhere). On touch screens, a tap on any `#/ai` link focuses a hidden field inside the tap so iOS opens the keyboard, and the page then moves focus into its own box. Test: `scripts/viktrych_home_test.mjs` (`viktrych-home`, `nav-shell` shard).
## X-style icons

Closed folders, Profile, Friends, Feeds (also Creator Studio) and the post buttons use X-style line icons (`XLINE` in `app.js`, drawn with a stroke and never filled, class `xline`). Profile is one person, Friends is two people, Feeds is stacked layers, and Local AI keeps its spark, so no two menu rows share an icon. The phone post button and the collapsed desktop Post button show a pen with a small plus. The Viktorychs coin is one icon (`icon("coin")`, also `ViktorychGifts.coin()`): black inside with white lines and a thin light rim so it still shows on dark themes. It is the drawer and sidebar icon for Viktorychs and sits next to every Viktorychs amount. Test: `scripts/x_icons_test.mjs` (`x-icons`, `nav-shell` shard).

## Home composer on phones

Below 600px the Home inline composer ("What's happening?") has no profile picture, collapsed or open, so the placeholder starts at the 16px left padding like X mobile (`x-compose.css`, last media block). Tablet and desktop keep the picture. Reply boxes are unchanged.

## Post ring is keyboard only

The ring around a post (`article.post.kb-focus` in `keys.css`) is a keyboard aid. It shows only after j/k (or the arrow keys) move it. A tap, a touch scroll or a mouse click only remembers that post as the start point for the next key press; they never paint the ring, and a later redraw does not put it back (`ringOn` in `keys.js`). Before, tapping Like or anything on a card painted a purple box around that card after the next redraw. Test: `scripts/post_ring_test.mjs` (`post-ring`, `nav-shell` shard).

## In-app post authors

Posts, replies, quotes and reply parents from in-app accounts carry the author face the server lets this viewer see: `authorAvatar` is a `/v1/media/view/<id>` URL or empty, never the stored R2 key. That key was why some app authors showed a letter instead of their picture (the browser loaded the key as a relative path and got a 404). The same response sends `authorLocked` (private follows or protected) and `authorOfficial` (site owner), and the byline shows the lock and the Official badge from the profile name row (`postAuthorFace` in `worker/src/profile-media.js`, `appMarks` in `app.js`, `ViktorychAccounts.authorMarks`). The site owner sees every profile picture and banner whatever its audience or hide setting, there and on profiles. Tests: `worker/test/post-author-face.test.mjs`, `scripts/post_author_marks_test.mjs` (`author-marks`, `compose-a` shard).

## Post card

Timeline cards and replies use X’s header and action row. The row is reply, repost, like, views, then bookmark and share grouped at the right edge. Icons are 18.75px. Counts are 13px in the muted gray, in X’s compact form (2.2K, 7.4K, 151K, 5.2M; a comma decimal where the locale uses one). The header line is the name, verified badge, handle, and time, then one right-aligned group: the on-device explain mark, the sparkle, and the vertical ⋯ menu. The sparkle is not in the action row. The card keeps a 40px avatar, a 12px gap, and 16px side padding on phone, tablet, and desktop. The share glyph is X’s arrow-out-of-a-box icon. In landscape, the overflow menu opens above an achievement alert so its items stay tappable. The music player is unchanged.

## Edge to edge

Phones and tablets fill the screen. The page uses `viewport-fit=cover`, a theme color, and the standalone status bar `black-translucent`. The top bar is translucent and blurred and its padding is the top inset, so it draws under the status bar. The bottom tab bar’s height includes the home-indicator inset and the icons stay in the 53px above it. The column fills `100dvh`, so there is no empty band under the home indicator. On a phone the music bar sits above the tab bar; on a tablet it sits above the home indicator. Landscape still pads the left and right insets, and an iPad-sized window keeps the icon rail.

## Full screen

The manifest's `display_override` is `window-controls-overlay`, `fullscreen`, `standalone`. Desktop installs keep the title-bar overlay. The installed Android app opens immersive, without the status bar and navigation bar; a swipe from an edge shows them. Older installs keep their old mode until the app is reinstalled. `display` stays `standalone` for iOS, which cannot hide its status bar in a web app and keeps `black-translucent`. The installed checks also count `display-mode: fullscreen` when it is not a tab using the Fullscreen API. Settings > Display has a Full screen switch for browser tabs. It calls `requestFullscreen` on the tap, and a saved switch re-enters on the first tap after a load. The row is hidden where the Fullscreen API is missing, such as iPhone Safari, and inside the installed full-screen app.

## Repair app and updates

**Repair app** (Settings > Display, owner switch `app_repair`, on by default) unregisters the service worker, deletes the app-file and feed caches (`shell-*`, `data-*`, `media-*`, `live-*`), and reloads from the network. It keeps the login, settings, drafts and other IndexedDB and localStorage data, the `viktorych-prefs` cache, music downloads and Local AI models. When a signed-in Home has no tab row, or For you still has no posts after about 15 seconds online, a small card offers the same repair once per session.

**Reinstall guide.** A web app cannot uninstall or reinstall itself, and an installed Android app keeps the window mode it was installed with. An Android app open in `standalone` (installed before the manifest preferred `fullscreen`) shows a one-time card with the steps: uninstall from the icon, open the site in Chrome, tap Install. After that, the browser tab shows Install again as soon as Chrome offers `beforeinstallprompt`.

**Quiet updates** (owner switch `auto_update`, on by default). The service worker already downloads a new build in the background, then `skipWaiting` and `clients.claim` run once and the page reloads once per build (the reload guard in `update.js`), so old and new files are not mixed. A ready update was applied when the app was hidden or the route changed; it now also applies once it has been ready, with the update pill showing, for 20 seconds without a touch, key or scroll. Typing, a playing video or an open composer still hold it.

Test: `scripts/app_repair_test.mjs` in the `nav-layout` shard.

**Visible updates** (owner switch `update_notice`, on by default, all in `update.js`). The background download is quiet. While a build applies, a small "Updating ViktorychApp…" toast (`#upd-status`, `pointer-events: none`, `aria-live`) sits at the top for at most 4 seconds (`TOAST_MAX_MS`); past that the apply carries on unseen and the page reloads itself. A downloaded build that is waiting (typing, a playing video, an open composer) keeps the pill, which now reads "Update ready, tap to restart"; a tap is the go-ahead (`state.userGo`): drafts are saved by `captureState`, the build applies with the small toast instead of the progress screen, and the page reloads once on the dark boot background (`#000` in `index.html`, dark `theme-color`). After the apply, What's new is a full-screen, edge-to-edge dark page (`.upd-wn`, still `#upd-notes-sheet` / `#upd-gotit`) with our logo, the version, one card per `version.json` changelog line with a simple icon (`noteIcon`: fix, fast, look, new), and one Continue button; the X, Escape, a swipe down or sideways also close it. Once per build (`viktorychapp-notes-seen`). An app the system closed that cold-starts into a build this device has not run before also gets it (`viktorychapp-wn-last`; never on the first run). CSS-only animations, none with reduced motion. Switch off: the old silent download, the pill "Tap to refresh" with the progress screen, and the bottom sheet with Got it. Tests: `scripts/update_notice_test.mjs` (nav-layout shard), `scripts/update_flow_test.js` (`statusKind`, `noteIcon`), and `scripts/sw_update_test.mjs` (its classic-sheet check runs with the switch off).

## Swipe between tabs

On a phone or tablet (under 1000px wide), a sideways drag on Home or on a profile moves the content with the finger, and the tab underline slides toward the next tab. Letting go past a quarter of the screen, or after a quick flick, opens that tab; a shorter drag springs back. The drag only counts once it is clearly sideways (1.5 times more sideways than vertical after 10px), so scrolling up and down is never taken. Drags that start on the tab row, a sideways scroller (pills, stories), an input, a video, or within 20px of a screen edge (the browser's back swipe) are left alone. With reduced motion the swipe still switches, without the sliding. Owner switch `swipe_tabs`, on by default. Test: `scripts/swipe_tabs_test.mjs` in the `nav-layout` shard.

The fresh-login report (feeds and tabs missing after a first login on a reinstalled app) did not reproduce locally and was closed by the owner; Repair app (above) is the user-side fix for a stuck install.

## Compact Home header and status bar

On a phone, the Home header has no app name: the drawer button (your picture) on the left and a sparkle on the right that opens Local AI (`#/ai`; it opens Settings when Local AI is off for everyone). When the header slides away on scroll, the avatar row, the stories tray and the live pills row leave together, so only the tab row stays pinned at the top under the status bar (`--keep-tabs-y` and `--keep-tabs-cut`, set in `paintChromeHidden`). Display settings has **Classic header** (app name in the middle, Settings on the right, the whole bar slides away) and **Show phone status bar** (`statusBar`): the installed app's `theme-color` is the theme colour (light `#FFFFFF`, dim `#15202B`, dark `#000000`) instead of `transparent`, the Full screen switch hides, and the reinstall-for-full-screen card is not offered. Owner switches `compact_header` (off = classic header for everyone) and `status_bar` (off hides the option). Test: `scripts/compact_header_test.mjs` in the `nav-layout` shard.

Header size is fixed: at rest it is one status-bar inset plus the avatar row, the tab row and the pills; scrolled down the avatar row and the pills row leave (it fades so it does not peek through behind the status bar) and the tab row sits right under the status bar. Every top inset in `styles.css` reads `var(--sat, env(safe-area-inset-top, 0px))`. `applySafeTop()` (called from `applyTheme`, again on resize, orientation, full-screen and display-mode changes) sets `--sat` only when `env()` disagrees with where the page is: an installed app that Chrome placed below the status bar (the page is no taller than `screen.availHeight`) gets `--sat: 0px`, `data-sat-below` on `<html>` and the theme colour as `theme-color` instead of `transparent`, so there is no second gap and no grey band; an inset taller than all system bars together is capped. Test: `scripts/header_stable_test.mjs` (`header-stable`, `nav-layout` shard) checks rest and scrolled heights across resize, landscape, inset changes and installed modes.

Home with a stories tray (every signed-in phone) follows the same rule. Before, `onChromeScroll` never slid the header away when `.story-shell` was on Home, and `stories.js` shrank and re-grew the tray (and `main.center` padding) on every scroll event, so on phones the header kept the avatar row and tray on screen (a fat header) and changed height while scrolling, which with scroll anchoring on touch could make it grow back while scrolling down. Now, below 1280px wide (`headerSlides` in the Stories deps), scrolling no longer resizes the tray: the avatar row and the tray slide away together by transform and only the tab row (and pills) stays under the status bar. The tray fades out with the avatar row when tucked, so nothing of it peeks through the status-bar strip above the tabs (visible in full screen and with a notch). The tray still tucks on scroll on wide desktops, where the header never hides. Test: `scripts/header_frames_test.mjs` (`header-frames`, `nav-layout` shard) records the header every animation frame while scrolling down (Chrome's URL bar collapsing mid-scroll in a tab) and back up, in a browser tab, standalone and fullscreen, compact and classic header, status bar mode, insets 0/24/48px, with and without a demo stories tray, and fails if the header bottom passes its at-rest bottom, its height changes, anything but the header is at the top edge, it drops below the top edge, it never tucks, the tucked compact header leaves the tab row anywhere but right under the inset, or the avatar row or tray still shows in the strip above it. `FULL=1` runs all 72 combinations; the default set runs 12 (about 2 minutes).

The header is one unit, like the X app. Below 1280px the top bar tint is 85% (dark `rgba(0,0,0,.85)`, light white, dim `rgba(21,32,43,.85)`) with the 16px backdrop blur, and the live pills row inside the header has no background of its own, so the status strip, avatar row, tray, tabs and pills share one continuous blurred background. On the compact Home header the tint and blur are on a `::after` layer behind the content: when the header tucks away, the layer's top follows the slide (it stays at the top edge) and its bottom stops right under the tab row (`--keep-tabs-cut`), the pills row hides, and the header lets taps through below the tabs. So scrolled, only the tab row shows, on its own blurred background that keeps labels readable over images, and nothing floats over the posts. A `clip-path` is not used because it turns the backdrop blur off in Chrome. `scripts/header_frames_test.mjs` also checks on every frame that the tab row's background (or the header layer behind it) is at least 80% opaque and that nothing covers the tab row, and on every tucked frame that nothing of the header shows under the tab row.

Tab strips look like the X app's on every row (Home, profile, notifications, search, lists), phone to computer: bold active label in the text colour, gray labels on the rest, one thin (3px) rounded underline as wide as the active label only (on Home it no longer runs under the For you caret), the hairline under the row, a smaller caret, 16px side padding on profile tabs, and no hover box behind a tab on touch screens (`@media (hover: none)`). The customize (sliders) button stays at the end of the Home tabs; no + is added. Rules sit at the end of `styles.css`. Test: `scripts/tabs_look_test.mjs` (`tabs-look`, `nav-layout` shard).

Android limitation: an app installed in `fullscreen` display mode cannot show the system status bar; no web API brings it back, and an installed app cannot change its own display mode. With the setting on, the bar shows in a browser tab and in apps installed as `standalone`; on an older full-screen install the user has to open the app from the browser or reinstall it. On iOS the status bar is always shown, and `black-translucent` (fixed when the app is added to the Home Screen) keeps drawing the page behind it, so the setting changes only the colour where the browser uses `theme-color`.

## Pinch-zoom lock

On phones the page does not zoom, like an installed app: the viewport meta adds `maximum-scale=1, user-scalable=no` (set in `index.html` and kept in step by `applyZoomLock()` from `applyTheme`), iOS Safari's `gesturestart`/`gesturechange` are cancelled (it ignores `user-scalable=no`), and double-tap zoom stays off through `touch-action: manipulation` on `html, body`. The photo viewer zooms pictures itself (two-finger pinch on `#viewer-img`), so photos still zoom. Every text field is at least 16px on phones so iOS never zooms in on focus; the fields that were 13 to 15px (Settings, Messages and History search, Feeds, the presence form and audiences) get 16px from one rule at the end of `styles.css`. Display settings has **Allow page zoom** (`pageZoom`) to turn the lock off for one person; the owner switch `zoom_lock` turns it off for everyone and hides the setting. Test: `scripts/zoom_lock_test.mjs` in the `nav-layout` shard.

## Notifications badge and defaults

The bell badge counts exactly the unread rows the All list shows (`bellUnread()`: `visibleNotes`, minus notes held by another feature, after the read cursor). It no longer adds the server's own unread number, which counted notes this device had not listed; with an old incremental cursor over an empty local list (settings reset, Repair app, new sign-in) the server only sent newer notes, so desktop showed 8 or 10 over empty tabs. Now an empty local list pulls the full list (`since` is dropped), and opening All marks everything read up to now even when the list is empty, sending the cursor to the server so the count clears. Notification types are all on (push) by default: likes and reposts were in app only. Only keys the person changed are kept as choices (`notePrefsSet` in the app, `_set` in the stored row); an older row's copied defaults (likes/reposts "inapp") count as unset, other changed values stay. Tests: `scripts/notif_badge_test.mjs` (in the `notifications` step) and the prefs cases in `node worker/src/notifications.js --selftest`.

## Storage permission notice

"This browser may clear saved posts" (`persist-denied` in `setting-alerts.js`) is a notice only (`noPop`): it is kept in Notifications and Storage settings but never pops out over the page. Since #558 asks for persistent storage once scrolling is quiet, a fresh browser tab got the info pop-out within seconds of the first visit, on top of sign-up; on CI it covered buttons and broke `shard-signup-flows` on main. Test: `scripts/setting_alerts_test.js`.

## Posts under the bars

On a phone, and on a tablet or iPad split view under 1280px wide, the top bar and the bottom tab bar are translucent and blurred. Posts scroll underneath them. Scrolling down slides the header up until only the status-bar strip remains, still blurred, and slides the tab bar fully off the bottom edge. The icons are never faded. The post button and the Local AI button stay fully solid and drop 53px to sit above the home indicator. Scrolling up brings everything back. When scrolling stops for 1.2s, the tab bar and buttons slide back (`html.bar-rest`) so navigation is always one tap away; the header stays tucked away. Browsers without backdrop-filter get a solid bar. The profile banner and its floating header meet the top of the screen. Modals, the drawer, and the video viewer use the dynamic viewport height and pad their controls for the insets. The music bar stays above the home indicator, or above the tab bar on a phone. Desktop, 1280px and wider, is unchanged.

An installed app can draw under the system bars. iOS standalone uses `black-translucent`, so the page shows through the status bar and the home indicator. An installed Android app does the same when Chrome honors `viewport-fit=cover` and a transparent theme color, with `safe-area-inset-*` and, where the browser supports it, `safe-area-max-inset-bottom`. A normal Android browser tab cannot draw under the status bar: that bar stays a solid strip in the theme color (black, dim `#15202B`, or white). The manifest splash stays lights-out black; the open app switches the theme color for a browser tab, and uses transparent for an installed app.

## Layout backlog

Not started. Measured against the current X web layout:

- Post detail still uses 22.5px action icons and 14px counts, and bookmark and share sit in the same row as reply, repost, and like.
- The profile name is 20px on a 24px line, and the cover overlap is not the same as X’s profile header.
- Compose is a single row with 8px vertical padding; X’s compose box is taller and the tools sit on their own line.
- A full-size tablet uses the icon rail. Only a window narrower than 500px uses the bottom tabs.

## Merged today

- **#542** Shorts still downloads with the app, and that arrival no longer repaints an open page. Squash merge `bfa052eb`.
- **#541** Shorts loads with the app so the owner page check can see it. Squash merge `b22d61e4`.
- **#535** Faster first load: signed-out visits load the landing set only. Squash merge `5b6f084d`. Live after its deploy.
- **#536** Page smoke is split into parallel jobs of about 2.5 minutes. Squash merge `2dc8cf77`.
- **#531** Shorts re-enabled (owner-only): viewer cap, on-device stream-copy recording, native frame grab, playback fallback, TikTok follow placement. Squash merge `904144017f5260ab140efdeee40cab1357e4f72f`. Live on both sites (`version.json` matched that sha, watchdog HTTP 200).
- **#532** A new community folder keeps its typed name when the page redraws, so Create still makes the folder. Squash merge `eb6cee2deb532bbf4f31f35e042fd9fe67277d39`. Its pull-request Page smoke passed. Main's own Page smoke for that commit was still running when this note was written.
- **#537** The blue toast stays fixed and moves above an open info or achievement alert, so Undo stays tappable. Squash merge `e4f38df3`.
- **#538** A phone route change attaches the new view. Settings is not left on Home, and Sign up reaches its welcome step. Squash merge `39623360`.

## Toast and alerts

The blue toast stays fixed, so it does not push the page. When an info or achievement alert is open, the toast moves up until it sits clear of that card, on every viewport. Undo and the other toast buttons stay tappable.

## Birthday reminders

A birthday note is sent only to someone who still follows the celebrant. Each follower has their own note key, so one person's push id cannot collide with another's and drop or mis-file the write. The birth year stays out of the note's words. The reminder test checks those words. It does not search the whole JSON, because the sync cursor is a millisecond timestamp and that clock sometimes contains the digits `1990`.

## Settings while the feed loads

A reload to `#/settings` could keep the Home heading, so Log out was missing. While the feed was loading, Settings was painted as the Home skeleton, and a Home frame that had already started could still be committed after the address moved. Every route uses the same rule, including the screen Sign up opens from. A commit whose route is not the current `location.hash` is discarded. After the document has loaded, the current address is built and committed once. Before `DOMContentLoaded` that second build does not run, because it kept the phone reload from finishing. One corrective render can follow, on a later frame, and only once for that hash change. A render is not dropped on the floor, so the new view still gets attached.

## Page smoke on docs-only changes

Page smoke skips pull requests and pushes to main that only touch `**/*.md`, `docs/**`, or `.github/workflows/smoke-docs.yml`. The required check is still named `smoke`. `.github/workflows/smoke-docs.yml` is the stub: it runs only on a pull request that changes `**/*.md` or `docs/**`, its job name is `smoke`, and it prints `docs-only: page smoke not needed` and succeeds. A docs-only diff does not start the real suite. A pull request that also changes code runs the real Page smoke workflow, and that result must pass. If a shard is cancelled because a newer push superseded the run, the `smoke` job does not fail that head.

## Paused roadmap

Do not start these unless the owner asks.

- **PR 2.** 3D view, Join with my camera (including No frame), real-frames-only slow motion. No interpolation, no synthetic frames.
- **PR 3.** X-style Past recordings rebuild, shared player features, full screen, zoom preserved everywhere.

## Cold first paint

Signed out, the landing text is in `index.html` with the critical layout in a style block, so the largest text does not wait for the app. The home skeleton (the two opening posts) is in the HTML too. The app replaces that shell when it is ready. Phone, 4G, CPU slowed 4×, signed out, gate on: largest text was 9.0s (the landing paragraph, after the app loaded). It is now 3.5s, the same moment as the first paint, and the layout shift score stayed 0. The music player and the update flow are unchanged.

## Music loads when it is opened

The music page, the mini player and playback are the same. The scripts and stylesheet stay out of the first load. Opening music, or reloading while a song is queued, fetches them and then paints. A visit that never opens music does not request them.

## Main tabs stay ready

Leaving Explore, Notifications, Messages, a profile, Following, or Communities keeps that page. Coming back puts the same page in place and restores the scroll position. A background refresh can follow. Home already worked this way.

Desktop, CPU slowed 4×. Before, the return built the page again. Time until the new title was showing: Explore 69ms, Notifications 75ms, Messages 52ms, Profile 74ms, Following 235ms, Communities 330ms. The scroll position from that visit was not kept.

After, the kept page is back: Explore 44ms, Notifications 34ms, Messages 39ms, Profile 43ms, Following 64ms, Communities 108ms. Explore, Notifications, Messages, and Communities came back at the scrolled position used in the check (420px). Profile and Following settle at 96px, which they also did before this change. Communities is a long list, about 40,000px tall, and putting that scroll position back is most of the 108ms. Following is a home tab: the click reaches the address change at about 41ms and the page is back at 64ms.

## Back to Home

Leaving Home keeps the page that was on screen. Coming back puts that page back immediately, then weaves in posts that arrived while you were away. A background refresh while Home is already showing waits for the next frame, so it does not block a click. Measured with the feed-load click check (desktop, CPU slowed 4×, feeds held for 3 seconds): back to Home was 32ms, 34ms and 29ms. Before the parked page, the same last click was about 310–340ms. The Following list, community scroll, and the music player still load the way they do on main.

## Shorts on the first load

The live site was serving the new build while `version.json` still named the previous one, because the owner page check never saw the Shorts module. Shorts waited on an idle preload that starts eight seconds after the app, and the check stops about eleven seconds after the load event. That preload now starts with the app. It still stays unloaded when the server switch is off. The YouTube embed helper is the same file as before this load change.

The first version of that preload repainted the whole page when Shorts arrived. On a phone, opening a corner drawer and then narrowing the window scrolled the timeline (the navigation check saw 783px). Shorts still downloads with the app, and that arrival no longer repaints. Opening the Shorts page still paints.

## Speed

Pull request #535 keeps the load-time work only. Phone profile 390×844, 4G, CPU slowed 4×.

| | Before | After |
| --- | --- | --- |
| Cold signed-out landing | LCP 7–10s, about 1.86 MB, 111 JS files (1,558 KB of JS), TTI about 10s | LCP 8.8s on the landing paragraph, FCP 3.6s, 21 JS files (1,083 KB of JS), about 1.5 MB |
| Warm landing | about 0.5s | LCP 564ms, FCP 412ms |
| CLS | 0.17 from the alert toast | 0 |

Signed-out visits load the landing set only. Only the active language pack downloads. The service worker registers from `index.html` and fills its cache after the first screen. Landing images reserve their size, and the alert toast is fixed so it does not push the page. `app.js` stays one file. Cold LCP is still the landing paragraph, which waits on `accounts.js` and the language pack.

Music, TV, Discord, gifts, Nostr and nearby chat load with the first page, the same way they do on main. Loading those later is a separate follow-up pull request. Parked pages, in-place list updates, and restoring scroll after a rebuild are also not in this pull request. Navigation, including the phone route commit, matches main.

## Working rules

- Shipping, CI and merge rules are in [How to work on this repo](#how-to-work-on-this-repo).
- Run the full check suite locally before every push. After a split, parts that already passed only need the quick checks listed above.
- Fix app bugs in the app. Do not weaken tests.
- The handle guard is never weakened. No usernames, handles or account IDs in the public repo.
- Do not edit `.github/`. Workflow changes go in `docs/owner-patches/`.
- Owner gate: confirm the site is live and main's checks are green before opening the next PR.
- Update `docs/STATUS.md` at the end of every PR.

## Owner TODO

Enable the four TikTok workflows by hand. Steps: `docs/owner-patches/tiktok-workflows-enable.md`.

- TikTok added accounts
- TikTok live
- TikTok record
- TikTok live upload

They stay `disabled_manually`. The watchdog warning for the live workflow being off is expected until then.

## Previous snapshot (2026-10-30)

Written 2026-10-30, about 10:00 CET (09:00 UTC). Main was at `f353f771` and the latest D1 migration on that day was `0102_regone_social.sql`. Recheck every open PR below before acting on it.

## Fast tests

This branch includes main through `#536`. Page smoke is split into parallel CI jobs. Each job runs its scripts one at a time, and viewport checks inside a script run one at a time. The service-worker update check has its own job and runs with nothing else. The required check is still named `smoke`; it passes only when every shard passes.

Follow-up: the phone sign-up viewport check (`scripts/signup_flow_test.mjs`, the same Sign-up and first-run step main's Page smoke runs, with no part flag and no assertion changes) is not in these shards. On a phone it still stops at "Sign up never opened the welcome step". That is a route bug for a separate pull request. `signup-flows` stays in this one. Locally, from the repo root:

```sh
scripts/smoke-all.sh
scripts/smoke-all.sh --jobs 4
scripts/smoke-all.sh --changed
```

`--jobs` is how many scripts run at once. A run that includes a timing check uses one script at a time, and that check runs after the others. `--changed` runs the scripts that cover files changed since `origin/main`. A file that is not in that map runs the full suite. CI does not use `--changed`. Worker tests run with `node --test` concurrency 4: `cd worker && npm test`.

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
| #571 Swipe through custom Home tabs too (velocity snap, tab strip follows) | Parked by the owner, open as-is | CI failed `swipe-tabs` ("swipe right did not return to For you" on CI only; passes locally), plus `compose-c` and `signup-flows`. Pick up later: fix the right-swipe check on CI, rebase, green CI. |
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

- How to take over: [How to work on this repo](#how-to-work-on-this-repo).
- Rules and how to ship: `AGENTS.md`.
- History and merge-queue details: `docs/HANDOFF.md`.
- Opening the repo in Antigravity and starter prompts: `docs/ANTIGRAVITY.md`.
