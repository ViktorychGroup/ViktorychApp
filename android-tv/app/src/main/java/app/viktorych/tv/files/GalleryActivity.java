package app.viktorych.tv.files;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Outline;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.FrameLayout;
import android.widget.GridView;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import app.viktorych.tv.R;
import app.viktorych.tv.launcher.Ui;
import app.viktorych.tv.player.Links;

/** Photos: every photo and video on the TV and on USB drives, newest first,
 *  with albums along the top. OK opens one full screen. */
public final class GalleryActivity extends Activity {
    private static final int REQ = 11;
    private static final int COLS = 5;

    private FrameLayout root;
    private List<Media.Item> all = new ArrayList<>();
    private List<Media.Item> shown = new ArrayList<>();
    private String album;
    private GridView grid;
    private Adapter adapter;
    private View lastSelected;

    private int d(float v) { return Ui.dp(this, v); }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        root = new FrameLayout(this);
        root.setBackgroundColor(Ui.BG);
        setContentView(root);
        if (FilesDefaults.canRead(this)) load(); else { askScreen(); FilesDefaults.ask(this, REQ); }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] p, int[] r) {
        if (req == REQ && FilesDefaults.canRead(this)) load();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (all.isEmpty() && FilesDefaults.canRead(this)) load();
    }

    private void askScreen() {
        root.removeAllViews();
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER);
        TextView t = Ui.text(this, getString(R.string.fl_need_access), 18, Ui.TEXT, Ui.REGULAR);
        t.setSingleLine(false);
        t.setGravity(Gravity.CENTER);
        col.addView(t, new LinearLayout.LayoutParams(d(560), -2));
        TextView again = Ui.pill(this, getString(R.string.fl_allow), false);
        again.setBackground(Ui.focusBg(Ui.round(Ui.FOCUS, d(20)), Ui.round(0xFF3C4043, d(20))));
        again.setOnClickListener(v -> FilesDefaults.ask(this, REQ));
        LinearLayout.LayoutParams al = new LinearLayout.LayoutParams(-2, d(40));
        al.topMargin = d(20);
        col.addView(again, al);
        TextView settings = Ui.pill(this, getString(R.string.fl_app_settings), false);
        settings.setBackground(Ui.focusBg(Ui.round(Ui.FOCUS, d(20)), Ui.round(0xFF3C4043, d(20))));
        settings.setOnClickListener(v -> FilesDefaults.openAppSettings(this));
        LinearLayout.LayoutParams sl = new LinearLayout.LayoutParams(-2, d(40));
        sl.topMargin = d(12);
        col.addView(settings, sl);
        root.addView(col, new FrameLayout.LayoutParams(-1, -1));
        again.requestFocus();
    }

    private void load() {
        root.removeAllViews();
        TextView wait = Ui.text(this, getString(R.string.fl_loading), 16, Ui.TEXT_DIM, Ui.REGULAR);
        root.addView(wait, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        new Thread(() -> {
            List<Media.Item> items = Media.load(getApplicationContext());
            runOnUiThread(() -> { if (!isFinishing()) { all = items; build(); } });
        }, "photos").start();
    }

    private void build() {
        root.removeAllViews();
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(d(48), d(28), d(48), 0);
        root.addView(col, new FrameLayout.LayoutParams(-1, -1));

        col.addView(Ui.text(this, getString(R.string.ph_title), 24, Ui.TEXT, Ui.REGULAR));

        HorizontalScrollView hs = new HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        LinearLayout pills = new LinearLayout(this);
        pills.setPadding(0, d(14), 0, d(14));
        hs.addView(pills);
        col.addView(hs);
        addPill(pills, getString(R.string.ph_all), null);
        for (Map.Entry<String, Integer> e : Media.albums(all)) addPill(pills, e.getKey(), e.getKey());

        if (all.isEmpty()) {
            TextView t = Ui.text(this, getString(R.string.ph_empty), 16, Ui.TEXT_DIM, Ui.REGULAR);
            t.setSingleLine(false);
            LinearLayout.LayoutParams tl = new LinearLayout.LayoutParams(-1, -2);
            tl.topMargin = d(40);
            col.addView(t, tl);
            return;
        }

        grid = new GridView(this);
        grid.setNumColumns(COLS);
        grid.setHorizontalSpacing(d(14));
        grid.setVerticalSpacing(d(14));
        grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);
        grid.setSelector(new android.graphics.drawable.ColorDrawable(0));
        grid.setClipToPadding(false);
        grid.setPadding(d(8), d(8), d(8), d(32));
        adapter = new Adapter();
        grid.setAdapter(adapter);
        grid.setOnItemClickListener((p, v, pos, id) -> open(pos));
        grid.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> p, View v, int pos, long id) { select(v); }
            @Override public void onNothingSelected(AdapterView<?> p) { select(null); }
        });
        grid.setOnFocusChangeListener((v, f) -> select(f ? grid.getSelectedView() : null));
        col.addView(grid, new LinearLayout.LayoutParams(-1, 0, 1f));
        filter(null);
        grid.requestFocus();
    }

    private void select(View v) {
        if (lastSelected != null && lastSelected != v) {
            lastSelected.animate().scaleX(1f).scaleY(1f).setDuration(120).start();
            ((FrameLayout) lastSelected).setForeground(null);
        }
        if (v != null) {
            v.animate().scaleX(1.08f).scaleY(1.08f).setDuration(120).start();
            android.graphics.drawable.GradientDrawable ring = Ui.round(0, d(10));
            ring.setStroke(d(3), Ui.FOCUS);
            ((FrameLayout) v).setForeground(ring);
        }
        lastSelected = v;
    }

    private void addPill(LinearLayout pills, String label, String key) {
        TextView p = Ui.pill(this, label, false);
        p.setOnClickListener(v -> filter(key));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, d(36));
        lp.rightMargin = d(10);
        pills.addView(p, lp);
    }

    private void filter(String key) {
        album = key;
        shown = new ArrayList<>();
        for (Media.Item i : all) if (key == null || key.equals(i.bucket)) shown.add(i);
        if (adapter != null) adapter.notifyDataSetChanged();
        if (grid != null) { grid.setSelection(0); grid.requestFocus(); }
    }

    private void open(int pos) {
        Media.current = shown;
        Intent i = new Intent(this, PhotoActivity.class).putExtra(PhotoActivity.EXTRA_INDEX, pos);
        startActivity(i);
    }

    private final class Adapter extends BaseAdapter {
        @Override public int getCount() { return shown.size(); }
        @Override public Object getItem(int p) { return shown.get(p); }
        @Override public long getItemId(int p) { return p; }

        @Override
        public View getView(int pos, View convert, ViewGroup parent) {
            FrameLayout cell = (FrameLayout) convert;
            int w = (grid.getWidth() - grid.getPaddingLeft() - grid.getPaddingRight() - d(14) * (COLS - 1)) / COLS;
            if (cell == null) {
                cell = new FrameLayout(GalleryActivity.this);
                cell.setBackground(Ui.round(0xFF2B2E33, d(10)));
                cell.setOutlineProvider(new ViewOutlineProvider() {
                    @Override public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), d(10)); }
                });
                cell.setClipToOutline(true);
                ImageView iv = new ImageView(GalleryActivity.this);
                iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
                cell.addView(iv, new FrameLayout.LayoutParams(-1, -1));
                TextView badge = Ui.text(GalleryActivity.this, "", 12, 0xFFFFFFFF, Ui.MEDIUM);
                badge.setPadding(d(6), d(2), d(6), d(2));
                badge.setBackground(Ui.round(0x99000000, d(4)));
                badge.setCompoundDrawablePadding(d(4));
                FrameLayout.LayoutParams bl = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.END);
                bl.setMargins(0, 0, d(6), d(6));
                cell.addView(badge, bl);
            }
            cell.setLayoutParams(new GridView.LayoutParams(-1, Math.max(d(60), w * 3 / 4)));
            Media.Item item = shown.get(pos);
            ImageView iv = (ImageView) cell.getChildAt(0);
            TextView badge = (TextView) cell.getChildAt(1);
            Thumbs.media(iv, item);
            if (item.video) {
                badge.setVisibility(View.VISIBLE);
                badge.setText(item.duration > 0 ? Links.clock(item.duration) : "▶");
            } else {
                badge.setVisibility(View.GONE);
            }
            return cell;
        }
    }
}
