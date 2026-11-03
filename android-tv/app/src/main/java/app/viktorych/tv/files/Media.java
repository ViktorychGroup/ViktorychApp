package app.viktorych.tv.files;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Photos and videos the TV knows about, on its own storage and on USB drives. */
final class Media {
    static final int MAX = 5000;

    static final class Item {
        final Uri uri;
        final long id;
        final String name, bucket, path;
        final long date, duration;
        final boolean video;
        Item(Uri uri, long id, String name, String bucket, String path, long date, long duration, boolean video) {
            this.uri = uri; this.id = id; this.name = name == null ? "" : name; this.bucket = bucket == null ? "" : bucket;
            this.path = path; this.date = date; this.duration = duration; this.video = video;
        }
    }

    /** The list PhotoActivity steps through; set by whoever opens it. */
    static List<Item> current = new ArrayList<>();

    private Media() {}

    static List<Item> load(Context c) {
        List<Item> out = new ArrayList<>();
        ContentResolver cr = c.getContentResolver();
        for (Uri base : bases(c, false)) query(cr, base, false, out);
        for (Uri base : bases(c, true)) query(cr, base, true, out);
        Collections.sort(out, (a, b) -> Long.compare(b.date, a.date));
        return out.size() > MAX ? new ArrayList<>(out.subList(0, MAX)) : out;
    }

    private static List<Uri> bases(Context c, boolean video) {
        List<Uri> out = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                Set<String> vols = MediaStore.getExternalVolumeNames(c);
                for (String v : vols) out.add(video ? MediaStore.Video.Media.getContentUri(v) : MediaStore.Images.Media.getContentUri(v));
                if (!out.isEmpty()) return out;
            } catch (RuntimeException ignored) { /* fall back */ }
        }
        out.add(video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
        return out;
    }

    @SuppressWarnings("deprecation")
    private static void query(ContentResolver cr, Uri base, boolean video, List<Item> out) {
        String[] cols = video
            ? new String[]{"_id", "_display_name", "bucket_display_name", "_data", "date_modified", "datetaken", "duration"}
            : new String[]{"_id", "_display_name", "bucket_display_name", "_data", "date_modified", "datetaken"};
        try (Cursor q = cr.query(base, cols, null, null, "date_modified DESC")) {
            if (q == null) return;
            while (q.moveToNext() && out.size() < MAX * 2) {
                long id = q.getLong(0);
                long taken = q.isNull(5) ? 0 : q.getLong(5);
                long date = taken > 0 ? taken : q.getLong(4) * 1000L;
                out.add(new Item(ContentUris.withAppendedId(base, id), id, q.getString(1), q.getString(2), q.getString(3),
                    date, video && !q.isNull(6) ? q.getLong(6) : 0, video));
            }
        } catch (RuntimeException ignored) { /* volume went away or no access */ }
    }

    /** Album names with how many items each has, biggest first. */
    static List<Map.Entry<String, Integer>> albums(List<Item> items) {
        Map<String, Integer> m = new LinkedHashMap<>();
        for (Item i : items) if (!i.bucket.isEmpty()) m.put(i.bucket, m.containsKey(i.bucket) ? m.get(i.bucket) + 1 : 1);
        List<Map.Entry<String, Integer>> out = new ArrayList<>(m.entrySet());
        Collections.sort(out, (a, b) -> b.getValue() - a.getValue());
        return out;
    }
}
