"""Storage layout under the engine home (default: engine_data/, never served directly):

  vault.json                          passphrase check + KDF salt
  projects/<building-id>/settings.enc private project settings (floors, labels, entrances...)
  projects/<building-id>/blobs/*.enc  schematics, renders, OCR, drafts, debug overlays (encrypted)
  campuses/<campus-id>/settings.enc   campus settings + OSM data (encrypted for uniformity)
  published/campus/<id>.json          PUBLIC: compiled campus layer
  published/buildings/<id>.json       PUBLIC: compiled indoor map (no schematic content beyond room outlines)
"""
import json, re, shutil
from pathlib import Path

from .vault import Vault

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
BLOB = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}$")


def check_slug(s: str) -> str:
    if not isinstance(s, str) or not SLUG.match(s):
        raise ValueError("Use 2–41 lowercase letters, digits or dashes.")
    return s


class Store:
    def __init__(self, home: Path, vault: Vault):
        self.home = home
        self.vault = vault
        for d in ("projects", "campuses", "published/campus", "published/buildings"):
            (home / d).mkdir(parents=True, exist_ok=True)

    # ----- encrypted records -----
    def _dir(self, kind: str, id_: str) -> Path:
        return self.home / kind / check_slug(id_)

    def list(self, kind: str) -> list:
        return sorted(p.name for p in (self.home / kind).iterdir() if (p / "settings.enc").exists())

    def exists(self, kind: str, id_: str) -> bool:
        return (self._dir(kind, id_) / "settings.enc").exists()

    def load(self, kind: str, id_: str) -> dict:
        return json.loads(self.vault.decrypt((self._dir(kind, id_) / "settings.enc").read_bytes()))

    def save(self, kind: str, id_: str, settings: dict):
        d = self._dir(kind, id_)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "settings.enc.tmp"
        tmp.write_bytes(self.vault.encrypt(json.dumps(settings).encode()))
        tmp.replace(d / "settings.enc")

    def put_blob(self, kind: str, id_: str, name: str, data: bytes):
        if not BLOB.match(name):
            raise ValueError("bad blob name")
        d = self._dir(kind, id_) / "blobs"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{name}.enc").write_bytes(self.vault.encrypt(data))

    def get_blob(self, kind: str, id_: str, name: str):
        if not BLOB.match(name):
            raise ValueError("bad blob name")
        p = self._dir(kind, id_) / "blobs" / f"{name}.enc"
        return self.vault.decrypt(p.read_bytes()) if p.exists() else None

    def delete_floor_blobs(self, id_: str, fid: str):
        d = self._dir("projects", id_) / "blobs"
        for p in d.glob(f"*-{fid}.enc"):
            p.unlink()

    def delete(self, kind: str, id_: str):
        shutil.rmtree(self._dir(kind, id_))

    # ----- public output -----
    def publish(self, kind: str, id_: str, data: dict):
        d = self.home / "published" / kind
        tmp = d / f"{check_slug(id_)}.json.tmp"
        tmp.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        tmp.replace(d / f"{id_}.json")

    def unpublish(self, kind: str, id_: str):
        p = self.home / "published" / kind / f"{check_slug(id_)}.json"
        if p.exists():
            p.unlink()

    def published_path(self, kind: str, id_: str) -> Path:
        return self.home / "published" / kind / f"{check_slug(id_)}.json"
