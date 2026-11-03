package app.viktorych.tv.launcher;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.drawable.Drawable;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Installed TV apps (the ones the TV's own home shows: MAIN + LEANBACK_LAUNCHER). */
final class Apps {
    static final class App {
        final String key;
        final ComponentName component;
        final CharSequence label;
        final ActivityInfo info;
        Drawable banner;   // 16:9 banner, or null when the app only has an icon
        Drawable icon;

        App(ComponentName cn, CharSequence label, ActivityInfo info) {
            this.component = cn;
            this.key = cn.getPackageName() + "/" + cn.getClassName();
            this.label = label;
            this.info = info;
        }
    }

    static final String TOOL = "app.viktorych.tv.category.TOOL";

    private Apps() {}

    static Map<String, App> load(Context c) {
        PackageManager pm = c.getPackageManager();
        Map<String, App> out = new LinkedHashMap<>();
        Intent tv = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER);
        List<ResolveInfo> list = new ArrayList<>(pm.queryIntentActivities(tv, 0));
        // Our own optional screens (Photos, Files) once they are switched on.
        Intent tools = new Intent(Intent.ACTION_MAIN).addCategory(TOOL).setPackage(c.getPackageName());
        list.addAll(pm.queryIntentActivities(tools, 0));
        for (ResolveInfo r : list) {
            ActivityInfo a = r.activityInfo;
            if (a == null) continue;
            ComponentName cn = new ComponentName(a.packageName, a.name);
            App app = new App(cn, r.loadLabel(pm), a);
            try { app.banner = a.loadBanner(pm); } catch (RuntimeException ignored) { /* none */ }
            if (app.banner == null) {
                try { app.banner = pm.getApplicationBanner(a.packageName); } catch (PackageManager.NameNotFoundException ignored) { /* none */ }
            }
            try { app.icon = r.loadIcon(pm); } catch (RuntimeException ignored) { /* none */ }
            out.put(app.key, app);
        }
        return out;
    }

    static Intent launchIntent(App a) {
        return new Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
            .setComponent(a.component)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
    }

    /** Opens the regular ViktorychTV app exactly as the TV's own home does:
     *  the enabled home-screen entry, in its own task. */
    static Intent ourApp(Context c) {
        Intent i = c.getPackageManager().getLeanbackLaunchIntentForPackage(c.getPackageName());
        if (i == null) i = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (i != null) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        return i;
    }
}
