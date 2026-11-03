package app.viktorych.tv.files;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** What a file is, how big it is and in what order a folder lists.
 *  Pure Java so it can be unit tested. */
public final class FileModel {
    public enum Kind { FOLDER, IMAGE, VIDEO, AUDIO, APK, OTHER }

    public static final class Entry {
        public final String name, path;
        public final boolean dir;
        public final long size, modified;
        public final Kind kind;
        public Entry(String name, String path, boolean dir, long size, long modified) {
            this.name = name; this.path = path; this.dir = dir; this.size = size; this.modified = modified;
            this.kind = dir ? Kind.FOLDER : kind(name);
        }
    }

    private FileModel() {}

    public static String ext(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        return dot < 0 || dot == name.length() - 1 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    public static Kind kind(String name) {
        switch (ext(name)) {
            case "jpg": case "jpeg": case "png": case "gif": case "webp": case "bmp": case "heic": case "heif":
                return Kind.IMAGE;
            case "mp4": case "m4v": case "mkv": case "webm": case "mov": case "avi": case "3gp": case "ts": case "m2ts": case "mpg": case "mpeg": case "wmv":
                return Kind.VIDEO;
            case "mp3": case "m4a": case "aac": case "flac": case "ogg": case "oga": case "opus": case "wav": case "wma":
                return Kind.AUDIO;
            case "apk":
                return Kind.APK;
            default:
                return Kind.OTHER;
        }
    }

    public static String mime(String name) {
        switch (ext(name)) {
            case "jpg": case "jpeg": return "image/jpeg";
            case "png": return "image/png";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "bmp": return "image/bmp";
            case "heic": return "image/heic";
            case "heif": return "image/heif";
            case "mp4": case "m4v": return "video/mp4";
            case "mkv": return "video/x-matroska";
            case "webm": return "video/webm";
            case "mov": return "video/quicktime";
            case "avi": return "video/x-msvideo";
            case "3gp": return "video/3gpp";
            case "ts": case "m2ts": return "video/mp2t";
            case "mpg": case "mpeg": return "video/mpeg";
            case "wmv": return "video/x-ms-wmv";
            case "mp3": return "audio/mpeg";
            case "m4a": return "audio/mp4";
            case "aac": return "audio/aac";
            case "flac": return "audio/flac";
            case "ogg": case "oga": return "audio/ogg";
            case "opus": return "audio/opus";
            case "wav": return "audio/wav";
            case "wma": return "audio/x-ms-wma";
            case "apk": return "application/vnd.android.package-archive";
            case "pdf": return "application/pdf";
            case "txt": return "text/plain";
            case "zip": return "application/zip";
            default: return "application/octet-stream";
        }
    }

    /** "512 B", "1.2 KB", "34 MB", "1.5 GB". */
    public static String size(long bytes) {
        if (bytes < 1024) return bytes + " B";
        String[] u = {"KB", "MB", "GB", "TB"};
        double v = bytes;
        int i = -1;
        do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
        return (v < 10 ? String.format(Locale.ROOT, "%.1f", v) : String.valueOf(Math.round(v))) + " " + u[i];
    }

    /** Folders first, then names in the order people expect: "2" before "10". */
    public static List<Entry> sorted(List<Entry> in, boolean showHidden) {
        List<Entry> out = new ArrayList<>();
        for (Entry e : in) if (showHidden || !e.name.startsWith(".")) out.add(e);
        Collections.sort(out, (a, b) -> {
            if (a.dir != b.dir) return a.dir ? -1 : 1;
            return natural(a.name, b.name);
        });
        return out;
    }

    public static int natural(String a, String b) {
        int i = 0, j = 0;
        while (i < a.length() && j < b.length()) {
            char x = a.charAt(i), y = b.charAt(j);
            if (Character.isDigit(x) && Character.isDigit(y)) {
                int si = i, sj = j;
                while (i < a.length() && Character.isDigit(a.charAt(i))) i++;
                while (j < b.length() && Character.isDigit(b.charAt(j))) j++;
                String na = strip(a.substring(si, i)), nb = strip(b.substring(sj, j));
                if (na.length() != nb.length()) return na.length() - nb.length();
                int c = na.compareTo(nb);
                if (c != 0) return c;
            } else {
                int c = Character.toLowerCase(x) - Character.toLowerCase(y);
                if (c != 0) return c;
                i++; j++;
            }
        }
        return (a.length() - i) - (b.length() - j);
    }

    private static String strip(String digits) {
        int k = 0;
        while (k < digits.length() - 1 && digits.charAt(k) == '0') k++;
        return digits.substring(k);
    }

    /** True when path is root itself or inside it (no ".." tricks). */
    public static boolean inside(String root, String path) {
        if (root == null || path == null || path.contains("/../") || path.endsWith("/..")) return false;
        String r = root.endsWith("/") ? root : root + "/";
        return path.equals(root) || path.startsWith(r);
    }

    /** Folder names from the root down to path, for the breadcrumb. */
    public static List<String> crumbs(String root, String path) {
        List<String> out = new ArrayList<>();
        if (!inside(root, path) || path.equals(root)) return out;
        for (String s : path.substring(root.length()).split("/")) if (!s.isEmpty()) out.add(s);
        return out;
    }

    /** Parent of path, or null at the root. */
    public static String up(String root, String path) {
        if (!inside(root, path) || path.equals(root)) return null;
        int slash = path.lastIndexOf('/');
        String p = slash <= 0 ? "/" : path.substring(0, slash);
        return inside(root, p) ? p : root;
    }
}
