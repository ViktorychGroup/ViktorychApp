# Third-party art

The full per-asset audit, with a verdict on what may be sold, is in `docs/GIFTS-LICENSES.md`.

## Gift art (Gifts page, `shared/gift-catalog.js`)

Most gifts use original illustrations made for this project in
`icons/gifts/<gift id>.webp` (256 px WebP, listed in `LOCAL_ART` in
`shared/gift-catalog.js`). They were generated with an image model, have no
third-party license or attribution requirement, and copy no VK artwork, logos
or trademarks.

Gifts without an illustration yet draw from Google's Noto Emoji. Those images
are hotlinked, not copied into this repository, and are shown unmodified.
Nothing on the Gifts page reuses VK's gift artwork.

| Use | Source | License |
|-----|--------|---------|
| Shelf, grid, history and post tiles (static PNG, 512 px) | Noto Emoji v2.047, `png/512/` via jsDelivr: `https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/png/512/emoji_u<codepoint>.png` | Apache License 2.0. Copyright 2013 Google LLC. https://github.com/googlefonts/noto-emoji (README, "License": image resources are Apache 2.0) |
| Send sheet preview (animated WebP, 512 px), where the emoji is animated | Noto Animated Emoji from Google Fonts: `https://fonts.gstatic.com/s/e/notoemoji/latest/<codepoint>/512.webp` | Creative Commons Attribution 4.0 International (CC BY 4.0), Google LLC. https://googlefonts.github.io/noto-emoji-files/ and https://creativecommons.org/licenses/by/4.0/ |

If an image fails to load, the page falls back from the illustration or the
animated emoji to the static Noto PNG, then
to the device's own emoji character.

The page footer carries a short attribution line, and this file holds the full
notice.

## Wordmark font (personal sidebar logo text, `fonts/`)

Custom sidebar logo text is set in Inter, the same font the ViktorychApp
wordmark is drawn from. `fonts/inter-400.woff2` and `fonts/inter-900.woff2`
are subsets (Latin, Latin Extended, Cyrillic, Greek, Vietnamese) of Inter 4.1
Regular and Black from https://github.com/rsms/inter, made with fontTools
`pyftsubset`. Inter is licensed under the SIL Open Font License 1.1,
Copyright (c) 2016 The Inter Project Authors; the full license is in
`fonts/Inter-LICENSE.txt`.

## Emoji picker data

`data/emoji.json` lists emoji and their English names from the Unicode emoji test data (emoji-test.txt), used under the Unicode License (https://www.unicode.org/license.txt). The characters are what is stored, copied, and read by a screen reader.

When the device font cannot draw a sequence (a joined family or profession, a skin tone, a flag, a keycap, or a variation selector), the page uses Noto Color Emoji from `@fontsource/noto-color-emoji` 5.2.8 (`noto-color-emoji-emoji-400-normal.woff2`, about 5.5 MB, SIL Open Font License 1.1). The file is not in this repository. The browser requests it from jsDelivr only after that miss, then keeps its own copy. The face is whatever repertoire that package contains. Emoji added after it stay on the device font, which may leave a gap. Discord custom emoji and gift art are unchanged. A device that asks for less data keeps the system glyphs only.
