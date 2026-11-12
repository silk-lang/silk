"""The pinned npm tarball corpus of the inflate benchmark.

`corpus.lock.json` names every tarball by package, version, URL and SHA-512, so each run decodes
the same bytes. `fetch` downloads the tarballs it lacks into the cache and verifies all of them.
`relock` rebuilds the lock from the registry: the large packages below, then the packages their
dependency trees reach, breadth first, until the corpus has `SMALL_COUNT` small ones.
"""
import base64
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
LOCK = HERE / "corpus.lock.json"
REGISTRY = "https://registry.npmjs.org/"
AGENT = "inflate-benchmark"

# The packages the benchmark reports one by one.
LARGE = ["typescript", "next", "react-dom", "lodash", "@types/node", "@esbuild/linux-x64"]
# Their dependency trees supply the small packages.
SEEDS = ["next", "express", "webpack", "eslint", "jest", "vite"]
SMALL_COUNT = 300
SMALL_LIMIT = 256 * 1024


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def latest(name):
    """Returns the newest release of `name`, or None when the registry has no such package."""
    try:
        document = json.loads(get(REGISTRY + urllib.parse.quote(name, safe="@") + "/latest"))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    return {
        "name": name,
        "version": document["version"],
        "url": document["dist"]["tarball"],
        "integrity": document["dist"]["integrity"],
        "dependencies": sorted(document.get("dependencies", {})),
    }


def file_name(entry):
    return entry["name"].replace("/", "__").lstrip("@") + "-" + entry["version"] + ".tgz"


def verified(entry, data):
    algorithm, _, digest = entry["integrity"].partition("-")
    if algorithm != "sha512":
        raise SystemExit(f"{entry['name']}: integrity is {algorithm}, not sha512")
    actual = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != digest:
        raise SystemExit(f"{entry['name']}@{entry['version']}: SHA-512 mismatch")
    return data


def load():
    return json.loads(LOCK.read_text())["packages"]


def fetch(cache):
    """Returns the lock entries with a `path` each, after downloading what the cache lacks."""
    cache.mkdir(parents=True, exist_ok=True)

    def one(entry):
        path = cache / file_name(entry)
        data = path.read_bytes() if path.exists() else get(entry["url"])
        verified(entry, data)
        if not path.exists():
            path.write_bytes(data)
        return {**entry, "path": path, "compressed": len(data)}

    with ThreadPoolExecutor(8) as pool:
        return list(pool.map(one, load()))


def relock():
    packages = {}
    queue = list(SEEDS)
    seen = set(queue)
    small = 0
    for name in LARGE:
        entry = latest(name)
        packages[name] = {**entry, "group": "large"}
    while queue and small < SMALL_COUNT:
        batch, queue = queue[:16], queue[16:]
        with ThreadPoolExecutor(8) as pool:
            entries = [entry for entry in pool.map(latest, batch) if entry]
        for entry in entries:
            for dependency in entry["dependencies"]:
                if dependency not in seen:
                    seen.add(dependency)
                    queue.append(dependency)
            if entry["name"] in packages or small == SMALL_COUNT:
                continue
            if len(verified(entry, get(entry["url"]))) <= SMALL_LIMIT:
                packages[entry["name"]] = {**entry, "group": "small"}
                small += 1
    rows = [
        {key: entry[key] for key in ("name", "version", "group", "url", "integrity")}
        for entry in sorted(packages.values(), key=lambda entry: (entry["group"], entry["name"]))
    ]
    LOCK.write_text(json.dumps({"schemaVersion": 1, "packages": rows}, indent=1) + "\n")
    return rows
