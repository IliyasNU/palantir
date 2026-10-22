"""Create a platform admin, or promote an existing user to admin.

Admins cannot self-register through the API, so this is the only way to get one.
Run from the `backend/` directory (or inside the container):

    python -m scripts.create_admin --email admin@example.com --full-name "Platform Admin"

The password is prompted for (kept out of shell history) when creating a new user.
Use a real-looking domain: reserved ones such as `.local` or `.test` are rejected.
"""
import argparse
import getpass
import sys

from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import select

from app.auth.security import hash_password
from app.db.seed import seed_roles
from app.db.session import SessionLocal
from app.models import Role, RoleName, User
from app.schemas.auth import MAX_PASSWORD_BYTES


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--email", required=True)
    parser.add_argument("--full-name", default="Platform Admin")
    parser.add_argument("--password", help="Only used when creating a new user; prompted for if omitted.")
    args = parser.parse_args(argv)

    try:
        email = TypeAdapter(EmailStr).validate_python(args.email).strip().lower()
    except ValidationError:
        print(f"Invalid email address: {args.email}", file=sys.stderr)
        return 2

    with SessionLocal() as db:
        seed_roles(db)
        admin_role = db.scalar(select(Role).where(Role.name == RoleName.ADMIN.value))
        user = db.scalar(select(User).where(User.email == email))

        if user is not None:
            user.role = admin_role
            db.commit()
            print(f"Promoted existing user {email} to admin (password unchanged).")
            return 0

        password = args.password or getpass.getpass("Password for the new admin: ")
        if len(password) < 8 or len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
            print("Password must be 8-72 bytes long.", file=sys.stderr)
            return 2

        db.add(
            User(
                email=email,
                full_name=args.full_name.strip() or "Platform Admin",
                hashed_password=hash_password(password),
                role=admin_role,
            )
        )
        db.commit()
        print(f"Created admin user {email}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
