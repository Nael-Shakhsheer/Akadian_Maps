"""Run the engine:  python -m engine serve [--home engine_data] [--public-port 8080] [--admin-port 8081]

The admin studio only listens on 127.0.0.1. To reach it from elsewhere, use an SSH tunnel; never expose it publicly.
"""
import argparse, asyncio
from pathlib import Path

import uvicorn

from .server import admin_app, public_app


def main():
    ap = argparse.ArgumentParser(prog="python -m engine")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="start the public map server and the private admin studio")
    s.add_argument("--home", default=str(Path(__file__).resolve().parent.parent / "engine_data"))
    s.add_argument("--public-host", default="0.0.0.0")
    s.add_argument("--public-port", type=int, default=8080)
    s.add_argument("--admin-port", type=int, default=8081)
    a = ap.parse_args()

    home = Path(a.home).resolve()
    home.mkdir(parents=True, exist_ok=True)
    servers = [
        uvicorn.Server(uvicorn.Config(public_app(home), host=a.public_host, port=a.public_port, log_level="warning")),
        uvicorn.Server(uvicorn.Config(admin_app(home), host="127.0.0.1", port=a.admin_port, log_level="warning")),
    ]
    print(f"Akadian Map Engine  |  data: {home}")
    print(f"  public map   http://localhost:{a.public_port}")
    print(f"  admin studio http://127.0.0.1:{a.admin_port}   (this machine only)")

    async def run():
        await asyncio.gather(*(sv.serve() for sv in servers))
    asyncio.run(run())


if __name__ == "__main__":
    main()
