package app.viktorych.tv.files;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.format.DateFormat;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

import app.viktorych.tv.R;
import app.viktorych.tv.launcher.Ui;
import app.viktorych.tv.player.MediaDefaults;
import app.viktorych.tv.player.PlayerActivity;

/** One photo full screen. Left and right step through the album, OK shows
 *  or hides the details, play starts a slideshow. Videos in the album open
 *  in the player. Also opens photos other apps hand over. */
public final class PhotoActivity extends Activity {
    static final String EXTRA_INDEX = "index";
    private static final long SLIDE_MS = 5000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private List<Media.Item> items = new ArrayList<>();
    private int index;
    private ImageView front, back;
    private LinearLayout info;
    private TextView name, meta, playHint;
    private boolean slideshow;
    private int loadSeq;

    private int d(float v) { return Ui.dp(this, v); }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        back = image();
        front = image();
        root.addView(back, new FrameLayout.LayoutParams(-1, -1));
        root.addView(front, new FrameLayout.LayoutParams(-1, -1));

        info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setPadding(d(48), d(64), d(48), d(28));
        info.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0x00000000, 0xCC000000}));
        name = Ui.text(this, "", 18, Ui.TEXT, Ui.MEDIUM);
        meta = Ui.text(this, "", 14, Ui.TEXT_DIM, Ui.REGULAR);
        meta.setPadding(0, d(6), 0, 0);
        playHint = Ui.text(this, "", 13, Ui.TEXT_DIM, Ui.REGULAR);
        playHint.setPadding(0, d(10), 0, 0);
        info.addView(name);
        info.addView(meta);
        info.addView(playHint);
        root.addView(info, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        setContentView(root);

        Intent i = getIntent();
        if (Intent.ACTION_VIEW.equals(i.getAction()) && i.getData() != null) {
            items = new ArrayList<>();
            Uri u = i.getData();
            items.add(new Media.Item(u, -1, u.getLastPathSegment(), "", null, 0, 0, false));
            index = 0;
        } else {
            items = Media.current == null ? new ArrayList<>() : Media.current;
            index = Math.max(0, Math.min(i.getIntExtra(EXTRA_INDEX, 0), items.size() - 1));
        }
        if (items.isEmpty()) { finish(); return; }
        show(0);
    }

    private ImageView image() {
        ImageView v = new ImageView(this);
        v.setScaleType(ImageView.ScaleType.FIT_CENTER);
        return v;
    }

    private void show(int dir) {
        Media.Item item = items.get(index);
        name.setText(item.name);
        String when = item.date > 0 ? DateFormat.getMediumDateFormat(this).format(new Date(item.date)) : "";
        String pos = items.size() > 1 ? (index + 1) + " / " + items.size() : "";
        meta.setText(join(join(when, item.bucket), pos));
        playHint.setText(item.video ? getString(R.string.ph_play_video)
            : items.size() > 1 ? getString(slideshow ? R.string.ph_slideshow_on : R.string.ph_slideshow_hint) : "");
        final int seq = ++loadSeq;
        int w = getResources().getDisplayMetrics().widthPixels, h = getResources().getDisplayMetrics().heightPixels;
        new Thread(() -> {
            Bitmap bm = item.video ? videoFrame(item) : decode(item.uri, Math.max(w, h));
            runOnUiThread(() -> {
                if (seq != loadSeq || isFinishing()) return;
                ImageView old = front;
                front = back;
                back = old;
                front.setImageBitmap(bm);
                front.setAlpha(0f);
                front.setTranslationX(dir * d(40));
                front.bringToFront();
                info.bringToFront();
                front.animate().alpha(1f).translationX(0).setDuration(dir == 0 ? 200 : 350).start();
                back.animate().alpha(0f).setDuration(350).start();
            });
        }, "photo").start();
        if (slideshow) schedule();
    }

    private static String join(String a, String b) {
        if (a == null || a.isEmpty()) return b == null ? "" : b;
        if (b == null || b.isEmpty()) return a;
        return a + "  ·  " + b;
    }

    private Bitmap videoFrame(Media.Item item) {
        if (Build.VERSION.SDK_INT >= 29) {
            try { return getContentResolver().loadThumbnail(item.uri, new android.util.Size(1280, 720), null); }
            catch (Exception e) { return null; }
        }
        try {
            return android.provider.MediaStore.Video.Thumbnails.getThumbnail(getContentResolver(), item.id,
                android.provider.MediaStore.Video.Thumbnails.MINI_KIND, null);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Decodes at about screen size and turns it the way the camera held it. */
    private Bitmap decode(Uri uri, int target) {
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            try (InputStream in = getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(in, null, o); }
            int s = 1;
            while (o.outWidth / (s * 2) >= target || o.outHeight / (s * 2) >= target) s *= 2;
            BitmapFactory.Options d = new BitmapFactory.Options();
            d.inSampleSize = s;
            Bitmap bm;
            try (InputStream in = getContentResolver().openInputStream(uri)) { bm = BitmapFactory.decodeStream(in, null, d); }
            if (bm == null || Build.VERSION.SDK_INT < 24) return bm;
            int deg = 0;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                android.media.ExifInterface x = new android.media.ExifInterface(in);
                switch (x.getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) {
                    case android.media.ExifInterface.ORIENTATION_ROTATE_90: deg = 90; break;
                    case android.media.ExifInterface.ORIENTATION_ROTATE_180: deg = 180; break;
                    case android.media.ExifInterface.ORIENTATION_ROTATE_270: deg = 270; break;
                    default: break;
                }
            } catch (Exception ignored) { /* no EXIF */ }
            if (deg == 0) return bm;
            Matrix m = new Matrix();
            m.postRotate(deg);
            return Bitmap.createBitmap(bm, 0, 0, bm.getWidth(), bm.getHeight(), m, true);
        } catch (Exception | OutOfMemoryError e) {
            return null;
        }
    }

    private void step(int dir) {
        if (items.size() < 2) return;
        index = (index + dir + items.size()) % items.size();
        show(dir);
    }

    private final Runnable next = () -> { if (slideshow) step(1); };

    private void schedule() {
        main.removeCallbacks(next);
        main.postDelayed(next, SLIDE_MS);
    }

    private void setSlideshow(boolean on) {
        slideshow = on && items.size() > 1;
        if (slideshow) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            info.animate().alpha(0f).setDuration(300).start();
            schedule();
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            main.removeCallbacks(next);
            info.animate().alpha(1f).setDuration(200).start();
        }
        show(0);
    }

    private void playVideo(Media.Item item) {
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(item.uri, "video/*");
        if (MediaDefaults.enabled(this, MediaDefaults.player(this))) {
            i.setClass(this, PlayerActivity.class);
        } else if (item.path != null) {
            Open.file(this, new java.io.File(item.path));
            return;
        }
        try { startActivity(i); } catch (RuntimeException ignored) { }
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_RIGHT:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                step(1); if (slideshow) schedule(); return true;
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                step(-1); if (slideshow) schedule(); return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER: {
                Media.Item item = items.get(index);
                if (item.video) { playVideo(item); return true; }
                if (slideshow) { setSlideshow(false); return true; }
                info.animate().alpha(info.getAlpha() > 0.5f ? 0f : 1f).setDuration(200).start();
                return true;
            }
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_DPAD_DOWN:
                setSlideshow(!slideshow); return true;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_STOP:
                setSlideshow(false); return true;
            case KeyEvent.KEYCODE_BACK:
                if (slideshow) { setSlideshow(false); return true; }
                return super.onKeyDown(code, e);
            default:
                return super.onKeyDown(code, e);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        // A slideshow only runs while it is on screen.
        if (slideshow) setSlideshow(false);
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
