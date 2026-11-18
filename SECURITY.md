# Security

SpendTrack is a local-first browser app. By default it runs no backend and sends no spending data anywhere: everything stays in the browser's storage on your device.

Sync is optional and runs through a Supabase project the user sets up. Since 0.21.0, on a build with `VITE_SYNC_RELAY` set (as the guide does), a new sync is private: each device encrypts what it sends (AES-GCM-256, key derived from the sync code), and the database holds only ciphertext under an id derived from the code. An older, plain sync (a code without `ST5-`) is not encrypted. After migration 005 the public key that ships in the app can no longer list, read or write the table directly. The threat model, what the operator of the Supabase project can and cannot see, and the known limits are in [Run your own SpendTrack: What you get, and what you don't](docs/SELF_HOST.md#3-what-you-get-and-what-you-dont) and [`supabase/README.md`](supabase/README.md).

## Supported versions

The `main` branch and the latest release.

## Reporting a vulnerability

Please report privately: on GitHub, open the repository's **Security** tab and choose **Report a vulnerability**. If that option is not shown, open an issue that asks for a private contact, without any details of the problem.

In scope:

- the app in `src/` (local storage, backup import and export, sync, encryption)
- the SQL in `supabase/` (migrations, functions, checks)

Lower-risk bugs can go in a normal issue: what happened, what you expected, browser and operating system, steps to reproduce, and whether storage, backups or sync were involved.

## Sensitive data

Do not attach real spending exports, sync codes or screenshots with personal finance data to issues. Use redacted sample data instead.
