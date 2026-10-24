"""Encryption at rest for everything private (schematics, renders, OCR, project settings).

The key is derived from the admin passphrase with scrypt and only ever lives in this process's memory.
Lose the passphrase and the private data can't be recovered (published maps are unaffected).
"""
import base64, hashlib, json, os
from pathlib import Path
from cryptography.fernet import Fernet, InvalidToken

MIN_PASSPHRASE = 12
_CHECK = b"akadian-vault-ok"
_KDF = {"n": 2 ** 15, "r": 8, "p": 1}


def _derive(passphrase: str, salt: bytes, n: int, r: int, p: int) -> Fernet:
    key = hashlib.scrypt(passphrase.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=128 * 1024 * 1024, dklen=32)
    return Fernet(base64.urlsafe_b64encode(key))


class Vault:
    def __init__(self, home: Path):
        self.file = home / "vault.json"
        self._f = None

    @property
    def configured(self) -> bool:
        return self.file.exists()

    @property
    def unlocked(self) -> bool:
        return self._f is not None

    def setup(self, passphrase: str):
        if self.configured:
            raise ValueError("The vault is already set up.")
        if len(passphrase) < MIN_PASSPHRASE:
            raise ValueError(f"Use at least {MIN_PASSPHRASE} characters.")
        salt = os.urandom(16)
        f = _derive(passphrase, salt, **_KDF)
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps({"v": 1, "kdf": "scrypt", **_KDF, "salt": base64.b64encode(salt).decode(),
                                         "check": f.encrypt(_CHECK).decode()}))
        self._f = f

    def unlock(self, passphrase: str) -> bool:
        cfg = json.loads(self.file.read_text())
        f = _derive(passphrase, base64.b64decode(cfg["salt"]), cfg["n"], cfg["r"], cfg["p"])
        try:
            if f.decrypt(cfg["check"].encode()) != _CHECK:
                return False
        except InvalidToken:
            return False
        self._f = f
        return True

    def lock(self):
        self._f = None

    def encrypt(self, data: bytes) -> bytes:
        if not self._f:
            raise PermissionError("Vault is locked.")
        return self._f.encrypt(data)

    def decrypt(self, data: bytes) -> bytes:
        if not self._f:
            raise PermissionError("Vault is locked.")
        return self._f.decrypt(data)
