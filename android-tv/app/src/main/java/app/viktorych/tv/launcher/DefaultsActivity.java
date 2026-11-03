package app.viktorych.tv.launcher;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import app.viktorych.tv.R;
import app.viktorych.tv.files.FilesDefaults;
import app.viktorych.tv.ime.KeyboardDefaults;
import app.viktorych.tv.player.MediaDefaults;
import app.viktorych.tv.search.SearchDefaults;

/** "Make ViktorychTV your default": one row per TV job, each with a Set
 *  button that opens Android's own picker. Nothing changes until the user
 *  confirms there. Opened from the site (viktorychtv://defaults) and from
 *  the launcher's settings panel. Laid out like Google TV's settings: list
 *  on the left, details on the right. */
public class DefaultsActivity extends Activity {
    private static final int REQ_HOME = 41;

    private LinearLayout list;
    private FrameLayout side;
    private boolean guideFor;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Coming back from the TV's settings: stay on the row that sent us there.
        int keep = list == null || list.getFocusedChild() == null ? -1 : list.indexOfChild(list.getFocusedChild()) - 2;
        render();
        if (keep > 0) focusRow(keep);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_HOME && !Defaults.isDefaultHome(this)) {
            // The system picker was closed without choosing us: show the guide.
            guideFor = true;
        }
        render();
    }

    private int d(float v) { return Ui.dp(this, v); }

    private void render() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Ui.BG);
        side = new FrameLayout(this);
        side.setBackgroundColor(0xFF1C1E22);
        root.addView(side, new FrameLayout.LayoutParams(d(400), -1, Gravity.END));

        ScrollView sv = new ScrollView(this);
        sv.setVerticalScrollBarEnabled(false);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(d(80), d(56), d(40), d(40));
        sv.addView(list);
        root.addView(sv, new FrameLayout.LayoutParams(d(560), -1, Gravity.START));

        TextView title = Ui.text(this, getString(R.string.def_title), 28, Ui.TEXT, Ui.REGULAR);
        title.setSingleLine(false);
        list.addView(title);
        TextView sub = Ui.text(this, getString(R.string.def_sub), 13, Ui.TEXT_DIM, Ui.REGULAR);
        sub.setSingleLine(false);
        sub.setLineSpacing(0, 1.2f);
        LinearLayout.LayoutParams sl = new LinearLayout.LayoutParams(-1, -2);
        sl.topMargin = d(10); sl.bottomMargin = d(22);
        list.addView(sub, sl);

        boolean on = Defaults.isDefaultHome(this);
        boolean pending = !on && Defaults.homeEnabled(this);
        View home = row(R.drawable.lx_home, getString(R.string.def_home),
            getString(on ? R.string.def_on : pending ? R.string.def_pending : R.string.def_off), on);
        home.setOnClickListener(v -> {
            if (Defaults.isDefaultHome(this)) { showHomeDetails(true); return; }
            if (!Defaults.askForHome(this, REQ_HOME)) { guideFor = true; render(); }
        });
        home.setOnFocusChangeListener((v, f) -> { if (f) showHomeDetails(Defaults.isDefaultHome(this)); });
        list.addView(home);

        // Video and music links (player/PlayerActivity).
        boolean playerOn = MediaDefaults.enabled(this, MediaDefaults.player(this));
        // The row says On or Off; how to finish picking it is in the side panel.
        View player = row(R.drawable.mp_play_circle, getString(R.string.def_player),
            getString(playerOn ? R.string.def_on : R.string.def_off), playerOn);
        player.setOnClickListener(v -> {
            MediaDefaults.enable(this, MediaDefaults.player(this), true);
            guideFor = false;
            render();
            focusRow(1);
        });
        player.setOnFocusChangeListener((v, f) -> { if (f) showPlayerDetails(); });
        list.addView(player, gap());

        // Screensaver (player/FeedDream).
        boolean dreamOn = MediaDefaults.enabled(this, MediaDefaults.dream(this));
        View dream = row(R.drawable.mp_slideshow, getString(R.string.def_dream),
            getString(dreamOn ? R.string.def_on : R.string.def_off), dreamOn);
        dream.setOnClickListener(v -> {
            MediaDefaults.enable(this, MediaDefaults.dream(this), true);
            if (!MediaDefaults.openDreamSettings(this)) { render(); focusRow(2); }
        });
        dream.setOnFocusChangeListener((v, f) -> { if (f) showDreamDetails(); });
        list.addView(dream, gap());

        // Remote keyboard (ime/TvKeyboard).
        boolean kbOn = KeyboardDefaults.enabled(this);
        View keyboard = row(R.drawable.kb_keyboard, getString(R.string.def_keyboard),
            getString(kbOn ? R.string.def_on : R.string.def_off), kbOn);
        keyboard.setOnClickListener(v -> {
            KeyboardDefaults.enable(this, true);
            KeyboardDefaults.nextStep(this);
            render();
            focusRow(3);
        });
        keyboard.setOnFocusChangeListener((v, f) -> { if (f) showKeyboardDetails(); });
        list.addView(keyboard, gap());

        // Feed search (search/).
        boolean searchOn = SearchDefaults.enabled(this);
        View search = row(R.drawable.kb_find, getString(R.string.def_search),
            getString(searchOn ? R.string.def_on : R.string.def_off), searchOn);
        search.setOnClickListener(v -> {
            boolean was = SearchDefaults.enabled(this);
            SearchDefaults.enable(this, true);
            if (was) SearchDefaults.open(this);
            else { render(); focusRow(4); }
        });
        search.setOnFocusChangeListener((v, f) -> { if (f) showSearchDetails(); });
        list.addView(search, gap());

        // Photos (files/GalleryActivity, PhotoActivity).
        boolean photosOn = FilesDefaults.photosEnabled(this);
        View photos = row(R.drawable.fl_photos, getString(R.string.def_photos),
            getString(photosOn ? R.string.def_on : R.string.def_off), photosOn);
        photos.setOnClickListener(v -> {
            boolean was = FilesDefaults.photosEnabled(this);
            FilesDefaults.enablePhotos(this, true);
            if (was) FilesDefaults.openPhotos(this);
            else { render(); focusRow(5); }
        });
        photos.setOnFocusChangeListener((v, f) -> { if (f) showPhotosDetails(); });
        list.addView(photos, gap());

        // Files (files/FilesActivity).
        boolean filesOn = FilesDefaults.filesEnabled(this);
        View files = row(R.drawable.fl_files, getString(R.string.def_files),
            getString(filesOn ? R.string.def_on : R.string.def_off), filesOn);
        files.setOnClickListener(v -> {
            boolean was = FilesDefaults.filesEnabled(this);
            FilesDefaults.enableFiles(this, true);
            if (was) FilesDefaults.openFiles(this);
            else { render(); focusRow(6); }
        });
        files.setOnFocusChangeListener((v, f) -> { if (f) showFilesDetails(); });
        list.addView(files, gap());

        setContentView(root);
        if (guideFor) showGuide(); else showHomeDetails(on);
        String want = getIntent() == null ? null : getIntent().getStringExtra("focus");
        if ("dream".equals(want)) { dream.requestFocus(); getIntent().removeExtra("focus"); }
        else if ("player".equals(want)) { player.requestFocus(); getIntent().removeExtra("focus"); }
        else if ("keyboard".equals(want)) { keyboard.requestFocus(); getIntent().removeExtra("focus"); }
        else if ("search".equals(want)) { search.requestFocus(); getIntent().removeExtra("focus"); }
        else if ("photos".equals(want)) { photos.requestFocus(); getIntent().removeExtra("focus"); }
        else if ("files".equals(want)) { files.requestFocus(); getIntent().removeExtra("focus"); }
        else home.requestFocus();
    }

    private LinearLayout.LayoutParams gap() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, d(72));
        lp.topMargin = d(8);
        return lp;
    }

    /** Rows sit after the title and the subtitle. */
    private void focusRow(int i) {
        View v = list.getChildAt(2 + i);
        if (v != null) v.requestFocus();
    }

    private void showPlayerDetails() {
        side.removeAllViews();
        LinearLayout col = sideColumn();
        col.addView(Ui.icon(this, R.drawable.mp_play_circle, 40, Ui.TEXT), new LinearLayout.LayoutParams(d(40), d(40)));
        addSideText(col, getString(R.string.def_player), 20, Ui.TEXT, 16);
        addSideText(col, getString(R.string.def_player_desc), 13, Ui.TEXT_DIM, 10);
        if (MediaDefaults.enabled(this, MediaDefaults.player(this))) {
            if (!MediaDefaults.isDefaultPlayer(this)) addSideText(col, getString(R.string.def_player_pending), 13, 0xFF8AB4F8, 14);
            sideButton(col, getString(R.string.def_player_off), () -> {
                MediaDefaults.enable(this, MediaDefaults.player(this), false);
                render();
                focusRow(1);
            });
        }
        side.addView(col);
    }

    private void showDreamDetails() {
        side.removeAllViews();
        LinearLayout col = sideColumn();
        col.addView(Ui.icon(this, R.drawable.mp_slideshow, 40, Ui.TEXT), new LinearLayout.LayoutParams(d(40), d(40)));
        addSideText(col, getString(R.string.def_dream), 20, Ui.TEXT, 16);
        addSideText(col, getString(R.string.def_dream_desc), 13, Ui.TEXT_DIM, 10);
        int n = MediaDefaults.savedCount(this);
        if (n > 0) addSideText(col, getResources().getQuantityString(R.plurals.def_dream_items, n, n), 13, 0xFF81C995, 10);
        if (MediaDefaults.enabled(this, MediaDefaults.dream(this))) {
            if (!MediaDefaults.isDefaultDream(this)) {
                addSideText(col, getString(R.string.def_dream_pending), 13, 0xFF8AB4F8, 14);
                addSideText(col, getString(R.string.def_dream_guide), 12, Ui.TEXT_DIM, 8);
            }
            sideButton(col, getString(R.string.def_dream_open), () -> MediaDefaults.openDreamSettings(this));
            sideButton(col, getString(R.string.def_dream_off), () -> {
                MediaDefaults.enable(this, MediaDefaults.dream(this), false);
                render();
                focusRow(2);
            });
        }
        side.addView(col);
    }

    private void showKeyboardDetails() {
        side.removeAllViews();
        LinearLayout col = sideColumn();
        col.addView(Ui.icon(this, R.drawable.kb_keyboard, 40, Ui.TEXT), new LinearLayout.LayoutParams(d(40), d(40)));
        addSideText(col, getString(R.string.def_keyboard), 20, Ui.TEXT, 16);
        addSideText(col, getString(R.string.def_keyboard_desc), 13, Ui.TEXT_DIM, 10);
        if (KeyboardDefaults.enabled(this)) {
            if (!KeyboardDefaults.allowedBySystem(this)) {
                addSideText(col, getString(R.string.def_keyboard_allow), 13, 0xFF8AB4F8, 14);
            } else if (!KeyboardDefaults.isDefault(this)) {
                addSideText(col, getString(R.string.def_keyboard_pick), 13, 0xFF8AB4F8, 14);
            }
            if (!KeyboardDefaults.isDefault(this)) sideButton(col, getString(R.string.def_keyboard_next), () -> KeyboardDefaults.nextStep(this));
            sideButton(col, getString(R.string.def_keyboard_settings), () -> KeyboardDefaults.openKeyboardSettings(this));
            sideButton(col, getString(R.string.def_keyboard_off), () -> {
                if (KeyboardDefaults.isDefault(this)) KeyboardDefaults.showPicker(this);
                KeyboardDefaults.enable(this, false);
                render();
                focusRow(3);
            });
        }
        side.addView(col);
    }

    private void showSearchDetails() {
        side.removeAllViews();
        LinearLayout col = sideColumn();
        col.addView(Ui.icon(this, R.drawable.kb_find, 40, Ui.TEXT), new LinearLayout.LayoutParams(d(40), d(40)));
        addSideText(col, getString(R.string.def_search), 20, Ui.TEXT, 16);
        addSideText(col, getString(R.string.def_search_desc), 13, Ui.TEXT_DIM, 10);
        if (SearchDefaults.enabled(this)) {
            sideButton(col, getString(R.string.def_search_try), () -> SearchDefaults.open(this));
            sideButton(col, getString(R.string.def_search_off), () -> {
                SearchDefaults.enable(this, false);
                render();
                focusRow(4);
            });
        }
        side.addView(col);
    }

    private void showPhotosDetails() {
        side.removeAllViews();
        LinearLayout col = sideColumn();
        col.addView(Ui.icon(this, R.drawable.fl_photos, 40, Ui.TEXT), new LinearLayout.LayoutParams(d(40), d(40)));
        addSideText(col, getString(R.string.def_photos), 20, Ui.TEXT, 16);
        addSideText(col, getString(R.string.def_photos_desc), 13, Ui.TEXT_DIM, 10);
        if (FilesDefaults.photosEnabled(this)) {
            if (!FilesDefaults.isDefaultPhotos(this)) addSideText(col, getString(R.string.def_photos_pending), 13, 0xFF8AB4F8, 14);
            sideButton(col, getString(R.string.def_photos_open), () -> FilesDefaults.openPhotos(this));
            sideButton(col, getString(R.string.def_photos_off), () -> {
                FilesDefaults.enablePhotos(this, false);
                render();
                focusRow(5);
            });
        }
        side.addView(col);
    }

    private void showFilesDetails() {
        side.removeAllViews();
        LinearLayout col = sideColumn();
        col.addView(Ui.icon(this, R.drawable.fl_files, 40, Ui.TEXT), new LinearLayout.LayoutParams(d(40), d(40)));
        addSideText(col, getString(R.string.def_files), 20, Ui.TEXT, 16);
        addSideText(col, getString(R.string.def_files_desc), 13, Ui.TEXT_DIM, 10);
        if (FilesDefaults.filesEnabled(this)) {
            sideButton(col, getString(R.string.def_files_open), () -> FilesDefaults.openFiles(this));
            sideButton(col, getString(R.string.def_files_off), () -> {
                FilesDefaults.enableFiles(this, false);
                render();
                focusRow(6);
            });
        }
        side.addView(col);
    }

    private void sideButton(LinearLayout col, String label, Runnable r) {
        TextView b = Ui.pill(this, label, false);
        b.setBackground(Ui.focusBg(Ui.round(Ui.FOCUS, d(20)), Ui.round(0xFF3C4043, d(20))));
        b.setOnClickListener(v -> r.run());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, d(40));
        lp.topMargin = d(16);
        col.addView(b, lp);
    }

    private View row(int icon, String label, String status, boolean on) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setFocusable(true);
        r.setPadding(d(14), 0, d(16), 0);
        r.setBackground(Ui.focusBg(Ui.round(0xFFE8EAED, d(14)), Ui.round(0x00000000, d(14))));
        FrameLayout circle = new FrameLayout(this);
        circle.setBackground(Ui.oval(0xFF2B2E33));
        ImageView iv = Ui.icon(this, icon, 20, Ui.TEXT);
        FrameLayout.LayoutParams il = new FrameLayout.LayoutParams(d(20), d(20), Gravity.CENTER);
        circle.addView(iv, il);
        r.addView(circle, new LinearLayout.LayoutParams(d(40), d(40)));
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView t = Ui.text(this, label, 16, Ui.TEXT, Ui.REGULAR);
        TextView s = Ui.text(this, status, 13, on ? 0xFF81C995 : Ui.TEXT_DIM, Ui.REGULAR);
        s.setPadding(0, d(4), 0, 0);
        texts.addView(t);
        texts.addView(s);
        LinearLayout.LayoutParams tl = new LinearLayout.LayoutParams(0, -2, 1f);
        tl.leftMargin = d(16);
        r.addView(texts, tl);
        TextView set = Ui.text(this, getString(on ? R.string.def_change : R.string.def_set), 14, Ui.TEXT, Ui.MEDIUM);
        set.setGravity(Gravity.CENTER);
        set.setPadding(d(16), 0, d(16), 0);
        set.setBackground(Ui.round(0xFF3C4043, d(16)));
        r.addView(set, new LinearLayout.LayoutParams(-2, d(32)));
        r.setOnFocusChangeListener(null);
        r.getViewTreeObserver().addOnGlobalFocusChangeListener((o, n) -> {
            boolean f = n == r;
            t.setTextColor(f ? Ui.TEXT_ON_LIGHT : Ui.TEXT);
            iv.setColorFilter(Ui.TEXT);
            set.setTextColor(f ? 0xFFFFFFFF : Ui.TEXT);
            set.setBackground(Ui.round(f ? Ui.ACCENT : 0xFF3C4043, d(16)));
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, d(72));
        r.setLayoutParams(lp);
        return r;
    }

    private void showHomeDetails(boolean on) {
        side.removeAllViews();
        LinearLayout col = sideColumn();
        ImageView big = Ui.icon(this, R.drawable.lx_home, 40, Ui.TEXT);
        col.addView(big, new LinearLayout.LayoutParams(d(40), d(40)));
        addSideText(col, getString(R.string.def_home), 20, Ui.TEXT, 16);
        addSideText(col, getString(R.string.def_home_desc), 13, Ui.TEXT_DIM, 10);
        if (on || Defaults.homeEnabled(this)) {
            TextView off = Ui.pill(this, getString(R.string.def_turn_off), false);
            off.setBackground(Ui.focusBg(Ui.round(Ui.FOCUS, d(20)), Ui.round(0xFF3C4043, d(20))));
            off.setOnClickListener(v -> { Defaults.useStockHome(this); guideFor = false; render(); });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, d(40));
            lp.topMargin = d(22);
            col.addView(off, lp);
        }
        side.addView(col);
    }

    /** Short illustrated guide for TVs that hide the home app choice. */
    private void showGuide() {
        side.removeAllViews();
        LinearLayout col = sideColumn();
        addSideText(col, getString(R.string.def_guide_title), 20, Ui.TEXT, 0);
        addSideText(col, getString(R.string.def_guide_android), 13, Ui.TEXT_DIM, 10);
        // The path as pictures: gear > apps > star > home, with arrows.
        LinearLayout steps = new LinearLayout(this);
        steps.setOrientation(LinearLayout.HORIZONTAL);
        steps.setGravity(Gravity.CENTER_VERTICAL);
        int[] icons = {R.drawable.lx_settings, R.drawable.lx_apps, R.drawable.lx_check, R.drawable.lx_home};
        int[] names = {R.string.def_step1, R.string.def_step2, R.string.def_step3, R.string.def_step4};
        for (int i = 0; i < icons.length; i++) {
            LinearLayout st = new LinearLayout(this);
            st.setOrientation(LinearLayout.VERTICAL);
            st.setGravity(Gravity.CENTER_HORIZONTAL);
            FrameLayout c = new FrameLayout(this);
            c.setBackground(Ui.round(0xFF2B2E33, d(12)));
            c.addView(Ui.icon(this, icons[i], 22, Ui.TEXT), new FrameLayout.LayoutParams(d(22), d(22), Gravity.CENTER));
            st.addView(c, new LinearLayout.LayoutParams(d(52), d(44)));
            TextView n = Ui.text(this, getString(names[i]), 10, Ui.TEXT_DIM, Ui.REGULAR);
            n.setPadding(0, d(5), 0, 0);
            st.addView(n);
            steps.addView(st, new LinearLayout.LayoutParams(d(66), -2));
            if (i < icons.length - 1) {
                steps.addView(Ui.icon(this, R.drawable.lx_arrow, 14, Ui.TEXT_DIM), new LinearLayout.LayoutParams(d(14), d(14)));
            }
        }
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(-2, -2);
        sp.topMargin = d(14);
        col.addView(steps, sp);
        addSideText(col, getString(R.string.def_guide_google), 12, Ui.TEXT_DIM, 16);
        if (Build.VERSION.SDK_INT >= 29) addSideText(col, getString(R.string.def_guide_after), 12, Ui.TEXT_DIM, 10);
        side.addView(col);
    }

    private LinearLayout sideColumn() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(d(36), d(64), d(36), d(24));
        return col;
    }

    private void addSideText(LinearLayout col, String s, float sp, int color, int top) {
        TextView t = Ui.text(this, s, sp, color, Ui.REGULAR);
        t.setSingleLine(false);
        t.setLineSpacing(0, 1.2f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = d(top);
        col.addView(t, lp);
    }
}
