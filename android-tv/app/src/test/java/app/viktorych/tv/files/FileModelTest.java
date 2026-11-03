package app.viktorych.tv.files;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

public class FileModelTest {
    @Test
    public void kindsAndMimes() {
        assertEquals(FileModel.Kind.IMAGE, FileModel.kind("Holiday.JPG"));
        assertEquals(FileModel.Kind.VIDEO, FileModel.kind("clip.mkv"));
        assertEquals(FileModel.Kind.AUDIO, FileModel.kind("song.flac"));
        assertEquals(FileModel.Kind.APK, FileModel.kind("app.apk"));
        assertEquals(FileModel.Kind.OTHER, FileModel.kind("notes"));
        assertEquals(FileModel.Kind.OTHER, FileModel.kind("trailing."));
        assertEquals("image/jpeg", FileModel.mime("a.jpeg"));
        assertEquals("video/mp4", FileModel.mime("b.M4V"));
        assertEquals("application/vnd.android.package-archive", FileModel.mime("x.apk"));
        assertEquals("application/octet-stream", FileModel.mime("x.unknown"));
    }

    @Test
    public void sizes() {
        assertEquals("512 B", FileModel.size(512));
        assertEquals("1.5 KB", FileModel.size(1536));
        assertEquals("34 MB", FileModel.size(34L * 1024 * 1024));
        assertEquals("2.0 GB", FileModel.size(2L * 1024 * 1024 * 1024));
    }

    @Test
    public void foldersFirstNaturalOrderNoDotfiles() {
        List<FileModel.Entry> in = new ArrayList<>();
        in.add(new FileModel.Entry("img10.jpg", "/r/img10.jpg", false, 1, 0));
        in.add(new FileModel.Entry("img2.jpg", "/r/img2.jpg", false, 1, 0));
        in.add(new FileModel.Entry(".hidden", "/r/.hidden", false, 1, 0));
        in.add(new FileModel.Entry("zeta", "/r/zeta", true, 0, 0));
        in.add(new FileModel.Entry("Alpha", "/r/Alpha", true, 0, 0));
        in.add(new FileModel.Entry("img02b.jpg", "/r/img02b.jpg", false, 1, 0));
        List<String> names = new ArrayList<>();
        for (FileModel.Entry e : FileModel.sorted(in, false)) names.add(e.name);
        assertEquals(Arrays.asList("Alpha", "zeta", "img2.jpg", "img02b.jpg", "img10.jpg"), names);
        assertEquals(6, FileModel.sorted(in, true).size());
    }

    @Test
    public void pathsStayInsideTheRoot() {
        String root = "/storage/ABCD-1234";
        assertTrue(FileModel.inside(root, root));
        assertTrue(FileModel.inside(root, root + "/DCIM/a.jpg"));
        assertFalse(FileModel.inside(root, "/storage/ABCD-12345/x"));
        assertFalse(FileModel.inside(root, root + "/../emulated/0/secret"));
        assertFalse(FileModel.inside(root, root + "/DCIM/.."));
        assertFalse(FileModel.inside(root, "/data/data/x"));
        assertEquals(Arrays.asList("DCIM", "Camera"), FileModel.crumbs(root, root + "/DCIM/Camera"));
        assertTrue(FileModel.crumbs(root, root).isEmpty());
        assertEquals(root + "/DCIM", FileModel.up(root, root + "/DCIM/Camera"));
        assertEquals(root, FileModel.up(root, root + "/DCIM"));
        assertNull(FileModel.up(root, root));
        assertNull(FileModel.up(root, "/elsewhere"));
    }
}
