# SpendTrack User Guide

SpendTrack is built for quick, private spending logs. The goal is to make daily tracking easy enough that it becomes a habit.

## Quick Entry

Use the top input to add expenses in natural language:

```text
coffee 4.50
grab 12 yesterday
netflix 15 monthly
lunch 8.90 2026-05-01
```

The parser detects:

- item name
- amount
- date hints such as `yesterday`
- recurring hints such as `monthly`
- category suggestions learned from previous entries

## Daily Workflow

1. Add expenses as they happen.
2. Use Pulse to check current month pace.
3. Use Ledger to search, filter, edit, or delete entries.
4. Use Insights to spot recurring charges and spending changes.
5. Export a JSON backup regularly if the data matters to you.

## Backups

SpendTrack stores data in browser `localStorage`. This keeps the app private and fast, but browser storage is still local storage.

Export a JSON backup before:

- clearing browser data
- switching browsers
- changing devices
- reinstalling the app
- testing with real spending records

Use CSV export when you want to analyse records in Excel, Google Sheets, or another finance tool.

## Privacy Model

SpendTrack has no backend and no account system. Your spending data stays in your browser unless you export it yourself.

This also means:

- there is no cloud recovery
- there is no multi-device sync yet
- data safety depends on local backups

## Current Limits

SpendTrack is intentionally focused. It does not currently support:

- bank imports
- multi-device sync
- shared budgets
- investment tracking
- account-based recovery

Those are valid future directions, but the current product is optimized for fast personal tracking.
