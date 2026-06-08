# Security

SpendTrack is a local-first browser app. By default it does not run a backend service or transmit user spending data. If optional Supabase sync is enabled, the app stores plaintext JSON in the user's own Supabase project and uses a UUID sync code as the shared secret.

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
