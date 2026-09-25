# Yamazaki branch

Cross-module program: **catalog events, notify, mid-phase input, all-users default.**

## Source of truth

**cliq-platform** `design/yamazaki/` on branch `yamazaki`  
(especially S0, S3, MERGE, IMPLEMENTATION)

## This repo’s slices

| Slice | Work |
|-------|------|
| **S0.2** | Add `phase.idle` to catalog (no legacy aliases) |
| **S3** | Rich `phase.input_required`, `realm:all_users`, fan-out, input-pause reviews; reject underscored types |
| **S6.3** | SPA timeline, notification rules, team notify editor |
| **SM** | Rebase carefully vs realm/settings parallel PRs |
