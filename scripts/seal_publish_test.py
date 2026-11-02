# Sealed catalogs: the build step seals the reader copy for Pages. Run: python3 scripts/seal_publish_test.py
import json, os, sys, tempfile, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, "scripts")
import accounts_publish as ap
os.environ["ACCOUNT_PEPPER"] = "p1"
with tempfile.TemporaryDirectory() as d:
    site = Path(d) / "site"; site.mkdir(); src = Path(d) / "src"; src.mkdir()
    (src / "people.json").write_text('{"people":[1]}')
    n = ap.seal(site, src, "owner", read=lambda k: b'{"posts":[{"id":1},{"id":2,"ownerOnly":true}]}' if k == "feeds.json" else None)
    assert n == 2, n
    names = sorted(p.name for p in (site / "sealed").iterdir())
    assert names == ["feeds.json", "index.json", "people.json"], names
    out = subprocess.run(["node", "--input-type=module", "-e", f"""
import {{ openSealed, sealKeyBytes }} from '{Path.cwd().as_uri()}/worker/src/data-seal.js';
import fs from 'node:fs';
const doc = JSON.parse(fs.readFileSync('{site.as_posix()}/sealed/feeds.json','utf8'));
console.log(await openSealed(await sealKeyBytes('p1', doc.day), 'feeds.json', doc));
"""], capture_output=True, text=True)
    assert json.loads(out.stdout)["posts"] == [{"id": 1}], out
del os.environ["ACCOUNT_PEPPER"]
with tempfile.TemporaryDirectory() as d:
    assert ap.seal(Path(d), Path(d), "owner", read=lambda k: None) == 0
print("ok python seal")
