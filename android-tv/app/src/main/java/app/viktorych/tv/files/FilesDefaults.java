package app.viktorych.tv.files;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.util.ArrayList;
import java.util.List;

/** On/off for Photos and Files. They ship switched off; "off" puts them
 *  back to exactly that state. Storage access is asked for only when one
 *  of them is opened. */
public final class FilesDefaults {
    private FilesDefaults() {}

    public static ComponentName gallery(Context c) { return new ComponentName(c, GalleryActivity.class); }
    public static ComponentName photo(Context c) { return new ComponentName(c, PhotoActivity.class); }
    public static ComponentName files(Context c) { return new ComponentName(c, FilesActivity.class); }
    static ComponentName share(Context c) { return new ComponentName(c, ShareProvider.class); }

    static boolean on(Context c, ComponentName n) {
        return c.getPackageManager().getComponentEnabledSetting(n) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
    }

    public static boolean photosEnabled(Context c) { return on(c, gallery(c)); }
    public static boolean filesEnabled(Context c) { return on(c, files(c)); }

    private static void set(Context c, ComponentName n, boolean enabled) {
        c.getPackageManager().setComponentEnabledSetting(n,
            enabled ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DEFAULT,
            PackageManager.DONT_KILL_APP);
    }

    public static void enablePhotos(Context c, boolean enabled) {
        set(c, gallery(c), enabled);
        set(c, photo(c), enabled);
        set(c, share(c), enabled || filesEnabled(c));
    }

    public static void enableFiles(Context c, boolean enabled) {
        set(c, files(c), enabled);
        set(c, share(c), enabled || photosEnabled(c));
    }

    /** True when a photo from another app already opens in ours ("Always" was picked). */
    public static boolean isDefaultPhotos(Context c) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("content://media/external/images/media/1"), "image/jpeg");
            ResolveInfo r = c.getPackageManager().resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY);
            return r != null && r.activityInfo != null && PhotoActivity.class.getName().equals(r.activityInfo.name);
        } catch (RuntimeException e) {
            return false;
        }
    }

    public static void openPhotos(Context c) { start(c, new Intent(c, GalleryActivity.class)); }
    public static void openFiles(Context c) { start(c, new Intent(c, FilesActivity.class)); }

    private static void start(Context c, Intent i) {
        try { c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (RuntimeException ignored) { }
    }

    static String[] needed() {
        if (Build.VERSION.SDK_INT >= 33) {
            return new String[]{"android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_MEDIA_AUDIO"};
        }
        return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
    }

    static boolean canRead(Context c) {
        if (Build.VERSION.SDK_INT < 23) return true;
        for (String p : needed()) if (c.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) return true;
        return false;
    }

    static void ask(Activity a, int req) {
        if (Build.VERSION.SDK_INT < 23) return;
        List<String> want = new ArrayList<>();
        for (String p : needed()) if (a.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) want.add(p);
        if (!want.isEmpty()) a.requestPermissions(want.toArray(new String[0]), req);
    }

    static void openAppSettings(Context c) {
        start(c, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.getPackageName())));
    }
}
