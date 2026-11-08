#!/usr/bin/env node
// Runs the Page smoke scripts. One site build, one static server and one
// Chrome per invocation. Independent scripts run together. Every script in
// the shard list still runs; nothing is dropped.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW = process.env.SMOKE_PW_PREFIX || "/tmp/pw-smoke";
const PW149 = process.env.SMOKE_PW149_PREFIX || "/tmp/pw149";
const realCore = path.join(PW, "node_modules/playwright-core/index.js");
const wrapper = path.join(root, "scripts/smoke_playwright.cjs");
const core149 = path.join(PW149, "node_modules/playwright-core/index.mjs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8"
};

function step(id, run, extra = {}) {
  return {
    id,
    run,
    weight: extra.weight || 10,
    paths: extra.paths || [],
    needs: extra.needs || [],
    phase: extra.phase || "",
    quiet: !!extra.quiet,
    timing: !!extra.timing
  };
}

function file(name) {
  return new RegExp("^scripts/" + name.replace(".", "\\.") + "$");
}

const APP = [/^app\.js$/, /^styles\.css$/, /^index\.html$/, /^i18n\//, /^shared\//];

const PAGE_STEPS = [
  step("action-bar", "node scripts/action_bar_test.js", {
    weight: 40,
    paths: [/^app\.js$/, /^styles\.css$/, file("action_bar_test.js"), file("usage_panel_test.mjs")]
  }),
  step("assemble-self", "python3 scripts/assemble_site.py --selftest", {
    paths: [/^index\.html$/, /^sw\.js$/, /^scripts\/assemble_site\.py$/, /\.(js|css|html)$/]
  }),
  step("r2-catalog", "python3 scripts/r2_catalog.py --selftest", { paths: [/^scripts\/r2_catalog\.py$/, /^data\//] }),
  step("catalog-migrate", "python3 scripts/catalog_migrate.py --selftest", { paths: [/^scripts\/catalog_migrate\.py$/, /^data\//] }),
  step("handle-guard", "python3 scripts/handle_guard.py --selftest", {
    paths: [/^scripts\/handle_guard\.py$/, /^scripts\//, /^docs\//, /\.md$/]
  }),
  step("i18n", "python3 scripts/check_i18n.py", { paths: [/^i18n\//, /^scripts\/check_i18n\.py$/, /^scripts\/i18n_allow\.txt$/] }),
  step("about-layout", "node scripts/about_layout_test.mjs", {
    weight: 20, needs: ["pw"],
    paths: [/^about-ui\.js$/, /^accounts\.css$/, file("about_layout_test.mjs"), ...APP]
  }),
  step("points-layout", "node scripts/points_layout_test.mjs", {
    weight: 20, needs: ["pw"],
    paths: [/^gifts-ui\.js$/, /^gifts\.css$/, file("points_layout_test.mjs"), ...APP]
  }),
  step("telegram-stories", "python3 scripts/telegram_stories.py --selftest", { paths: [/^scripts\/telegram_stories\.py$/] }),
  step("stories", "node scripts/stories_test.js", { paths: [file("stories_test.js"), /^stories\.js$/] }),
  step("stories-layout", "node scripts/stories_layout_test.mjs", {
    weight: 20, needs: ["pw"],
    paths: [file("stories_layout_test.mjs"), /^stories\.js$/, ...APP]
  }),
  step("assemble-site", "python3 scripts/assemble_site.py --site _site && python3 scripts/cf_pages_prepare.py --site _site --out _mirror", {
    weight: 30, phase: "before",
    paths: [/^index\.html$/, /^sw\.js$/, /^scripts\/assemble_site\.py$/, /^scripts\/cf_pages_prepare\.py$/]
  }),
  step("smoke-site", "node scripts/smoke_page.mjs --site _site", {
    weight: 40, needs: ["built"],
    paths: [file("smoke_page.mjs"), /^index\.html$/, /^sw\.js$/, /^app\.js$/]
  }),
  step("smoke-mirror", "node scripts/smoke_page.mjs --site _mirror", {
    weight: 40, needs: ["built"],
    paths: [file("smoke_page.mjs"), /^scripts\/cf_pages_prepare\.py$/]
  }),
  step("sw-update", "PLAYWRIGHT_MJS=" + realCore + " node scripts/sw_update_test.mjs", {
    weight: 90, needs: ["pw"],
    paths: [/^sw\.js$/, /^update\.js$/, file("sw_update_test.mjs")]
  }),
  step("notifications", "node scripts/notifications_page_test.mjs && node scripts/notif_badge_test.mjs", {
    weight: 45, needs: ["pw", "browser"],
    paths: [file("notifications_page_test.mjs"), file("notif_badge_test.mjs"), ...APP]
  }),
  step("profile-tab-scroll", "node scripts/profile_tab_scroll_test.mjs", { needs: ["pw", "browser"], paths: [file("profile_tab_scroll_test.mjs"), /^accounts\.js$/, /^app\.js$/, /^styles\.css$/] }),
  step("profile", "node scripts/profile_chrome_test.mjs", {
    weight: 70, needs: ["pw", "browser"],
    paths: [file("profile_chrome_test.mjs"), file("mention_suggest_test.mjs"), file("friend_state_test.mjs"), file("my_devices_test.mjs"), file("feeds_page_test.mjs"), file("feed_requests_approve_test.mjs"), ...APP]
  }),
  step("foryou-chunks", "node scripts/foryou_chunks_test.mjs", { needs: ["pw", "browser"], paths: [file("foryou_chunks_test.mjs"), ...APP] }),
  step("foryou-off", "node scripts/foryou_off_test.mjs", { needs: ["pw", "browser"], paths: [file("foryou_off_test.mjs"), ...APP] }),
  step("home-tabs", "node scripts/home_tabs_test.mjs", {
    weight: 170, needs: ["pw", "browser"], timing: true,
    paths: [file("home_tabs_test.mjs"), file("boot_speed_test.mjs"), file("custom_tab_reload_test.mjs"), ...APP]
  }),
  step("tab-member", "node scripts/tab_member_test.mjs", {
    needs: ["pw", "browser"],
    paths: [file("tab_member_test.mjs"), /^app\.js$/]
  }),
  step("reply-lookup", "node scripts/reply_lookup_test.mjs", {
    needs: ["pw", "browser"],
    paths: [file("reply_lookup_test.mjs"), /^app\.js$/]
  }),
  step("pill-fit", "node scripts/pill_fit_test.mjs", {
    weight: 20, needs: ["pw", "browser"],
    paths: [file("pill_fit_test.mjs"), /^styles\.css$/]
  }),
  step("drawer", "node scripts/drawer_menu_test.mjs", {
    weight: 100, needs: ["pw", "browser"],
    paths: [file("drawer_menu_test.mjs"), file("customize_page_test.mjs"), file("desktop_app_test.mjs"), file("local_ai_page_test.mjs"), file("local_ai_setup_test.mjs"), ...APP]
  }),
  step("sidebar", "node scripts/one_sidebar_test.mjs", {
    weight: 25, needs: ["pw", "browser"],
    paths: [file("one_sidebar_test.mjs"), ...APP]
  }),
  step("title-privacy", "node scripts/title_privacy_test.mjs", { needs: ["pw", "browser"], paths: [file("title_privacy_test.mjs"), /^(tv|spaces|discord-ui|accounts)\.js$/, ...APP] }),
  step("desktop-squares", "node scripts/desktop_squares_test.mjs", { needs: ["pw", "browser"], paths: [file("desktop_squares_test.mjs"), /^dock\.(js|css)$/, ...APP] }),
  step("privacy", "node scripts/privacy_lists_test.mjs", {
    weight: 30, needs: ["pw", "browser"],
    paths: [file("privacy_lists_test.mjs"), file("external_following_test.mjs"), /^privacy-screen\.js$/, ...APP]
  }),
  step("yt-embed", "node scripts/yt_embed_smoke.mjs --root _site", {
    weight: 20, needs: ["built"],
    paths: [file("yt_embed_smoke.mjs"), /^app\.js$/]
  }),
  step("x-video", "PLAYWRIGHT_CORE=" + core149 + " node scripts/x_video_play.mjs --root _site", {
    weight: 40, needs: ["built", "pw149"],
    paths: [file("x_video_play.mjs"), /^app\.js$/]
  }),
  step("signup-sizes", "SIGNUP_PART=sizes node scripts/signup_flow_test.mjs", {
    weight: 200, needs: ["pw", "browser", "worker"], timing: true,
    paths: [file("signup_flow_test.mjs"), /^accounts\.js$/, /^worker\/src\//, ...APP]
  }),
  step("signup-flows", "SIGNUP_PART=flows node scripts/signup_flow_test.mjs", {
    weight: 200, needs: ["pw", "browser", "worker"], timing: true,
    paths: [file("signup_flow_test.mjs"), file("tv_short_pair_test.mjs"), /^accounts\.js$/, /^worker\/src\//, ...APP]
  }),
  step("community-home", "node scripts/community_home_test.mjs", { needs: ["pw", "browser"], paths: [file("community_home_test.mjs")] }),
  step("communities-hub", "node scripts/communities_hub_test.mjs", { needs: ["pw", "browser"], paths: [file("communities_hub_test.mjs")] }),
  step("own-post", "node scripts/own_post_test.mjs", { needs: ["pw", "browser"], paths: [file("own_post_test.mjs")] }),
  step("author-marks", "node scripts/post_author_marks_test.mjs", { needs: ["pw", "browser"], paths: [file("post_author_marks_test.mjs"), /^accounts\.js$/, ...APP] }),
  step("post-page", "node scripts/post_page_test.mjs", { needs: ["pw", "browser"], paths: [file("post_page_test.mjs")] }),
  step("music-dock", "node scripts/music_dock_test.mjs", { needs: ["pw", "browser"], paths: [file("music_dock_test.mjs")] }),
  step("video-fallback", "node scripts/video_fallback_test.mjs", { needs: ["pw", "browser"], paths: [file("video_fallback_test.mjs")] }),
  step("ig-media", "node scripts/instagram_media_test.mjs", {
    weight: 45, needs: ["pw", "browser"],
    paths: [file("instagram_media_test.mjs"), /^app\.js$/, /^accounts\.js$/, /^worker\/src\/index\.js$/]
  }),
  step("source-assign", "node scripts/source_lists_client_test.mjs && node scripts/source_list_assign_test.mjs", {
    weight: 40, needs: ["pw", "browser"],
    paths: [file("source_list_assign_test.mjs"), file("source_lists_client_test.mjs"), /^source-lists\.js$/, /^app\.js$/, /^worker\/src\/source-lists\.js$/]
  }),
  step("device-guard", "node scripts/device_guard_test.mjs", { needs: ["pw", "browser"], paths: [file("device_guard_test.mjs")] }),
  step("usernames", "node scripts/usernames_settings_test.mjs", { weight: 80, needs: ["pw", "browser"], paths: [file("usernames_settings_test.mjs")] }),
  step("owner-user-settings", "node scripts/owner_user_settings_test.mjs", { weight: 30, needs: ["pw", "browser"], paths: [file("owner_user_settings_test.mjs"), /^owner-inspector\.(js|css)$/, /^accounts\.js$/, ...APP] }),
  step("display-names", "node scripts/display_names_test.mjs", { needs: ["pw", "browser"], paths: [file("display_names_test.mjs")] }),
  step("settings-assistant", "node scripts/settings_assistant_test.mjs", { needs: ["pw", "browser"], paths: [file("settings_assistant_test.mjs")] }),
  step("nostr-settings", "node scripts/nostr_settings_test.mjs", { needs: ["pw", "browser"], paths: [file("nostr_settings_test.mjs")] }),
  step("games-mobile", "node scripts/games_mobile_test.mjs", { needs: ["pw", "browser"], paths: [file("games_mobile_test.mjs")] }),
  step("live-translate", "node scripts/live_translate_test.mjs", { needs: ["pw", "browser"], paths: [file("live_translate_test.mjs")] }),
  step("friend-p2p", "node scripts/friend_p2p_test.mjs", { needs: ["pw", "browser"], paths: [file("friend_p2p_test.mjs")] }),
  step("friend-refresh", "node scripts/friend_refresh_test.mjs", { needs: ["pw", "browser"], paths: [file("friend_refresh_test.mjs"), /^accounts\.js$/] }),
  step("communities-instant", "node scripts/communities_instant_test.mjs", { needs: ["pw", "browser"], paths: [file("communities_instant_test.mjs")] }),
  step("routes-instant", "node scripts/routes_instant_test.mjs", { needs: ["pw", "browser"], paths: [file("routes_instant_test.mjs")] }),
  step("profile-by-name", "node scripts/profile_by_name_test.mjs", { needs: ["pw", "browser"], paths: [file("profile_by_name_test.mjs")] }),
  step("communities-rows", "node scripts/communities_rows_test.mjs", { needs: ["pw", "browser"], paths: [file("communities_rows_test.mjs")] }),
  step("friend-privacy", "node scripts/friend_privacy_test.mjs", { needs: ["pw", "browser"], paths: [file("friend_privacy_test.mjs")] }),
  step("foryou-communities", "node scripts/foryou_communities_test.mjs", { needs: ["pw", "browser"], paths: [file("foryou_communities_test.mjs")] }),
  step("device", "node scripts/device_test.js", { paths: [file("device_test.js"), /^device\.js$/, /^device-search\.js$/] }),
  step("people-search", "node scripts/people_search_test.mjs", {
    needs: ["pw", "browser"],
    paths: [file("people_search_test.mjs"), /^app\.js$/, /^device-search\.js$/, /^accounts\.js$/]
  }),
  step("post-menu", "node scripts/post_menu_test.mjs", {
    needs: ["pw", "browser"],
    paths: [file("post_menu_test.mjs"), /^app\.js$/, /^styles\.css$/]
  }),
  step("show-more-scroll", "node scripts/show_more_scroll_test.mjs", {
    needs: ["pw", "browser"],
    paths: [file("show_more_scroll_test.mjs"), /^app\.js$/]
  }),
  step("action-speed", "node scripts/action_speed_test.mjs", {
    needs: ["pw", "browser"],
    paths: [file("action_speed_test.mjs"), file("action_speed_bench.mjs"), /^app\.js$/, /^accounts\.js$/]
  }),
  step("reply-pending", "node scripts/reply_pending_test.mjs", {
    needs: ["pw", "browser"],
    paths: [file("reply_pending_test.mjs"), file("relation_reply_bench.mjs"), /^app\.js$/, /^x-compose\.js$/]
  }),
  step("tab-sync", "node scripts/tab_sync_test.mjs", {
    needs: ["pw", "browser"],
    paths: [file("tab_sync_test.mjs"), file("device_sync_test.js"), /^app\.js$/, /^accounts\.js$/]
  }),
  step("translate", "node scripts/translate_test.js", { paths: [file("translate_test.js")] }),
  step("ondevice-ai", "node scripts/ondevice_ai_test.js", { paths: [file("ondevice_ai_test.js")] }),
  step("dock", "node scripts/dock_test.js", { paths: [file("dock_test.js"), /^dock\.js$/, /^dock\.css$/] }),
  step("for-you", "node scripts/for_you_test.mjs", { paths: [file("for_you_test.mjs"), /^app\.js$/] }),
  step("compose-ai", "node scripts/compose_ai_test.mjs", {
    weight: 50, needs: ["pw", "browser"],
    paths: [file("compose_ai_test.mjs"), ...APP]
  }),
  step("compose-page", "node scripts/compose_page_test.mjs", {
    weight: 180, needs: ["pw", "browser"],
    paths: [
      file("compose_page_test.mjs"), file("community_home_test.mjs"), file("communities_hub_test.mjs"),
      file("own_post_test.mjs"), file("post_page_test.mjs"), file("music_dock_test.mjs"),
      file("video_fallback_test.mjs"), file("device_guard_test.mjs"), file("usernames_settings_test.mjs"),
      file("display_names_test.mjs"), file("settings_assistant_test.mjs"), file("nostr_settings_test.mjs"),
      file("games_mobile_test.mjs"), file("live_translate_test.mjs"), file("friend_p2p_test.mjs"),
      file("communities_instant_test.mjs"), file("routes_instant_test.mjs"), file("profile_by_name_test.mjs"),
      file("communities_rows_test.mjs"), file("friend_privacy_test.mjs"), file("foryou_communities_test.mjs"),
      ...APP
    ]
  }),
  step("ios", "node scripts/ios_webkit_test.mjs", {
    weight: 50, needs: ["pw", "webkit", "server"],
    paths: [file("ios_webkit_test.mjs"), /^shared\/ios\.js$/, ...APP]
  }),
  step("live", "node scripts/live_page_test.mjs", {
    weight: 25, needs: ["pw", "browser"],
    paths: [file("live_page_test.mjs"), ...APP]
  }),
  step("storage-recordings", "node scripts/storage_recordings_test.mjs", {
    paths: [file("storage_recordings_test.mjs"), /^storage-recordings\.js$/, /^shared\/storage-/, /^vendor\/age-/]
  }),
  step("storage-page", "node scripts/storage_page_test.mjs", {
    weight: 45, needs: ["pw", "browser"],
    paths: [file("storage_page_test.mjs"), /^storage-recordings\.js$/, /^drive\.(js|css)$/, /^shared\/storage-/, ...APP]
  })
];

const NAV_STEPS = [
  step("nav-custom", "node scripts/nav_custom_test.js", { paths: [file("nav_custom_test.js"), /^app\.js$/, /^styles\.css$/] }),
  step("bottom-nav", "node scripts/bottom_nav_test.mjs", { weight: 40, paths: [file("bottom_nav_test.mjs"), ...APP] }),
  step("home-reach", "node scripts/home_reach_test.mjs", { weight: 40, needs: ["pw", "browser"], timing: true, paths: [file("home_reach_test.mjs"), file("explore_nav_test.mjs"), file("feed_load_input_test.mjs"), ...APP] }),
  step("profile-tabs-order", "node scripts/profile_tabs_order_test.js", { paths: [file("profile_tabs_order_test.js")] }),
  step("profile-tabs", "node scripts/profile_tabs_test.mjs", { needs: ["pw", "browser"], paths: [file("profile_tabs_test.mjs"), ...APP] }),
  step("dock", "node scripts/dock_test.js", { paths: [file("dock_test.js"), /^dock\.js$/, /^dock\.css$/] }),
  step("landscape", "node scripts/landscape_layout_test.mjs", { weight: 40, needs: ["pw", "browser"], paths: [file("landscape_layout_test.mjs"), ...APP] }),
  step("phone-resize", "node scripts/phone_resize_test.mjs", { needs: ["pw", "browser"], paths: [file("phone_resize_test.mjs"), ...APP] }),
  step("app-repair", "node scripts/app_repair_test.mjs", { needs: ["pw", "browser"], paths: [file("app_repair_test.mjs"), ...APP] }),
  step("swipe-tabs", "node scripts/swipe_tabs_test.mjs", { needs: ["pw", "browser"], paths: [file("swipe_tabs_test.mjs"), ...APP] }),
  step("compact-header", "node scripts/compact_header_test.mjs", { needs: ["pw", "browser"], paths: [file("compact_header_test.mjs"), ...APP] }),
  step("quote-gutter", "node scripts/quote_gutter_test.mjs", { needs: ["pw", "browser"], paths: [file("quote_gutter_test.mjs"), ...APP] }),
  step("zoom-lock", "node scripts/zoom_lock_test.mjs", { needs: ["pw", "browser"], paths: [file("zoom_lock_test.mjs"), ...APP] }),
  step("update-notice", "node scripts/update_notice_test.mjs", { needs: ["pw", "browser"], paths: [file("update_notice_test.mjs"), /^update\.js$/, ...APP] }),
  step("header-stable", "node scripts/header_stable_test.mjs", { needs: ["pw", "browser"], paths: [file("header_stable_test.mjs"), ...APP] }),
  step("post-ring", "node scripts/post_ring_test.mjs", { needs: ["pw", "browser"], paths: [file("post_ring_test.mjs"), /^keys\.(js|css)$/, ...APP] }),
  step("x-icons", "node scripts/x_icons_test.mjs", { needs: ["pw", "browser"], paths: [file("x_icons_test.mjs"), /^gifts-ui\.js$/, ...APP] }),
  step("viktrych", "node scripts/viktrych_test.mjs", { needs: ["pw", "browser"], paths: [file("viktrych_test.mjs"), /^local-ai-ui\.js$/, /^dock\.js$/, ...APP] }),
  step("viktrych-home", "node scripts/viktrych_home_test.mjs", { needs: ["pw", "browser"], paths: [file("viktrych_home_test.mjs"), /^local-ai-ui\.js$/, /^local-ai\.css$/, ...APP] }),
  step("header-frames", "node scripts/header_frames_test.mjs", { needs: ["pw", "browser"], paths: [file("header_frames_test.mjs"), ...APP] }),
  step("tabs-look", "node scripts/tabs_look_test.mjs", { needs: ["pw", "browser"], paths: [file("tabs_look_test.mjs"), ...APP] }),
  step("status-icons", "node scripts/status_icons_test.mjs", { needs: ["pw", "browser"], paths: [file("status_icons_test.mjs"), ...APP] }),
  step("side-panel", "node scripts/side_panel_test.mjs", { needs: ["pw", "browser"], paths: [file("side_panel_test.mjs"), /^split\.js$/, ...APP] }),
  step("site-permissions", "node scripts/site_permissions_test.mjs", { needs: ["pw", "browser"], paths: [file("site_permissions_test.mjs"), /^site-permissions\.js$/, ...APP] }),
  step("article-reader", "node scripts/reader_test.mjs", { weight: 40, needs: ["pw", "browser"], paths: [file("reader_test.mjs"), /^reader\.(js|css)$/, /^shared\/reader-safe\.js$/, ...APP] }),
  step("profile-layout", "node scripts/profile_layout_test.mjs", { needs: ["pw", "browser"], paths: [file("profile_layout_test.mjs"), ...APP] }),
  step("notif-sounds", "node scripts/notif_sounds_test.mjs", { needs: ["pw", "browser"], paths: [file("notif_sounds_test.mjs"), /^notif-sounds\.js$/, ...APP] }),
  step("menu-pages", "node scripts/menu_pages_test.mjs", { weight: 40, needs: ["pw", "browser"], paths: [file("menu_pages_test.mjs"), ...APP] }),
  step("about-layout", "node scripts/about_layout_test.mjs", { needs: ["pw"], paths: [file("about_layout_test.mjs")] }),
  step("points-layout", "node scripts/points_layout_test.mjs", { needs: ["pw"], paths: [file("points_layout_test.mjs")] }),
  step("stories-layout", "node scripts/stories_layout_test.mjs", { needs: ["pw"], paths: [file("stories_layout_test.mjs")] }),
  step("ios", "node scripts/ios_webkit_test.mjs", { weight: 50, needs: ["pw", "webkit", "server"], paths: [file("ios_webkit_test.mjs"), /^shared\/ios\.js$/] })
];

const SHARDS = {
  checks: ["action-bar", "assemble-self", "r2-catalog", "catalog-migrate", "handle-guard", "i18n", "telegram-stories", "stories", "device", "translate", "ondevice-ai", "dock", "for-you", "storage-recordings"],
  site: ["about-layout", "points-layout", "stories-layout", "assemble-site", "smoke-site", "smoke-mirror", "yt-embed", "x-video", "ios", "live"],
  "ui-fast": ["notifications", "pill-fit", "sidebar", "privacy", "title-privacy", "desktop-squares", "storage-page"],
  sw: ["sw-update"],
  "ui-profile": ["profile", "profile-tab-scroll"],
  "ui-drawer": ["drawer"],
  home: ["home-tabs", "tab-member", "reply-lookup", "foryou-chunks", "foryou-off"],
  "compose-core": ["compose-ai", "compose-page"],
  "compose-a": ["community-home", "communities-hub", "own-post", "author-marks", "post-page"],
  "compose-b": ["music-dock", "video-fallback", "ig-media", "source-assign", "device-guard", "usernames", "owner-user-settings"],
  "compose-c": ["display-names", "settings-assistant", "nostr-settings", "games-mobile", "people-search", "post-menu", "show-more-scroll", "action-speed", "reply-pending", "tab-sync"],
  "compose-d": ["live-translate", "friend-p2p", "friend-refresh", "communities-instant", "routes-instant"],
  "compose-e": ["profile-by-name", "communities-rows", "friend-privacy", "foryou-communities"],
  "signup-flows": ["signup-flows"]
};

const NAV_SHARDS = {
  "nav-reach": ["home-reach"],
  "nav-shell": ["nav-custom", "bottom-nav", "dock", "profile-tabs-order", "profile-tabs", "post-ring", "x-icons", "viktrych", "viktrych-home"],
  "nav-layout": ["landscape", "phone-resize", "app-repair", "swipe-tabs", "compact-header", "header-stable", "header-frames", "tabs-look", "status-icons", "side-panel", "site-permissions", "notif-sounds", "quote-gutter", "zoom-lock", "update-notice", "profile-layout", "menu-pages", "article-reader"],
  "nav-pages": ["about-layout", "points-layout", "stories-layout", "ios"]
};

const REQUIRED_PAGE = [
  "action-bar", "assemble-self", "r2-catalog", "catalog-migrate", "handle-guard", "i18n",
  "about-layout", "points-layout", "telegram-stories", "stories", "stories-layout",
  "assemble-site", "smoke-site", "smoke-mirror", "sw-update", "notifications", "profile", "profile-tab-scroll",
  "home-tabs", "tab-member", "reply-lookup", "pill-fit", "drawer", "sidebar", "privacy", "yt-embed", "x-video",
  "signup-flows",
  "device", "translate", "ondevice-ai", "dock", "for-you", "compose-ai", "compose-page", "ios", "live",
  "community-home", "communities-hub", "own-post", "post-page", "music-dock", "video-fallback", "ig-media", "source-assign",
  "device-guard", "usernames", "display-names", "settings-assistant", "nostr-settings", "games-mobile",
  "live-translate", "friend-p2p", "friend-refresh", "communities-instant", "routes-instant", "profile-by-name", "people-search", "post-menu", "show-more-scroll", "action-speed", "reply-pending", "tab-sync",
  "communities-rows", "friend-privacy", "foryou-communities", "foryou-chunks", "author-marks", "foryou-off", "title-privacy", "desktop-squares",
  "storage-recordings", "storage-page"
];

export function stepsFor(suite) {
  return suite === "nav" ? NAV_STEPS : PAGE_STEPS;
}

export function selectChanged(files, steps) {
  if (!files.length) return steps.slice();
  const chosen = new Set();
  for (const fileName of files) {
    const hits = steps.filter((item) => item.paths.some((re) => re.test(fileName)));
    if (!hits.length) return steps.slice();
    hits.forEach((item) => chosen.add(item.id));
  }
  return steps.filter((item) => chosen.has(item.id));
}

export function shardSteps(name, steps) {
  const ids = SHARDS[name] || NAV_SHARDS[name];
  if (!ids) throw new Error("unknown shard " + name);
  const byId = new Map(steps.map((item) => [item.id, item]));
  return ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error("shard " + name + " lists missing step " + id);
    return item;
  });
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function chromeBin() {
  const listed = [process.env.CHROME_PATH, process.env.CHROME_BIN, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const bin of listed) {
    if (!bin) continue;
    if (bin.includes(path.sep) && fs.existsSync(bin)) return bin;
    const found = spawnSync("which", [bin], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error("Chrome is not installed");
}

function runShell(command, env) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: root, env, stdio: "inherit" });
    child.on("close", (code) => resolve(code == null ? 1 : code));
  });
}

async function ensurePlaywright() {
  const pkg = path.join(PW, "node_modules/playwright/package.json");
  if (!fs.existsSync(pkg)) {
    fs.mkdirSync(PW, { recursive: true });
    const code = await runShell("npm install --prefix " + PW + " --no-fund --no-audit playwright@1.56.1", process.env);
    if (code !== 0) throw new Error("playwright install failed");
  }
  if (!fs.existsSync(realCore)) throw new Error("playwright-core is missing");
}

async function ensurePw149() {
  const pkg = path.join(PW149, "node_modules/playwright-core/package.json");
  if (fs.existsSync(pkg)) {
    const version = JSON.parse(fs.readFileSync(pkg, "utf8")).version;
    if (version === "1.49.1") return;
  }
  fs.mkdirSync(PW149, { recursive: true });
  const code = await runShell("npm install --prefix " + PW149 + " --no-fund --no-audit --no-save playwright-core@1.49.1", process.env);
  if (code !== 0) throw new Error("pinned playwright-core install failed");
}

async function ensureWorker() {
  if (fs.existsSync(path.join(root, "worker/node_modules/miniflare"))) return;
  const code = await runShell("npm ci --prefix worker --no-fund --no-audit", process.env);
  if (code !== 0) throw new Error("worker npm ci failed");
}

function startServer() {
  const server = (awaitImportHttp()).createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const filePath = path.normalize(path.join(root, rel));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, origin: "http://127.0.0.1:" + server.address().port });
    });
  });
}

import http from "node:http";
function awaitImportHttp() { return http; }

async function startChrome() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-chrome-"));
  const chrome = spawn(chromeBin(), [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--remote-allow-origins=*",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + dir,
    "about:blank"
  ], { stdio: "ignore" });
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/json/version");
      if (res.ok) { ready = true; break; }
    } catch (err) { /* chrome is still starting */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) {
    try { chrome.kill("SIGKILL"); } catch (err) { /* already gone */ }
    throw new Error("shared Chrome did not open a debugger");
  }
  return { chrome, dir, cdp: "http://127.0.0.1:" + port };
}

function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]);
    }
  });
  return Promise.all(workers).then(() => out);
}

