/* Store prices for gifts and sticker packs. Shared by the Worker and the app.
   Every item can be paid two separate ways:
   - money, through the payment adapter (off until the owner adds keys), by tier;
   - Viktorychs, the free points earned by real activity. Viktorychs are never sold.
   Money is only taken for our own art (icons/gifts/*.webp). */

import { GIFTS, LOCAL_ART } from "./gift-catalog.js";

export const CURRENCY = "eur";
/* Money price per tier, in cents. Free items cannot be bought with money. */
export const TIERS = {
  free: { cents: 0 },
  small: { cents: 99 },
  medium: { cents: 299 },
  premium: { cents: 699 }
};
export const TIER_ORDER = ["free", "small", "medium", "premium"];
/* Original art that counts as premium, whatever its Viktorych price. */
export const PREMIUM_ART = ["crown", "comet", "gem", "ring", "unicorn", "lion", "trophy", "rocket", "crystal_ball", "magic_wand", "bouquet", "xmas_tree"];
export const REFUND_DAYS = 14;

/* Marks a display name as a translation key; the UI translates it when it renders. */
const t = (key) => key;

/* Limited editions: a fixed number of copies, numbered in order of purchase.
   base is the art they reuse. viktorychs 0 means money only. */
export const LIMITED = [
  { id: "crown_founders", base: "crown", name: t("Founders’ crown"), tier: "premium", viktorychs: 0, limit: 500, until: "" },
  { id: "pumpkin_2026", base: "pumpkin", name: t("Halloween 2026 pumpkin"), tier: "small", viktorychs: 60, limit: 1000, until: "2026-11-08" },
  { id: "unicorn_gold", base: "unicorn", name: t("Golden unicorn"), tier: "premium", viktorychs: 900, limit: 250, until: "" }
];

/* Sticker packs. Each sticker is one piece of our own art. */
export const STICKER_PACKS = [
  { id: "starter", name: t("Starter stickers"), tier: "free", viktorychs: 0, items: ["thanks", "hug", "cat_smile", "two_hearts", "heart_eyes", "party_popper"] },
  { id: "critters", name: t("Cute critters"), tier: "small", viktorychs: 80, items: ["fox", "hedgehog", "otter", "sloth", "panda", "penguin", "koala", "hamster", "chipmunk", "seal", "frog", "turtle"] },
  { id: "love", name: t("Love notes"), tier: "small", viktorychs: 80, items: ["heart", "kiss", "rose", "love_letter", "gift_heart", "blow_kiss", "cupid", "beating_heart", "sparkling_heart", "cat_love"] },
  { id: "spooky", name: t("Spooky night"), tier: "small", viktorychs: 60, items: ["pumpkin", "ghost", "bat", "black_cat", "skull", "spider", "witch_broom", "zombie", "vampire", "imp", "alien_monster", "web"] },
  { id: "party", name: t("Party time"), tier: "medium", viktorychs: 150, items: ["party_popper", "balloon", "cake", "candle", "spark", "star", "present", "doughnut", "lollipop", "hot_drink"] },
  { id: "royal", name: t("Royal treasures"), tier: "premium", viktorychs: 400, items: ["crown", "gem", "ring", "trophy", "rocket", "comet", "unicorn", "lion", "crystal_ball", "magic_wand"] }
];

/* Status emojis: special emojis for the custom status on your avatar.
   Viktorychs only (they are Unicode emoji, not our own art, so no money price).
   Any other emoji stays free to use as a status. */
export const STATUS_EMOJIS = [
  { id: "flame", emoji: "🔥", name: t("Flame status"), tier: "small", viktorychs: 20, popular: true },
  { id: "party", emoji: "🎉", name: t("Party status"), tier: "small", viktorychs: 25, popular: true },
  { id: "rainbow", emoji: "🌈", name: t("Rainbow status"), tier: "medium", viktorychs: 35, fresh: true },
  { id: "rocket", emoji: "🚀", name: t("Rocket status"), tier: "medium", viktorychs: 40, popular: true },
  { id: "dragon", emoji: "🐉", name: t("Dragon status"), tier: "medium", viktorychs: 60, fresh: true },
  { id: "gem", emoji: "💎", name: t("Gem status"), tier: "premium", viktorychs: 80, popular: true },
  { id: "unicorn", emoji: "🦄", name: t("Unicorn status"), tier: "premium", viktorychs: 100, fresh: true },
  { id: "regal", emoji: "👑", name: t("Crown status"), tier: "premium", viktorychs: 120, popular: true }
];

