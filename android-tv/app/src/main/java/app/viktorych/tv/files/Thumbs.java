package app.viktorych.tv.files;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.ThumbnailUtils;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.LruCache;
import android.util.Size;
import android.widget.ImageView;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Small pictures for the grid and the file list, made off the main thread
 *  and kept in memory while the screen is open. */
final class Thumbs {
    private static final LruCache<String, Bitmap> CACHE = new LruCache<String, Bitmap>((int) (Runtime.getRuntime().maxMemory() / 10)) {
        @Override protected int sizeOf(String k, Bitmap b) { return b.getByteCount(); }
    };
    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private Thumbs() {}

    static void media(ImageView v, Media.Item item) {
        Context c = v.getContext().getApplicationContext();
        load(v, item.uri.toString(), () -> {
            if (Build.VERSION.SDK_INT >= 29) {
                try { return c.getContentResolver().loadThumbnail(item.uri, new Size(384, 288), null); }
                catch (Exception e) { return null; }
            }
            return legacy(c, item);
        });
    }

    @SuppressWarnings("deprecation")
    private static Bitmap legacy(Context c, Media.Item item) {
        try {
            return item.video
                ? MediaStore.Video.Thumbnails.getThumbnail(c.getContentResolver(), item.id, MediaStore.Video.Thumbnails.MINI_KIND, null)
                : MediaStore.Images.Thumbnails.getThumbnail(c.getContentResolver(), item.id, MediaStore.Images.Thumbnails.MINI_KIND, null);
        } catch (RuntimeException e) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    static void file(ImageView v, File f) {
        FileModel.Kind k = FileModel.kind(f.getName());
        load(v, f.getAbsolutePath() + "@" + f.lastModified(), () -> {
            if (k == FileModel.Kind.VIDEO) return ThumbnailUtils.createVideoThumbnail(f.getAbsolutePath(), MediaStore.Video.Thumbnails.MINI_KIND);
            return decode(f.getAbsolutePath(), 256);
        });
    }

    static Bitmap decode(String path, int target) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(path, o);
        int s = 1;
        while (o.outWidth / (s * 2) >= target && o.outHeight / (s * 2) >= target) s *= 2;
        o = new BitmapFactory.Options();
        o.inSampleSize = s;
        return BitmapFactory.decodeFile(path, o);
    }

    interface Maker { Bitmap make() throws Exception; }

    private static void load(ImageView v, String key, Maker m) {
        v.setTag(key);
        Bitmap hit = CACHE.get(key);
        if (hit != null) { v.setImageBitmap(hit); return; }
        v.setImageDrawable(null);
        POOL.execute(() -> {
            Bitmap b;
            try { b = m.make(); } catch (Throwable t) { b = null; }
            if (b != null) CACHE.put(key, b);
            final Bitmap done = b;
            MAIN.post(() -> { if (key.equals(v.getTag()) && done != null) v.setImageBitmap(done); });
        });
    }
}
