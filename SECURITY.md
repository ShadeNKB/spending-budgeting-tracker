# Security

SpendTrack is a local-first browser app. By default it does not run a backend service or transmit user spending data. If optional Supabase sync is enabled, the app stores its sync copy as plaintext JSON in one row of the user's own Supabase project, keyed by a random UUID sync code. Until migration 005 is applied, anyone holding the app's public anon key can list and read every row (sync codes included) and write rows; migration 004 already takes delete, truncate and the prune function away from that key and refuses malformed writes. After 005 the table is closed to the public key: a device reaches its row only through three `SECURITY DEFINER` functions that need the sync code. The copy stays readable to whoever has the code and to the project owner; end-to-end encrypted (private) sync is planned. See [`supabase/README.md`](supabase/README.md).

## Supported Versions

The `main` branch is the active version.

## Reporting a Vulnerability

Please open a private security advisory on GitHub if the issue could expose, corrupt, or unexpectedly transmit user data.

For lower-risk issues, open a normal GitHub issue with:

- what happened
- expected behavior
- browser and operating system
- steps to reproduce
- whether local storage, import/export, or backups were involved

## Sensitive Data

Do not attach real spending exports or screenshots containing personal finance data to public issues. Use redacted sample data instead.