function changedFiles() {
  const base = process.env.SMOKE_BASE || "origin/main";
  const committed = spawnSync("git", ["diff", "--name-only", base + "...HEAD"], { cwd: root, encoding: "utf8" });
  const worktree = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: root, encoding: "utf8" });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  const names = new Set();
  for (const out of [committed.stdout, worktree.stdout, untracked.stdout]) {
    for (const line of String(out || "").split("\n")) {
      if (line.trim()) names.add(line.trim());
    }
  }
  return [...names];
}

function selftest() {
  const ids = new Set(PAGE_STEPS.map((item) => item.id));
  for (const id of REQUIRED_PAGE) {
    if (!ids.has(id)) throw new Error("missing page step " + id);
  }
  const sharded = new Set(Object.values(SHARDS).flat());
  for (const id of REQUIRED_PAGE) {
    if (!sharded.has(id)) throw new Error("step is not in a shard " + id);
  }
  if (sharded.size !== REQUIRED_PAGE.length) throw new Error("a shard lists a step twice or an extra step");
  for (const name of Object.keys(NAV_SHARDS)) shardSteps(name, NAV_STEPS);
  const narrow = selectChanged(["scripts/pill_fit_test.mjs"], PAGE_STEPS).map((item) => item.id);
  if (!narrow.includes("pill-fit")) throw new Error("changed mode missed pill-fit");
  if (narrow.includes("signup")) throw new Error("changed mode pulled signup for a pill test");
  const full = selectChanged(["some/new-file.dat"], PAGE_STEPS);
  if (full.length !== PAGE_STEPS.length) throw new Error("an unmapped file must run the full suite");
  const none = selectChanged([], PAGE_STEPS);
  if (none.length !== PAGE_STEPS.length) throw new Error("no local diff must run the full suite");
  for (const name of Object.keys(SHARDS)) shardSteps(name, PAGE_STEPS);
  const navIds = new Set(NAV_STEPS.map((item) => item.id));
  for (const id of ["nav-custom", "bottom-nav", "home-reach", "profile-tabs-order", "profile-tabs", "dock", "landscape", "phone-resize", "app-repair", "swipe-tabs", "compact-header", "header-stable", "header-frames", "tabs-look", "status-icons", "side-panel", "site-permissions", "notif-sounds", "quote-gutter", "zoom-lock", "update-notice", "profile-layout", "menu-pages", "about-layout", "points-layout", "stories-layout", "ios", "article-reader"]) {
    if (!navIds.has(id)) throw new Error("missing nav step " + id);
  }
  console.log("smoke_run selftest ok");
}

