package app.viktorych.tv.files;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/** Hands one file, read only, to the app the user opens it with (a video
 *  player, the package installer). Not exported: only links this app makes
 *  and grants work, and only for files on this TV's storage or a USB drive. */
public final class ShareProvider extends ContentProvider {
    static final String AUTHORITY = "app.viktorych.tv.files";

    static Uri uriFor(File f) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath("f")
            .appendEncodedPath(Uri.encode(f.getAbsolutePath(), "/").replaceFirst("^/", "")).build();
    }

    private File fileOf(Uri uri) throws FileNotFoundException {
        String path = uri.getPath();
        if (path == null || !path.startsWith("/f/")) throw new FileNotFoundException();
        File f = new File(path.substring(2));
        Context c = getContext();
        try {
            String real = f.getCanonicalPath();
            if (c == null || !Roots.allowed(c, real)) throw new FileNotFoundException();
            return new File(real);
        } catch (IOException e) {
            throw new FileNotFoundException();
        }
    }

    @Override public boolean onCreate() { return true; }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new SecurityException("read only");
        return ParcelFileDescriptor.open(fileOf(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File f;
        try { f = fileOf(uri); } catch (FileNotFoundException e) { return null; }
        MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        c.addRow(new Object[]{f.getName(), f.length()});
        return c;
    }

    @Override
    public String getType(Uri uri) {
        String p = uri.getPath();
        return p == null ? null : FileModel.mime(p);
    }

    @Override public Uri insert(Uri uri, ContentValues v) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String s, String[] a) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
}
