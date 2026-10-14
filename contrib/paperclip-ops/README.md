# paperclip-ops: Jira sync + workspace sync + "同步 Jira 工单" button

**新同事从这里开始:[ONBOARDING.md](ONBOARDING.md)(安装 + 配置全流程)。**

**新同事从这里开始:[ONBOARDING.md](ONBOARDING.md)(安装 + 配置全流程)。**

Operational extras for a self-hosted Paperclip instance (Roblox Luobu flavor):

- **`scripts/paperclip-jira-sync.py`** — polls Jira (cookie auth) and mirrors tickets as Paperclip issues, with a local state file for long-term identity. Modes: `sync`, `digest` (daily attention memo to flomo), `--dry-run`.
- **`scripts/paperclip-workspace-sync.py`** — reconciles workspace-manager Agent Workspaces into Paperclip projects + dedicated cursor agents. Ownership markers (`[wm-sync]` / `metadata.wmSync`) protect everything else.
- **`scripts/setup-jira-sync-routine.py`** — installs/updates the **同步 Jira 工单** routine. The routine is the in-UI button: Routines → Run creates an execution issue and the assignee agent runs the sync script.
- **`launchd/`** — LaunchAgents for 15-minute Jira sync, 15-minute workspace reconcile, and the daily 09:30 digest.
- **`bin/pc-api`** — tiny Paperclip API CLI for debugging.

## Install on a fresh instance

1. Install Paperclip and create a company. Note the company UUID.
2. Copy `scripts/` to `~/scripts/` and `bin/pc-api` to `~/bin/`.
3. Put your Jira cookie env at `/Users/txie/roblox-ghc/CeLLM/tokens/atlassian/session.env` (or adjust the path in `paperclip-jira-sync.py`).
4. Adjust the username and `PAPERCLIP_COMPANY_ID` in the `launchd/*.plist` files, copy them to `~/Library/LaunchAgents/`, then `launchctl bootstrap gui/$(id -u) <plist>`.
5. Install the UI button: `PAPERCLIP_COMPANY_ID=<uuid> SYNC_AGENT_ID=<agent-uuid> python3 scripts/setup-jira-sync-routine.py`. Re-run without `SYNC_AGENT_ID` after edits; it updates by title.

## Notes

- The Jira sync JQL defaults to the Luobu board scope (`project = LUOB AND assignee = currentUser() AND resolution = Unresolved AND updated >= -120d`). Override with `SYNC_JQL`.
- The routine button spends one heartbeat per click. The 15-minute launchd sync is free and deterministic; both share the same state file and cannot double-import (idempotency + file lock).
