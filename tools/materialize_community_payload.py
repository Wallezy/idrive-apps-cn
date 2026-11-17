#!/usr/bin/env python3
"""Materialize unchanged binary payloads from a pinned upstream package.

Source files, licences, services and modifications are kept in Git. Large
unmodified upstream binaries are fetched by exact artifact digest, never run
by this script, and copied only to explicitly declared build paths.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import tarfile
import tempfile


def main():
    root = pathlib.Path.cwd()
    spec = json.loads((root / "payload.json").read_text())
    artifact = spec["artifact"]
    cache = pathlib.Path(os.environ.get("MGU_COMMUNITY_CACHE", str(root / ".payload-cache")))
    cache.mkdir(parents=True, exist_ok=True)
    cached = cache / artifact["sha256"]

    def valid(path):
        if not path.is_file() or path.stat().st_size != artifact["size"]:
            return False
        sha = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                sha.update(chunk)
        return sha.hexdigest() == artifact["sha256"]

    if not valid(cached):
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as tmp:
            tmp_path = pathlib.Path(tmp.name)
        try:
            subprocess.run(["curl", "--http1.1", "--fail", "--location",
                            "--silent", "--show-error", "--connect-timeout", "15",
                            "--max-time", "900", artifact["url"], "-o", str(tmp_path)], check=True)
            if not valid(tmp_path):
                raise ValueError("Upstream artifact size or SHA-256 mismatch")
            tmp_path.replace(cached)
        finally:
            tmp_path.unlink(missing_ok=True)
    with tarfile.open(cached) as tar:
        members = {m.name: m for m in tar.getmembers()}
        for item in spec["files"]:
            relative = pathlib.PurePosixPath(item["path"])
            if relative.is_absolute() or ".." in relative.parts or "\\" in item["path"]:
                raise ValueError("Unsafe output path")
            member = members["files/" + item["path"]]
            if not member.isfile():
                raise ValueError("Payload member must be a regular file")
            data = tar.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise ValueError("Payload member digest mismatch")
            out = root / ".payload" / relative
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
    print("Verified upstream payload:", spec["id"])


if __name__ == "__main__":
    main()
