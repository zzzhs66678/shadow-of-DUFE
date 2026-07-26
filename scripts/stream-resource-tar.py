import os
import sys
import tarfile


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: stream-resource-tar.py SOURCE_ROOT FILE_LIST")
    source_root = os.path.abspath(sys.argv[1])
    with open(sys.argv[2], "r", encoding="utf-8") as handle:
        relative_paths = [line.strip() for line in handle if line.strip()]

    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        for relative_path in relative_paths:
            source_path = os.path.abspath(
                os.path.join(source_root, relative_path.replace("/", os.sep))
            )
            if os.path.commonpath([source_root, source_path]) != source_root:
                raise ValueError(f"path escapes source root: {relative_path}")
            archive.add(source_path, arcname=relative_path, recursive=False)


if __name__ == "__main__":
    main()
