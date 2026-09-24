---
description: "Personal daily task planning with explicit manual rescheduling in DSH."
kind: "package-bundle"
---

# Daily Planner

English | [中文](README.zh.md)

## Summary

Plan routine and one-off tasks in a global floating card without switching conversations. Unfinished tasks keep their dates until you explicitly move or delete them. Closing the card does not finish the day or delete tasks.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Data and recovery](#data-and-recovery)
- [Verification](#verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The [bundle patch](cordis.patch.yml) adds one Host plugin and its browser entry. The browser entry contributes a sidebar footer toggle with order 5 and a global floating card. The quota widget in the current personal setup uses order 10. This package is not included in DSH defaults; building it does not install or activate it in a running profile.

Open the card to add today's tasks or configure routines. Routines support selected weekdays (Monday–Friday for the workday shortcut). Starting today marks the plan ready without preventing further edits. Review each unfinished task by completing, deleting or explicitly moving it; completing the review requires no remaining open tasks on that date.

Previous unfinished tasks appear separately, not as today's commitments. Today's routine occurrences are generated once; past days without generated occurrences are not backfilled. Deleting one occurrence preserves its recurrence rule. A move that collides with another occurrence requires confirmation to keep both. Deleted tasks can be restored. Up/down actions reorder unfinished tasks relative to other unfinished tasks on that date, skipping completed tasks.

## Configuration

The Host validates these plugin fields; they are public configuration, not secrets. The Web client loader does not pass Host configuration to the browser entry, which uses the browser defaults listed below. Custom Host values for refreshIntervalMs, requestTimeoutMs and sidebarOrder are not propagated to the browser.

| Field | Default | Meaning |
|---|---|---|
| timeZone | Host's Intl time zone | Calendar dates for a new planner; must match the saved planner when reopening. |
| refreshIntervalMs | 60000 | Visible-page refresh interval; integer, at least 1000 ms. |
| requestTimeoutMs | 15000 | Browser request timeout; integer, at least 1000 ms. |
| sidebarOrder | 5 | Ordering of the sidebar footer toggle. |

## Data and recovery

The Host keeps a single version-1 aggregate in the storage domain named daily_planner. The configured DSH storage backend owns its location; tasks are not stored in conversation logs or only in browser storage. Writes and day generation are serialized, and only committed state is displayed as saved. The latest 256 successful operation receipts support retry after a lost response; older retries are still revision checked.

Task and routine editors retain the revision at which editing began. A concurrent change rejects a stale save, preserves the draft and offers an explicit action to load the latest content and discard that draft. Background refresh never silently updates the draft's revision. Duplicate-occurrence confirmation retains the original move revision too; if another window changes the plan, confirmation fails rather than overwriting that change. Unrelated plan changes can also cause a conservative conflict. Editing controls are locked during pending or uncertain saves; closing and reopening the card does not unlock them.

A failed request leaves the last confirmed task state visible. The header distinguishes an unconfirmed save, a rejected save and a failed refresh from a saved response. Use Retry saving after an uncertain response; the same operation identity prevents double application. Deleted tasks are soft-deleted rather than physically removed. Card visibility and unsubmitted drafts are memory-only and do not survive a full page reload.

A configured time zone must match the saved time zone. A mismatch rejects activation before registering the API or changing data; restore the original configuration to reopen it. The `occurrence:` task-ID prefix is reserved for generated tasks. Manual additions with that prefix are rejected. If existing data already occupies a generated ID, generation chooses an unused deterministic suffix without changing the existing task. Recurrence uniqueness still follows the routine and original date.

## Verification

Run the following from this package directory with its dependencies installed:

~~~sh
pnpm run check
~~~

The check runs TypeScript, deterministic source tests, both bundles and the [built-artifact verifier](scripts/verify-artifacts.mjs). The verifier uses private temporary storage and Chromium; it does not modify the active Web profile. Packaging invokes the same check through prepack. Browser availability and the precise verification scope are documented by the verifier's diagnostics.

## Model Experience

No tools or model-visible context are registered. The card does not consume model tokens or change the model's KV cache. It is independent of Agent todo lists and goals.

## Known Limitations and Deferred Work

This local package targets the current DSH APIs and uses local development dependency links. Full deployment, authentication and interaction testing on the existing GUI are separate from the artifact checks. There is no multi-user or cross-device synchronization, offline mutation queue, fixed right column, AI task management or automatic rollover. No standalone runtime invariant companion is exposed: the planner validates its single authoritative aggregate before commit and tests the browser's versioned projection separately.
