import hashlib
import os
import sys
from collections import defaultdict


def digest(path: str) -> str:
    value = hashlib.sha256()
    with open(path, "rb") as handle:
        chunk = handle.read(8 * 1024 * 1024)
        while chunk:
            value.update(chunk)
            chunk = handle.read(8 * 1024 * 1024)
    return value.hexdigest()


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: dedupe-resources.py ROOT")
    root = os.path.abspath(sys.argv[1])
    by_size = defaultdict(list)
    for current, _, files in os.walk(root):
        for name in files:
            path = os.path.join(current, name)
            by_size[os.path.getsize(path)].append(path)

    by_hash = defaultdict(list)
    for size, paths in by_size.items():
        if len(paths) < 2:
            continue
        for path in paths:
            by_hash[(size, digest(path))].append(path)

    linked = 0
    reclaimed = 0
    for (size, _), paths in by_hash.items():
        if len(paths) < 2:
            continue
        canonical = paths[0]
        for duplicate in paths[1:]:
            if os.path.samefile(canonical, duplicate):
                continue
            os.unlink(duplicate)
            os.link(canonical, duplicate)
            linked += 1
            reclaimed += size
    print(f"linked={linked} reclaimed_bytes={reclaimed}")


if __name__ == "__main__":
    main()
