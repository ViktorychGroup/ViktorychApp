package app.viktorych.tv.files;

import android.content.Context;
import android.os.Build;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

import app.viktorych.tv.R;

/** Where files live: this TV's storage, its Downloads folder and any USB drive. */
final class Roots {
    static final class Root {
        final String label;
        final File dir;
        final boolean usb;
        Root(String label, File dir, boolean usb) { this.label = label; this.dir = dir; this.usb = usb; }
    }

    private Roots() {}

    static List<Root> list(Context c) {
        List<Root> out = new ArrayList<>();
        File internal = Environment.getExternalStorageDirectory();
        File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (downloads != null) out.add(new Root(c.getString(R.string.fl_downloads), downloads, false));
        if (internal != null) out.add(new Root(c.getString(R.string.fl_this_tv), internal, false));
        for (Root r : usb(c)) {
            boolean dup = false;
            for (Root o : out) if (o.dir.getAbsolutePath().equals(r.dir.getAbsolutePath())) dup = true;
            if (!dup) out.add(r);
        }
        return out;
    }

    static List<Root> usb(Context c) {
        List<Root> out = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 24) {
            try {
                StorageManager sm = (StorageManager) c.getSystemService(Context.STORAGE_SERVICE);
                for (StorageVolume v : sm.getStorageVolumes()) {
                    if (v.isPrimary() || !Environment.MEDIA_MOUNTED.equals(v.getState()) && !Environment.MEDIA_MOUNTED_READ_ONLY.equals(v.getState())) continue;
                    File dir = dirOf(v);
                    if (dir == null) continue;
                    String label = v.getDescription(c);
                    out.add(new Root(label == null || label.isEmpty() ? c.getString(R.string.fl_usb) : label, dir, true));
                }
                return out;
            } catch (RuntimeException ignored) { /* fall back to /storage */ }
        }
        File[] all = new File("/storage").listFiles();
        if (all != null) {
            for (File f : all) {
                String n = f.getName();
                if (n.equals("emulated") || n.equals("self") || !f.isDirectory() || !f.canRead()) continue;
                out.add(new Root(c.getString(R.string.fl_usb) + " (" + n + ")", f, true));
            }
        }
        return out;
    }

    private static File dirOf(StorageVolume v) {
        if (Build.VERSION.SDK_INT >= 30) return v.getDirectory();
        try {
            Object p = StorageVolume.class.getMethod("getPathFile").invoke(v);
            if (p instanceof File) return (File) p;
        } catch (ReflectiveOperationException | RuntimeException ignored) { /* try getPath */ }
        try {
            Object p = StorageVolume.class.getMethod("getPath").invoke(v);
            if (p instanceof String) return new File((String) p);
        } catch (ReflectiveOperationException | RuntimeException ignored) { /* none */ }
        return null;
    }

    /** True when path is inside one of today's roots. */
    static boolean allowed(Context c, String path) {
        for (Root r : list(c)) if (FileModel.inside(r.dir.getAbsolutePath(), path)) return true;
        return false;
    }
}