const LOCAL = new Set(LOCAL_ART);
const PREMIUM = new Set(PREMIUM_ART);

export function giftTier(gift) {
  if (!gift) return "free";
  const price = Number(gift.price) || 0;
  if (PREMIUM.has(gift.id)) return "premium";
  if (price === 0) return "free";
  if (price >= 100) return "premium";
  if (price >= 25) return "medium";
  return "small";
}

function day(when) {
  return new Date(when == null ? Date.now() : when).toISOString().slice(0, 10);
}

export function limitedOpen(item, when) {
  return !!item && (!item.until || day(when) <= item.until);
}

/* One price card for any item: { kind, id, tier, cents, viktorychs, limit, base, name }.
   cents 0 means no money price, viktorychs 0 means no Viktorych price (unless the tier is free). */
export function storeItem(kind, id) {
  const key = String(id || "");
  if (kind === "stickers") {
    const pack = STICKER_PACKS.find((item) => item.id === key);
    if (!pack) return null;
    return { kind: "stickers", id: pack.id, tier: pack.tier, cents: TIERS[pack.tier].cents, viktorychs: pack.viktorychs, limit: 0, base: pack.items[0], name: pack.name, items: pack.items.slice() };
  }
  if (kind === "emoji") {
    const status = statusEmojiById(key);
    if (!status) return null;
    return { kind: "emoji", id: status.id, tier: status.tier, cents: 0, viktorychs: status.viktorychs, limit: 0, base: "", name: status.name, emoji: status.emoji };
  }
  if (kind !== "gift") return null;
  const limited = LIMITED.find((item) => item.id === key);
  if (limited) return { kind: "gift", id: limited.id, tier: limited.tier, cents: TIERS[limited.tier].cents, viktorychs: limited.viktorychs, limit: limited.limit, until: limited.until, base: limited.base, name: limited.name };
  const gift = GIFTS.find((item) => item.id === key);
  if (!gift) return null;
  const tier = giftTier(gift);
  /* Money is only taken for our own art. Gifts still drawn from Noto Emoji
     stay Viktorych-only until they get original art (see docs/GIFTS-LICENSES.md). */
  return { kind: "gift", id: gift.id, tier: tier, cents: LOCAL.has(gift.id) ? TIERS[tier].cents : 0, viktorychs: Number(gift.price) || 0, limit: 0, base: LOCAL.has(gift.id) ? gift.id : "", name: gift.name, cp: gift.cp };
}

export function limitedById(id) {
  return LIMITED.find((item) => item.id === String(id || "")) || null;
}

export function statusEmojiById(id) {
  return STATUS_EMOJIS.find((item) => item.id === String(id || "")) || null;
}

/* Strips the variation selector so "👑" and "👑\uFE0F" match the same entry. */
export function statusEmojiByChar(value) {
  const text = String(value || "").replace(/\uFE0F/g, "").trim();
  if (!text) return null;
  return STATUS_EMOJIS.find((item) => item.emoji.replace(/\uFE0F/g, "") === text) || null;
}

/* Entitlement key for an owned status emoji (shares store_entitlements with sticker packs). */
export function emojiEntitlement(id) {
  return "emoji:" + String(id || "");
}

export function stickerPack(id) {
  return STICKER_PACKS.find((item) => item.id === String(id || "")) || null;
}

/* Sticker tokens in text look like [[sticker:pack/item]]. */
export const STICKER_RE = /\[\[sticker:([a-z0-9_]{1,24})\/([a-z0-9_]{1,32})\]\]/g;

export function stickerToken(pack, item) {
  return "[[sticker:" + pack + "/" + item + "]]";
}

export function validSticker(pack, item) {
  const found = stickerPack(pack);
  return !!(found && found.items.indexOf(item) >= 0 && LOCAL.has(item));
}

const api = { CURRENCY, TIERS, TIER_ORDER, PREMIUM_ART, REFUND_DAYS, LIMITED, STICKER_PACKS, STATUS_EMOJIS, statusEmojiById, statusEmojiByChar, emojiEntitlement, giftTier, limitedOpen, storeItem, limitedById, stickerPack, STICKER_RE, stickerToken, validSticker };
globalThis.StoreCatalog = api;
try { globalThis.dispatchEvent && globalThis.dispatchEvent(new Event("storecatalog")); } catch (err) { /* workers have no events here */ }
