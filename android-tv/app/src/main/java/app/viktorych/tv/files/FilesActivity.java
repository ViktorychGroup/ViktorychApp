package app.viktorych.tv.files;

import android.app.Activity;
import android.content.Intent;
import android.graphics.drawable.StateListDrawable;
import android.os.Bundle;
import android.text.format.DateFormat;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import java.io.File;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

import app.viktorych.tv.R;
import app.viktorych.tv.launcher.Ui;

/** Files: this TV's Downloads, its storage and any USB drive. Read only:
 *  OK opens a folder or a file, Back goes up. Photos open in Photos, video
 *  and music in the player when it is on, anything else in the app you pick. */
public final class FilesActivity extends Activity {
    private static final int REQ = 12;

    private FrameLayout root;
    private List<Roots.Root> roots = new ArrayList<>();
    private Roots.Root root0;
    private String path;
    private List<FileModel.Entry> entries = new ArrayList<>();
    private LinearLayout rootList;
    private TextView crumbs, empty;
    private ListView list;
    private Adapter adapter;

    private int d(float v) { return Ui.dp(this, v); }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        root = new FrameLayout(this);
        root.setBackgroundColor(Ui.BG);
        setContentView(root);
        build();
        if (!FilesDefaults.canRead(this)) FilesDefaults.ask(this, REQ);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] p, int[] r) {
        if (req == REQ) refreshRoots();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // A USB drive may have come or gone while we were away.
        refreshRoots();
    }

    private void build() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        root.addView(row, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout side = new LinearLayout(this);
        side.setOrientation(LinearLayout.VERTICAL);
        side.setBackgroundColor(0xFF1C1E22);
        side.setPadding(d(28), d(32), d(20), d(20));
        side.addView(Ui.text(this, getString(R.string.fl_title), 24, Ui.TEXT, Ui.REGULAR));
        rootList = new LinearLayout(this);
        rootList.setOrientation(LinearLayout.VERTICAL);
        rootList.setPadding(0, d(18), 0, 0);
        side.addView(rootList);
        row.addView(side, new LinearLayout.LayoutParams(d(260), -1));

        LinearLayout main = new LinearLayout(this);
        main.setOrientation(LinearLayout.VERTICAL);
        main.setPadding(d(32), d(36), d(40), 0);
        crumbs = Ui.text(this, "", 15, Ui.TEXT_DIM, Ui.MEDIUM);
        main.addView(crumbs);
        empty = Ui.text(this, "", 15, Ui.TEXT_DIM, Ui.REGULAR);
        empty.setSingleLine(false);
        empty.setVisibility(View.GONE);
        LinearLayout.LayoutParams el = new LinearLayout.LayoutParams(-1, -2);
        el.topMargin = d(24);
        main.addView(empty, el);
        list = new ListView(this);
        list.setDivider(null);
        list.setDividerHeight(d(4));
        list.setSelector(new StateListDrawable());
        list.setClipToPadding(false);
        list.setPadding(0, d(14), 0, d(24));
        list.setItemsCanFocus(false);
        adapter = new Adapter();
        list.setAdapter(adapter);
        list.setOnItemClickListener((p, v, pos, id) -> open(entries.get(pos)));
        // Redraw rows when the remote moves so the highlighted row turns white.
        list.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> p, View v, int pos, long id) { adapter.notifyDataSetChanged(); }
            @Override public void onNothingSelected(android.widget.AdapterView<?> p) { adapter.notifyDataSetChanged(); }
        });
        list.setOnFocusChangeListener((v, f) -> adapter.notifyDataSetChanged());
        main.addView(list, new LinearLayout.LayoutParams(-1, 0, 1f));
        row.addView(main, new LinearLayout.LayoutParams(0, -1, 1f));
    }

    private void refreshRoots() {
        roots = Roots.list(this);
        rootList.removeAllViews();
        for (Roots.Root r : roots) {
            TextView p = Ui.pill(this, r.label, root0 != null && r.dir.equals(root0.dir));
            p.setGravity(Gravity.CENTER_VERTICAL);
            p.setCompoundDrawablePadding(d(10));
            p.setOnClickListener(v -> { root0 = r; go(r.dir.getAbsolutePath()); list.requestFocus(); });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, d(40));
            lp.bottomMargin = d(8);
            rootList.addView(p, lp);
        }
        if (!FilesDefaults.canRead(this)) {
            TextView ask = Ui.pill(this, getString(R.string.fl_allow), false);
            ask.setOnClickListener(v -> FilesDefaults.ask(this, REQ));
            rootList.addView(ask, new LinearLayout.LayoutParams(-1, d(40)));
        }
        boolean stillThere = false;
        if (root0 != null) for (Roots.Root r : roots) if (r.dir.equals(root0.dir)) stillThere = true;
        if (!stillThere) {
            root0 = roots.isEmpty() ? null : roots.get(0);
            path = root0 == null ? null : root0.dir.getAbsolutePath();
        }
        go(path);
        if (getCurrentFocus() == null) list.requestFocus();
    }

    private void go(String p) {
        path = p;
        entries = new ArrayList<>();
        if (root0 == null || p == null) {
            show(getString(R.string.fl_nothing));
            return;
        }
        File[] kids = new File(p).listFiles();
        List<FileModel.Entry> raw = new ArrayList<>();
        if (kids != null) for (File f : kids) raw.add(new FileModel.Entry(f.getName(), f.getAbsolutePath(), f.isDirectory(), f.isDirectory() ? 0 : f.length(), f.lastModified()));
        entries = FileModel.sorted(raw, false);
        StringBuilder sb = new StringBuilder(root0.label);
        for (String c : FileModel.crumbs(root0.dir.getAbsolutePath(), p)) sb.append("  ›  ").append(c);
        crumbs.setText(sb);
        show(entries.isEmpty() ? getString(FilesDefaults.canRead(this) ? R.string.fl_empty : R.string.fl_need_access) : null);
        for (int i = 0; i < rootList.getChildCount(); i++) {
            View v = rootList.getChildAt(i);
            if (i < roots.size()) v.setSelected(roots.get(i) == root0);
        }
    }

    private void show(String message) {
        adapter.notifyDataSetChanged();
        list.setSelection(0);
        empty.setText(message == null ? "" : message);
        empty.setVisibility(message == null ? View.GONE : View.VISIBLE);
    }

    private void open(FileModel.Entry e) {
        if (e.dir) { go(e.path); return; }
        File f = new File(e.path);
        if (e.kind == FileModel.Kind.IMAGE && FilesDefaults.photosEnabled(this)) {
            List<Media.Item> pics = new ArrayList<>();
            int at = 0;
            for (FileModel.Entry x : entries) {
                if (x.kind != FileModel.Kind.IMAGE) continue;
                if (x.path.equals(e.path)) at = pics.size();
                pics.add(new Media.Item(ShareProvider.uriFor(new File(x.path)), -1, x.name, "", x.path, x.modified, 0, false));
            }
            Media.current = pics;
            startActivity(new Intent(this, PhotoActivity.class).putExtra(PhotoActivity.EXTRA_INDEX, at));
            return;
        }
        Open.file(this, f);
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent ev) {
        if (code == KeyEvent.KEYCODE_BACK && root0 != null && path != null) {
            String up = FileModel.up(root0.dir.getAbsolutePath(), path);
            if (up != null) {
                String from = path;
                go(up);
                for (int i = 0; i < entries.size(); i++) if (entries.get(i).path.equals(from)) list.setSelection(i);
                list.requestFocus();
                return true;
            }
        }
        return super.onKeyDown(code, ev);
    }

    private int iconFor(FileModel.Kind k) {
        switch (k) {
            case FOLDER: return R.drawable.fl_folder;
            case IMAGE: return R.drawable.fl_image;
            case VIDEO: return R.drawable.fl_movie;
            case AUDIO: return R.drawable.fl_music;
            case APK: return R.drawable.fl_android;
            default: return R.drawable.fl_file;
        }
    }

    private final class Adapter extends BaseAdapter {
        @Override public int getCount() { return entries.size(); }
        @Override public Object getItem(int p) { return entries.get(p); }
        @Override public long getItemId(int p) { return p; }

        @Override
        public View getView(int pos, View convert, ViewGroup parent) {
            LinearLayout row = (LinearLayout) convert;
            if (row == null) {
                row = new LinearLayout(FilesActivity.this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(d(12), 0, d(16), 0);
                row.setLayoutParams(new ListView.LayoutParams(-1, d(56)));
                ImageView thumb = new ImageView(FilesActivity.this);
                thumb.setScaleType(ImageView.ScaleType.CENTER_CROP);
                row.addView(thumb, new LinearLayout.LayoutParams(d(40), d(40)));
                LinearLayout texts = new LinearLayout(FilesActivity.this);
                texts.setOrientation(LinearLayout.VERTICAL);
                texts.addView(Ui.text(FilesActivity.this, "", 15, Ui.TEXT, Ui.REGULAR));
                texts.addView(Ui.text(FilesActivity.this, "", 12, Ui.TEXT_DIM, Ui.REGULAR));
                LinearLayout.LayoutParams tl = new LinearLayout.LayoutParams(0, -2, 1f);
                tl.leftMargin = d(16);
                row.addView(texts, tl);
            }
            FileModel.Entry e = entries.get(pos);
            boolean sel = list.hasFocus() && list.getSelectedItemPosition() == pos;
            row.setBackground(Ui.round(sel ? 0xFFE8EAED : 0x00000000, d(12)));
            ImageView thumb = (ImageView) row.getChildAt(0);
            LinearLayout texts = (LinearLayout) row.getChildAt(1);
            TextView title = (TextView) texts.getChildAt(0), sub = (TextView) texts.getChildAt(1);
            title.setText(e.name);
            title.setTextColor(sel ? Ui.TEXT_ON_LIGHT : Ui.TEXT);
            sub.setTextColor(sel ? 0xB3202124 : Ui.TEXT_DIM);
            String when = e.modified > 0 ? DateFormat.getMediumDateFormat(FilesActivity.this).format(new Date(e.modified)) : "";
            sub.setText(e.dir ? when : FileModel.size(e.size) + (when.isEmpty() ? "" : "  ·  " + when));
            if (e.kind == FileModel.Kind.IMAGE || e.kind == FileModel.Kind.VIDEO) {
                thumb.setColorFilter(null);
                thumb.setScaleType(ImageView.ScaleType.CENTER_CROP);
                thumb.setBackground(Ui.round(0xFF2B2E33, d(6)));
                thumb.setClipToOutline(true);
                Thumbs.file(thumb, new File(e.path));
            } else {
                thumb.setTag(null);
                thumb.setBackground(null);
                thumb.setScaleType(ImageView.ScaleType.FIT_CENTER);
                thumb.setImageResource(iconFor(e.kind));
                thumb.setColorFilter(sel ? Ui.TEXT_ON_LIGHT : Ui.TEXT);
            }
            return row;
        }
    }
}
