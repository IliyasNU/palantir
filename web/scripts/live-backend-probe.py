"""Read-only probe, piped into the verified test container; never installed in backend."""
import hashlib
import json
import os
from pathlib import Path
import sys

stage = "source files"
try:
    manifest = json.loads(sys.argv[1])
    app = Path("/app")
    if (app / ".env").exists():
        raise RuntimeError("Backend .env overrides cannot be verified")
    for name, expected in manifest.items():
        if hashlib.sha256((app / name).read_bytes().replace(b"\r\n", b"\n")).hexdigest() != expected:
            raise RuntimeError("Backend source differs from the selected Git revision")
    actual = {str(p.relative_to(app)) for p in (app / "app").rglob("*.py")}
    if actual != {name for name in manifest if name.startswith("app/") and name.endswith(".py")}:
        raise RuntimeError("Unexpected backend Python source")

    stage = "uvicorn process"
    workers = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            args = (proc / "cmdline").read_bytes().decode().strip("\0").split("\0")
            if "app.main:app" in args and any(Path(a).name == "uvicorn" for a in args[:3]):
                workers.append((proc, args))
        except (FileNotFoundError, PermissionError, UnicodeError):
            continue
    if len(workers) != 1 or any(flag in workers[0][1] for flag in ("--reload", "--env-file", "--app-dir", "--factory")):
        raise RuntimeError("Requires one immutable uvicorn app.main:app process, without reload")
    proc, args = workers[0]
    worker_env = dict(item.split("=", 1) for item in (proc / "environ").read_bytes().decode().strip("\0").split("\0") if "=" in item)
    if worker_env.get("DATABASE_URL") != os.environ.get("DATABASE_URL") or worker_env.get("ENVIRONMENT") != "test":
        raise RuntimeError("Running FastAPI environment does not match inspected test settings")
    if str((proc / "cwd").resolve()) != "/app":
        raise RuntimeError("Unexpected FastAPI working directory")
    os.environ.clear()
    os.environ.update(worker_env)
    sys.path.insert(0, "/app")
    stage = "resolved engine"
    from app.db.session import engine, settings
    if settings.environment != "test":
        raise RuntimeError("Resolved settings are not test")
    # SELECT only; no migrations, users, tables or records are created.
    from sqlalchemy import text
    stage = "read-only database identity"
    with engine.connect() as connection:
        connection.exec_driver_sql("SET TRANSACTION READ ONLY")
        row = connection.execute(text("SELECT current_database(), host(inet_server_addr()), inet_server_port(), system_identifier::text FROM pg_control_system()")).one()
    print(json.dumps({
        "environment": settings.environment,
        "database": row[0], "serverAddress": row[1], "serverPort": row[2], "clusterId": row[3],
        "databaseHost": engine.url.host, "databasePort": engine.url.port or 5432,
        "sourceMatches": True, "workerPid": int(proc.name)
    }))
except Exception:
    # Driver exceptions/settings can contain credentials. Never echo them.
    print("Backend binding probe failed at " + stage + "; no test data may be created.", file=sys.stderr)
    sys.exit(1)
