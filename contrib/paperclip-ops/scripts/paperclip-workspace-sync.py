#!/usr/bin/env python3
"""Reconcile workspace-manager Agent Workspaces into local paperclip.

Source of truth is ~/.config/workspace-manager/cursor-workspaces/.
Entities without the wm ownership marker are never modified, except a
same-name adopt that only adds the marker.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# Local cursor agent binary. Not resolved from PATH, so a reconcile from
# another cwd cannot launch a different `agent`.
CURSOR_AGENT = "/Users/txie/.local/bin/agent"
# Default model for newly created agents. Reconcile merge preserves this key,
# so manual changes on existing agents are not reverted.
CURSOR_MODEL = "kimi-k3-max"
MARKER = "[wm-sync]"
WM_ROOT = Path.home() / ".config" / "workspace-manager" / "cursor-workspaces"
TIMEOUT_SECONDS = 60


def log(action, message):
    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    print(f"{stamp} {action} {message}", flush=True)


class Paperclip:
    def __init__(self, base, company_id, api_key, dry_run):
        self.base = base.rstrip("/")
        self.company_id = company_id
        self.api_key = api_key
        self.dry_run = dry_run

    def request(self, method, path, body=None):
        # Belt on top of the planner. A dry-run must not mutate even if a
        # caller forgets the flag check.
        if self.dry_run and method != "GET":
            raise RuntimeError(f"dry-run blocked {method} {path}")
        url = self.base + path
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{method} {path} -> {exc.reason}") from exc
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    def get(self, path):
        payload = self.request("GET", path)
        return payload

    def send(self, method, path, body):
        if self.dry_run:
            return None
        return self.request(method, path, body)


def as_list(payload, label):
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    raise RuntimeError(f"{label} response was not a JSON list")


def project_owned(project):
    return MARKER in (project.get("description") or "")


def agent_owned(agent):
    metadata = agent.get("metadata")
    return isinstance(metadata, dict) and metadata.get("wmSync") is True


def index_by_name(items, owned):
    """First row wins. A marked row replaces an earlier unmarked twin so the
    unmarked one cannot hide the entity we are allowed to touch."""
    chosen = {}
    for item in items:
        name = item.get("name")
        if not isinstance(name, str) or not name:
            continue
        previous = chosen.get(name)
        if previous is None:
            chosen[name] = item
            continue
        if owned(item) and not owned(previous):
            chosen[name] = item
            log("warn", f"duplicate name {name!r}, keeping the marked row")
        else:
            log("warn", f"duplicate name {name!r}, keeping the first row")
    return chosen


def choose_workspace_file(workspace_dir):
    preferred = workspace_dir / f"{workspace_dir.name}.code-workspace"
    found = sorted(path for path in workspace_dir.glob("*.code-workspace") if path.is_file())
    if preferred.is_file():
        return preferred
    if not found:
        return None
    # Same-name file is the wm output. Anything else is a leftover, so take
    # the sorted first rather than guessing which leftover is current.
    log(
        "warn",
        f"no same-named code-workspace in {workspace_dir.name!r}, using {found[0].name}",
    )
    return found[0]


def resolve_folder(raw, workspace_dir):
    expanded = os.path.expanduser(raw)
    path = Path(expanded)
    if not path.is_absolute():
        path = workspace_dir / path
    return path.resolve()


def scan_sources():
    sources = []
    alive = set()
    if not WM_ROOT.is_dir():
        log("warn", f"workspace root does not exist: {WM_ROOT}")
        return sources, alive
    for workspace_dir in sorted(path for path in WM_ROOT.iterdir() if path.is_dir()):
        alive.add(workspace_dir.name)
        workspace_file = choose_workspace_file(workspace_dir)
        if workspace_file is None:
            log("warn", f"no .code-workspace in {workspace_dir.name!r}, skipping")
            continue
        try:
            document = json.loads(workspace_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log("warn", f"cannot parse {workspace_file}: {exc}")
            continue
        folders = document.get("folders") if isinstance(document, dict) else None
        if not isinstance(folders, list):
            log("warn", f"no folders in {workspace_file}, skipping")
            continue
        real_dirs = []
        scaffold = workspace_file.parent.resolve()
        for folder in folders:
            if not isinstance(folder, dict):
                continue
            raw = folder.get("path")
            if not isinstance(raw, str) or not raw.strip():
                continue
            resolved = resolve_folder(raw, workspace_file.parent)
            if resolved == scaffold:
                continue
            if not resolved.is_dir():
                log(
                    "warn",
                    f"missing directory {resolved} (workspace {workspace_dir.name!r})",
                )
                continue
            real_dirs.append(str(resolved))
        if not real_dirs:
            log("warn", f"no real directories in {workspace_dir.name!r}, skipping")
            continue
        sources.append(
            {
                "name": workspace_dir.name,
                "primary": real_dirs[0],
                "add_dirs": real_dirs[1:],
            }
        )
    return sources, alive


def extra_args(add_dirs):
    args = []
    for directory in add_dirs:
        args.append("--add-dir")
        args.append(directory)
    return args


def project_description(name):
    return f"[wm-sync] Agent Workspace {name} (cursor-workspaces/{name})"


def append_marker(description):
    text = description or ""
    if MARKER in text:
        return text
    if text.strip():
        return text.rstrip() + " " + MARKER
    return MARKER


def action(dry_run, verb):
    if dry_run:
        return f"dry-run {verb}"
    return verb


def same_path(left, right):
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    return os.path.normpath(left) == os.path.normpath(right)


def reconcile_project(api, source, project):
    name = source["name"]
    if project is None:
        body = {
            "name": name,
            "description": project_description(name),
            "workspace": {
                "name": name,
                "cwd": source["primary"],
                "isPrimary": True,
            },
        }
        log(action(api.dry_run, "create"), f"project {name!r} cwd={source['primary']}")
        api.send("POST", f"/api/companies/{api.company_id}/projects", body)
        return
    if not project_owned(project):
        description = append_marker(project.get("description"))
        log(
            action(api.dry_run, "adopt"),
            f"project {name!r} id={project.get('id')} append description marker",
        )
        api.send("PATCH", f"/api/projects/{project['id']}", {"description": description})
        return
    # v1 does not move a project workspace. A wrong primary must not relocate
    # an in-use checkout, so drift is only a warning.
    workspaces = as_list(api.get(f"/api/projects/{project['id']}/workspaces"), "workspaces")
    primary = next((item for item in workspaces if item.get("isPrimary") is True), None)
    if primary is None and workspaces:
        primary = workspaces[0]
    cwd = primary.get("cwd") if primary else None
    if same_path(cwd, source["primary"]):
        log("skip", f"project {name!r} cwd matches {source['primary']}")
        return
    log(
        "drift",
        f"project {name!r} cwd {cwd!r} != {source['primary']!r}, left unchanged",
    )


def reconcile_agent(api, source, agent):
    name = source["name"]
    expected = extra_args(source["add_dirs"])
    if agent is None:
        body = {
            "name": name,
            "role": "general",
            "adapterType": "cursor",
            "adapterConfig": {
                "command": CURSOR_AGENT,
                "model": CURSOR_MODEL,
                "cwd": source["primary"],
                "extraArgs": expected,
            },
            "metadata": {"wmSync": True},
        }
        log(
            action(api.dry_run, "create"),
            f"agent {name!r} cwd={source['primary']} extraArgs={expected}",
        )
        api.send("POST", f"/api/companies/{api.company_id}/agents", body)
        return
    if not agent_owned(agent):
        # PATCH replaces metadata wholesale. Read the current object and set
        # the flag on a copy so other keys survive the adopt.
        current = api.get(f"/api/agents/{agent['id']}")
        if not isinstance(current, dict):
            raise RuntimeError(f"GET /api/agents/{agent['id']} did not return an object")
        metadata = dict(current.get("metadata") or {})
        metadata["wmSync"] = True
        log(
            action(api.dry_run, "adopt"),
            f"agent {name!r} id={agent.get('id')} set metadata.wmSync, adapterConfig unchanged",
        )
        api.send("PATCH", f"/api/agents/{agent['id']}", {"metadata": metadata})
        return
    config = agent.get("adapterConfig") if isinstance(agent.get("adapterConfig"), dict) else {}
    current_extra = config.get("extraArgs")
    if not isinstance(current_extra, list):
        current_extra = []
    if same_path(config.get("cwd"), source["primary"]) and current_extra == expected:
        log("skip", f"agent {name!r} cwd and extraArgs match")
        return
    current = api.get(f"/api/agents/{agent['id']}")
    if not isinstance(current, dict):
        raise RuntimeError(f"GET /api/agents/{agent['id']} did not return an object")
    merged = dict(current.get("adapterConfig") or {})
    merged["cwd"] = source["primary"]
    merged["extraArgs"] = expected
    log(
        action(api.dry_run, "drift"),
        f"agent {name!r} id={agent.get('id')} cwd {config.get('cwd')!r} -> {source['primary']!r} extraArgs {current_extra!r} -> {expected!r}",
    )
    api.send("PATCH", f"/api/agents/{agent['id']}", {"adapterConfig": merged})


def cancel_stale(api, projects, agents, alive):
    for project in projects:
        if not project_owned(project):
            continue
        name = project.get("name")
        if name in alive or project.get("status") == "cancelled":
            continue
        log(action(api.dry_run, "cancel"), f"project {name!r} id={project.get('id')} no workspace directory")
        api.send("PATCH", f"/api/projects/{project['id']}", {"status": "cancelled"})
    for agent in agents:
        if not agent_owned(agent):
            continue
        name = agent.get("name")
        if name in alive or agent.get("status") == "paused":
            continue
        log(action(api.dry_run, "pause"), f"agent {name!r} id={agent.get('id')} no workspace directory")
        api.send("POST", f"/api/agents/{agent['id']}/pause", None)


def main(argv):
    parser = argparse.ArgumentParser(
        description="Reconcile workspace-manager Agent Workspaces into local paperclip."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the plan. GET paperclip and the filesystem only.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one pass and exit. Same as the default.",
    )
    args = parser.parse_args(argv)
    company_id = os.environ.get("PAPERCLIP_COMPANY_ID", "").strip()
    if not company_id:
        print("error: PAPERCLIP_COMPANY_ID is required", file=sys.stderr)
        return 1
    base = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100").strip()
    if not base:
        base = "http://127.0.0.1:3100"
    api_key = os.environ.get("PAPERCLIP_API_KEY", "").strip()
    api = Paperclip(base, company_id, api_key, args.dry_run)
    sources, alive = scan_sources()
    projects = as_list(api.get(f"/api/companies/{company_id}/projects"), "projects")
    agents = as_list(api.get(f"/api/companies/{company_id}/agents"), "agents")
    projects_by_name = index_by_name(projects, project_owned)
    agents_by_name = index_by_name(agents, agent_owned)
    for source in sources:
        reconcile_project(api, source, projects_by_name.get(source["name"]))
        reconcile_agent(api, source, agents_by_name.get(source["name"]))
    cancel_stale(api, projects, agents, alive)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
