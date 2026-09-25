# Realm fleet install — UX mock

Static HTML to discuss before wiring APIs.

## Open

```bash
open design/realm-fleet-install/index.html
```

Or serve any static way; Tailwind loads from CDN.

## What’s in scope (this slice)

- Realm page: **Teams on this fleet** + **Install to online daemons**
- Picker → targets (online = will install, offline = skipped)
- Progress (loop POST to each public URL)
- Per-daemon result table
- Daemon detail install left as-is (single-machine escape hatch)

## Out of scope (called out in the mock)

- Auto-install when a daemon comes online
- Desired-state / pin table
- Realm-level workspaces

## Scenario switcher (top-right)

Toggle: mixed / all online / none online / partial failure — to pressure-test empty and error states.
