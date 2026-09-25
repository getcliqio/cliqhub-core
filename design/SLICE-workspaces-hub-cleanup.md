# Slice: Hub workspaces cleanup (fold sync into runs/create)

**Status:** Implementing  
**Repos:** cliqhub, cliq-platform, documentation

## Locked

- Keep Hub: `workspaces/get`, `get_by_id` (includes `teams`), `remove`
- Hard-cut: `upsert_by_path`, `add_team`, `remove_team`, `get_by_path`, `teams/get`, `count_by_team`
- Daemon → Hub: one outbox `runs/create` with `workspace_id` + `workspace_path` (+ name); Hub ensures row + team link

See plan file for subslices W1–W5.