async function main() {
  if (process.argv.includes("--selftest")) {
    selftest();
    return;
  }
  const suite = arg("--suite", "page");
  const shard = arg("--shard", "");
  const jobsFlag = arg("--jobs", "");
  const jobs = jobsFlag ? Number(jobsFlag) : (shard ? 1 : 3);
  let steps = stepsFor(suite);
  if (shard) steps = shardSteps(shard, steps);
  if (process.argv.includes("--changed")) {
    if (shard) throw new Error("--changed is local; CI passes --shard and runs the whole shard");
    const files = changedFiles();
    console.log("changed files: " + (files.length ? files.join(", ") : "(none)"));
    steps = selectChanged(files, steps);
  }
  if (process.argv.includes("--list")) {
    steps.forEach((item) => console.log(item.id));
    return;
  }
  const needs = new Set(steps.flatMap((item) => item.needs));
  if (needs.has("pw") || needs.has("webkit")) await ensurePlaywright();
  if (needs.has("webkit")) {
    // Install Playwright's WebKit packages, except gstreamer1.0-libav.
    // That one package pulls the ffmpeg codec stack and can spend the whole
    // 15 minute job downloading it. The iOS check does not play video.
    // Host validation stays on, so a library that is still missing fails
    // immediately instead of leaving MiniBrowser running until the job dies.
    delete process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS;
    const apt = await runShell([
      "set -euo pipefail",
      "cd " + PW,
      "npx playwright install webkit",
      "line=$(npx playwright install-deps webkit --dry-run)",
      "pkgs=$(printf '%s\\n' \"$line\" | sed -E 's/.*--no-install-recommends //; s/\"$//' | tr ' ' '\\n' | grep -vx 'gstreamer1.0-libav' | tr '\\n' ' ')",
      "test -n \"${pkgs// /}\"",
      "printf '%s\\n' \"$pkgs\" | tr ' ' '\\n' | grep -qx 'gstreamer1.0-libav' && exit 1",
      "echo \"webkit packages: $pkgs\"",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $pkgs"
    ].join("\n"), process.env);
    if (apt !== 0) throw new Error("webkit libraries failed to install");
  }
  if (needs.has("pw149")) await ensurePw149();
  if (needs.has("worker")) await ensureWorker();
  const before = steps.filter((item) => item.phase === "before");
  const parallel = steps.filter((item) => item.phase !== "before");
  if (parallel.some((item) => item.needs.includes("built")) && !before.some((item) => item.id === "assemble-site")) {
    before.unshift(PAGE_STEPS.find((item) => item.id === "assemble-site"));
  }
  for (const item of before) {
    console.log("START " + item.id);
    const code = await runShell(item.run, process.env);
    console.log((code === 0 ? "OK " : "FAIL ") + item.id);
    if (code !== 0) process.exit(1);
  }
  steps = parallel;

  let origin = "";
  let server = null;
  const wantServer = steps.some((item) => item.needs.includes("browser") || item.needs.includes("server"));
  if (wantServer) {
    const served = await startServer();
    server = served.server;
    origin = served.origin;
    console.log("static server " + origin);
  }
  // Each script launches its own Chrome. Sharing one browser across scripts
  // made timing checks fail. A shard that runs one script still has one browser.
  const env = {
    ...process.env,
    SMOKE_ORIGIN: origin,
    SMOKE_CDP: "",
    SMOKE_RUNNER: "1",
    SMOKE_PLAYWRIGHT_CORE: realCore,
    PLAYWRIGHT_CORE: wrapper
  };
  const limit = shard || suite === "nav" ? 1 : (jobs > 0 ? jobs : 1);
  const started = Date.now();
  let failed = 0;
  const runOne = async (item) => {
    const t0 = Date.now();
    console.log("START " + item.id);
    const code = await new Promise((resolve) => {
      const child = spawn("bash", ["-c", item.run], { cwd: root, env, stdio: "inherit" });
      child.on("close", (status) => resolve(status == null ? 1 : status));
    });
    console.log((code === 0 ? "OK " : "FAIL ") + item.id + " " + Math.round((Date.now() - t0) / 1000) + "s");
    return code;
  };
  try {
    // Every CI shard runs one script at a time. A timing check also waits
    // until the other scripts in that run have finished.
    const timingJob = steps.some((item) => item.timing);
    const runLimit = (shard || suite === "nav" || timingJob) ? 1 : limit;
    const rest = steps.filter((item) => !item.timing).sort((a, b) => b.weight - a.weight);
    const timing = steps.filter((item) => item.timing);
    const results = [];
    if (rest.length) results.push(...await pool(rest, runLimit, runOne));
    for (const item of timing) results.push(await runOne(item));
    failed = results.filter((code) => code !== 0).length;
  } finally {
    if (server) server.close();
  }
  console.log("smoke-all " + (failed ? "failed " + failed : "ok") + " " + Math.round((Date.now() - started) / 1000) + "s");
  if (failed) process.exit(1);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
