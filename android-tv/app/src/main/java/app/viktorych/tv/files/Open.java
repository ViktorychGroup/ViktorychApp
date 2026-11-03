package app.viktorych.tv.files;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;

import java.io.File;

import app.viktorych.tv.R;
import app.viktorych.tv.player.MediaDefaults;
import app.viktorych.tv.player.PlayerActivity;

/** Opens a file the way the TV would: our player for video and music when
 *  it is on, otherwise the app the user picks. */
final class Open {
    private Open() {}

    static void file(Context c, File f) {
        Uri uri = ShareProvider.uriFor(f);
        String mime = FileModel.mime(f.getName());
        FileModel.Kind k = FileModel.kind(f.getName());
        if ((k == FileModel.Kind.VIDEO || k == FileModel.Kind.AUDIO) && MediaDefaults.enabled(c, MediaDefaults.player(c))) {
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                .setClass(c, PlayerActivity.class)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try { c.startActivity(i); return; } catch (RuntimeException ignored) { /* fall through */ }
        }
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (k == FileModel.Kind.APK) i.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, false);
        try {
            c.startActivity(Intent.createChooser(i, f.getName()).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(c, R.string.fl_no_app, Toast.LENGTH_LONG).show();
        }
    }
}
