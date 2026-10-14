#!/usr/bin/env python3
# Sync Jira issues into a local Paperclip instance, and optionally push a
# daily attention digest to flomo.
#
# Usage
#   python3 /Users/txie/scripts/paperclip-jira-sync.py [sync|digest] [--dry-run]
#
#   sync     Default. Create missing epics and stories, then mark done the
#            issues Jira resolved in the last 14 days.
#   digest   Read Paperclip in_review/blocked issues and pending approvals,
#            append the last sync status, and POST the memo to flomo.
#   --dry-run
#            Print the plan. sync does not call Paperclip and does not write
#            state. digest does not POST to flomo. digest still reads Paperclip.
#
# Environment
#   PAPERCLIP_API_URL       Default http://127.0.0.1:3100
#   PAPERCLIP_COMPANY_ID    Required.
#   PAPERCLIP_API_KEY       Optional. Sent as Authorization Bearer when set.
#   PAPERCLIP_GOAL_ID       Optional. Added to every created issue.
#   SYNC_JQL                Default
#                           project = LUOB AND assignee = currentUser() AND resolution = Unresolved AND updated >= -120d ORDER BY updated DESC
#   SYNC_DONE_JQL           Default
#                           assignee = currentUser() AND resolution != Unresolved AND updated >= -14d
#   FLOMO_WEBHOOK_URL       Optional override for the digest webhook.
#                           Otherwise FLOMO_API_URL, then ~/.claude/flomo-config.json key api_url.
#
# Jira auth is read from
#   /Users/txie/roblox-ghc/CeLLM/tokens/atlassian/session.env
#   key ATLASSIAN_SESSION_COOKIE. The value is never logged.
#
# State
#   ~/.paperclip-jira-sync/state.json
#   issues maps jiraKey to {issueId, lastSyncedAt, jiraStatus}.
#   lastSync is separate so a ticket key cannot collide with run metadata.
#
# cron
#   PAPERCLIP_COMPANY_ID=<uuid> /usr/bin/python3 /Users/txie/scripts/paperclip-jira-sync.py sync
#   PAPERCLIP_COMPANY_ID=<uuid> /usr/bin/python3 /Users/txie/scripts/paperclip-jira-sync.py digest
#
# launchd ProgramArguments
#   /usr/bin/python3
#   /Users/txie/scripts/paperclip-jira-sync.py
#   sync
#   Set PAPERCLIP_COMPANY_ID in EnvironmentVariables. Keep StandardOutPath
#   if you want the ISO log lines.

from __future__ import annotations

import argparse
import fcntl
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

JIRA_BASE = "https://roblox.atlassian.net"
JIRA_BROWSE = "https://roblox.atlassian.net/browse"
SESSION_ENV = Path("/Users/txie/roblox-ghc/CeLLM/tokens/atlassian/session.env")
STATE_DIR = Path.home() / ".paperclip-jira-sync"
STATE_PATH = STATE_DIR / "state.json"
LOCK_PATH = STATE_DIR / "state.lock"
TIMEOUT = 60
SEARCH_FIELDS = "summary,status,priority,issuetype,parent,updated,description"
# parent is not in the brief's epic GET list. A fetched middle node is often a
# story, and the walk to its epic needs that field. The search already asks for it.
EPIC_FIELDS = "summary,status,priority,issuetype,parent,updated,description"
# Defaults must match the launchd policy. A bare manual run is then safe.
OPEN_JQL = "project = LUOB AND assignee = currentUser() AND resolution = Unresolved AND updated >= -120d ORDER BY updated DESC"
DONE_JQL = "project = LUOB AND assignee = currentUser() AND resolution != Unresolved AND updated >= -14d"
COOKIE_ERROR = (
    "Jira cookie 已失效，请先运行 python3 ~/.cursor/skills/atlassian-api/scripts/atlassian_cookie_sync.py"
)
DESC_LIMIT = 2000
MAX_SEARCH_PAGES = 200

# Unknown names stay low. Jira Cloud's own scale uses Highest/High/Medium, and
# some Luobu projects name the same ranks P0/P1/P2.
PRIORITY_MAP = {
    "p0": "critical",
    "highest": "critical",
    "p1": "high",
    "high": "high",
    "p2": "medium",
    "medium": "medium",
}


class CookieExpired(Exception):
    pass


class HttpFailure(Exception):
    def __init__(self, status: int, snippet: str):
        self.status = status
        self.snippet = snippet
        super().__init__(f"http {status} {snippet}")


@dataclass(frozen=True)
class JiraTicket:
    key: str
    summary: str
    status_name: str
    priority_name: str
    issue_type: str
    parent_key: str | None
    description: str

    def is_epic(self) -> bool:
        return self.issue_type.strip().lower() == "epic"


@dataclass(frozen=True)
class Config:
    api_url: str
    company_id: str
    api_key: str | None
    goal_id: str | None
    sync_jql: str
    done_jql: str


def log(message: str) -> None:
    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    print(f"{stamp} {message}", flush=True)


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def load_config() -> Config:
    company_id = os.environ.get("PAPERCLIP_COMPANY_ID", "").strip()
    if not company_id:
        log("error missing PAPERCLIP_COMPANY_ID")
        raise SystemExit(1)
    api_url = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100").strip().rstrip("/")
    return Config(
        api_url=api_url,
        company_id=company_id,
        api_key=os.environ.get("PAPERCLIP_API_KEY", "").strip() or None,
        goal_id=os.environ.get("PAPERCLIP_GOAL_ID", "").strip() or None,
        sync_jql=os.environ.get("SYNC_JQL", "").strip() or OPEN_JQL,
        done_jql=os.environ.get("SYNC_DONE_JQL", "").strip() or DONE_JQL,
    )


def load_cookie() -> str:
    if not SESSION_ENV.is_file():
        log(f"error jira session file missing path={SESSION_ENV}")
        raise SystemExit(1)
    found = ""
    for raw in SESSION_ENV.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() != "ATLASSIAN_SESSION_COOKIE":
            continue
        found = value.strip().strip('"').strip("'")
    if not found:
        log("error ATLASSIAN_SESSION_COOKIE missing from session file")
        raise SystemExit(1)
    return found


def flomo_webhook() -> str | None:
    url = os.environ.get("FLOMO_WEBHOOK_URL", "").strip() or os.environ.get("FLOMO_API_URL", "").strip()
    if url:
        return url
    path = Path.home() / ".claude" / "flomo-config.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log(f"warning flomo config unreadable {exc.__class__.__name__}")
        return None
    if isinstance(data, dict) and isinstance(data.get("api_url"), str) and data["api_url"].strip():
        return data["api_url"].strip()
    return None


def request_json(method: str, url: str, headers: dict[str, str], body: dict | None = None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read() or b""
        raise HttpFailure(exc.code, raw.decode("utf-8", "replace")[:200]) from None
    except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
        reason = getattr(exc, "reason", exc)
        raise HttpFailure(0, str(reason)[:200]) from None
    if not raw:
        return status, None
    text = raw.decode("utf-8", "replace")
    try:
        return status, json.loads(text)
    except json.JSONDecodeError:
        raise HttpFailure(status, text[:200]) from None


def jira_get(cookie: str, path: str):
    headers = {
        "Cookie": f"cloud.session.token={cookie}",
        "X-Atlassian-Token": "no-check",
        "Accept": "application/json",
    }
    try:
        _status, payload = request_json("GET", JIRA_BASE + path, headers)
    except HttpFailure as exc:
        if exc.status == 401:
            log(COOKIE_ERROR)
            raise CookieExpired() from None
        raise
    return payload


def adf_to_text(node) -> str:
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_to_text(item) for item in node)
    if not isinstance(node, dict):
        return ""
    kind = node.get("type")
    if kind == "text":
        return str(node.get("text") or "")
    if kind == "hardBreak":
        return "\n"
    if kind == "mention":
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        return str(attrs.get("text") or "")
    inner = "".join(adf_to_text(child) for child in node.get("content") or [])
    if kind in {"paragraph", "heading", "blockquote", "listItem", "codeBlock"}:
        return inner.rstrip("\n") + "\n"
    return inner


def map_priority(name: str) -> str:
    return PRIORITY_MAP.get(name.strip().lower(), "low")


def parse_ticket(raw: dict) -> JiraTicket:
    fields = raw.get("fields") if isinstance(raw.get("fields"), dict) else {}
    parent = fields.get("parent") if isinstance(fields.get("parent"), dict) else {}
    status = fields.get("status") if isinstance(fields.get("status"), dict) else {}
    priority = fields.get("priority") if isinstance(fields.get("priority"), dict) else {}
    issue_type = fields.get("issuetype") if isinstance(fields.get("issuetype"), dict) else {}
    summary = str(fields.get("summary") or "").replace("\n", " ").strip()
    key = str(raw.get("key") or "")
    return JiraTicket(
        key=key,
        summary=summary or key,
        status_name=str(status.get("name") or ""),
        priority_name=str(priority.get("name") or ""),
        issue_type=str(issue_type.get("name") or ""),
        parent_key=str(parent["key"]) if parent.get("key") else None,
        description=adf_to_text(fields.get("description")).strip(),
    )


def search_jql(cookie: str, jql: str) -> list[dict]:
    issues: list[dict] = []
    token = None
    seen: set[str] = set()
    for _ in range(MAX_SEARCH_PAGES):
        params = {"jql": jql, "maxResults": "100", "fields": SEARCH_FIELDS}
        if token:
            params["nextPageToken"] = token
        payload = jira_get(cookie, "/rest/api/3/search/jql?" + urllib.parse.urlencode(params))
        if not isinstance(payload, dict):
            raise HttpFailure(200, "jira search payload is not an object")
        batch = payload.get("issues")
        if not isinstance(batch, list):
            raise HttpFailure(200, "jira search payload missing issues")
        issues.extend(item for item in batch if isinstance(item, dict))
        if payload.get("isLast") is True:
            break
        nxt = payload.get("nextPageToken")
        if not isinstance(nxt, str) or not nxt or nxt in seen:
            break
        seen.add(nxt)
        token = nxt
    return issues


def collect_tickets(cookie: str, jql: str) -> dict[str, JiraTicket]:
    tickets: dict[str, JiraTicket] = {}
    for raw in search_jql(cookie, jql):
        ticket = parse_ticket(raw)
        if ticket.key:
            tickets[ticket.key] = ticket
    missing = sorted({t.parent_key for t in tickets.values() if t.parent_key and t.parent_key not in tickets})
    for key in missing:
        path = "/rest/api/3/issue/" + urllib.parse.quote(key) + "?" + urllib.parse.urlencode({"fields": EPIC_FIELDS})
        try:
            raw = jira_get(cookie, path)
        except HttpFailure as exc:
            log(f"error fetch parent {key} http {exc.status} {exc.snippet}")
            continue
        if isinstance(raw, dict):
            ticket = parse_ticket(raw)
            if ticket.key:
                tickets[ticket.key] = ticket
                log(f"fetched parent {ticket.key} type={ticket.issue_type or '-'}")
    return tickets


def order_tickets(tickets: dict[str, JiraTicket]) -> list[JiraTicket]:
    pending = set(tickets)
    ordered: list[JiraTicket] = []
    while pending:
        ready = sorted(
            key
            for key in pending
            if not (
                tickets[key].parent_key
                and not tickets[key].is_epic()
                and tickets[key].parent_key in pending
            )
        )
        if not ready:
            log("warning jira parent cycle, creating remaining keys in key order")
            ready = sorted(pending)
        for key in ready:
            ordered.append(tickets[key])
            pending.remove(key)
    return ordered


def empty_state() -> dict:
    return {"issues": {}, "lastSync": None}


def load_state() -> dict:
    if not STATE_PATH.exists():
        return empty_state()
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log(f"error state unreadable {exc.__class__.__name__}")
        raise SystemExit(1) from None
    if not isinstance(data, dict) or not isinstance(data.get("issues"), dict):
        log("error state.json issues map missing, refusing to overwrite")
        raise SystemExit(1)
    data.setdefault("lastSync", None)
    return data


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".json.tmp")
    payload = json.dumps(state, ensure_ascii=False, indent=2).encode("utf-8")
    with tmp.open("wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, STATE_PATH)


@contextmanager
def state_lock(exclusive: bool):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    handle = LOCK_PATH.open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def mapped_issue_id(state: dict, key: str) -> str | None:
    record = state["issues"].get(key)
    if record is None:
        return None
    if not isinstance(record, dict) or not isinstance(record.get("issueId"), str) or not record["issueId"]:
        log(f"error state record {key} missing issueId")
        raise SystemExit(1)
    return record["issueId"]


def remember(state: dict, ticket: JiraTicket, issue_id: str, dry_run: bool) -> None:
    state["issues"][ticket.key] = {
        "issueId": issue_id,
        "lastSyncedAt": now_iso(),
        "jiraStatus": ticket.status_name,
    }
    # The server forgets idempotency keys after 7 days. The local map is the
    # identity that survives that window, so persist before the next ticket.
    if not dry_run:
        save_state(state)


def note_run(state: dict, ok: bool, error: str | None, created: int, closed: int, skipped: int, dry_run: bool) -> None:
    state["lastSync"] = {
        "at": now_iso(),
        "ok": ok,
        "error": error,
        "created": created,
        "closed": closed,
        "skipped": skipped,
    }
    if not dry_run:
        save_state(state)


def paperclip_headers(cfg: Config) -> dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if cfg.api_key:
        headers["Authorization"] = f"Bearer {cfg.api_key}"
    return headers


def create_body(cfg: Config, ticket: JiraTicket, parent_id: str | None) -> dict:
    text = ticket.description[:DESC_LIMIT]
    link = f"{JIRA_BROWSE}/{ticket.key}"
    description = f"Jira: {link}\n\n{text}" if text else f"Jira: {link}"
    body = {
        "title": f"[{ticket.key}] {ticket.summary}",
        "description": description,
        "status": "todo",
        "priority": map_priority(ticket.priority_name),
        # Same title with a different idempotency key is merged for 48 hours
        # unless this flag is set. The key still replays the original issue.
        "allowDuplicate": True,
        "idempotencyKey": f"jira:{ticket.key}",
    }
    if parent_id:
        body["parentId"] = parent_id
    if cfg.goal_id:
        body["goalId"] = cfg.goal_id
    return body


def parent_id_for(state: dict, ticket: JiraTicket) -> str | None:
    if ticket.is_epic() or not ticket.parent_key:
        return None
    return mapped_issue_id(state, ticket.parent_key)


def run_sync(cfg: Config, dry_run: bool) -> None:
    cookie = load_cookie()
    stats = {"created": 0, "closed": 0, "skipped": 0}
    if dry_run:
        state = load_state() if STATE_PATH.exists() else empty_state()
        sync_body(cfg, cookie, state, stats, dry_run=True)
        return
    with state_lock(True):
        state = load_state()
        try:
            sync_body(cfg, cookie, state, stats, dry_run=False)
        except CookieExpired:
            note_run(state, False, COOKIE_ERROR, stats["created"], stats["closed"], stats["skipped"], dry_run=False)
            raise
        except (HttpFailure, OSError) as exc:
            note_run(state, False, str(exc)[:200], stats["created"], stats["closed"], stats["skipped"], dry_run=False)
            raise
        note_run(state, True, None, stats["created"], stats["closed"], stats["skipped"], dry_run=False)
        log(f"sync done created={stats['created']} closed={stats['closed']} skipped={stats['skipped']}")


def ticket_kind(ticket: JiraTicket) -> str:
    if ticket.is_epic():
        return "epic"
    if ticket.parent_key:
        return "story"
    return "root"


def parent_note(ticket: JiraTicket, parent_id: str | None) -> str:
    if parent_id:
        return ticket.parent_key or "-"
    if ticket.parent_key and not ticket.is_epic():
        return f"{ticket.parent_key} unlinked"
    return "-"


def sync_body(cfg: Config, cookie: str, state: dict, stats: dict, dry_run: bool) -> None:
    prefix = "dry-run " if dry_run else ""
    tickets = collect_tickets(cookie, cfg.sync_jql)
    for ticket in order_tickets(tickets):
        if mapped_issue_id(state, ticket.key):
            log(f"{prefix}skip {ticket.key} already mapped")
            stats["skipped"] += 1
            continue
        parent_id = parent_id_for(state, ticket)
        kind = ticket_kind(ticket)
        if dry_run:
            log(
                f"dry-run create {kind} {ticket.key} priority={map_priority(ticket.priority_name)} "
                f"parent={parent_note(ticket, parent_id)} title=[{ticket.key}] {ticket.summary}"
            )
            # In-memory only. A later story in this plan can see the parent link.
            remember(state, ticket, f"dry-run:{ticket.key}", dry_run=True)
            stats["created"] += 1
            continue
        body = create_body(cfg, ticket, parent_id)
        url = f"{cfg.api_url}/api/companies/{urllib.parse.quote(cfg.company_id)}/issues"
        status, payload = request_json("POST", url, paperclip_headers(cfg), body)
        if not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
            raise HttpFailure(status, "create response missing id")
        remember(state, ticket, payload["id"], dry_run=False)
        log(f"create {kind} {ticket.key} issueId={payload['id']} priority={body['priority']}")
        stats["created"] += 1

    for raw in search_jql(cookie, cfg.done_jql):
        ticket = parse_ticket(raw)
        issue_id = mapped_issue_id(state, ticket.key) if ticket.key else None
        if not ticket.key or not issue_id:
            continue
        # Dry-run creates live only in this process. Do not plan a close for them.
        if issue_id.startswith("dry-run:"):
            continue
        record = state["issues"][ticket.key]
        if record.get("jiraStatus") == ticket.status_name:
            log(f"{prefix}skip close {ticket.key} jiraStatus already {ticket.status_name}")
            stats["skipped"] += 1
            continue
        if dry_run:
            log(f"dry-run close {ticket.key} issueId={issue_id} jiraStatus={ticket.status_name}")
            stats["closed"] += 1
            continue
        url = f"{cfg.api_url}/api/issues/{urllib.parse.quote(issue_id)}"
        request_json(
            "PATCH",
            url,
            paperclip_headers(cfg),
            {"status": "done", "comment": f"Jira 侧已关闭 ({ticket.key} {ticket.status_name})"},
        )
        remember(state, ticket, issue_id, dry_run=False)
        log(f"close {ticket.key} issueId={issue_id}")
        stats["closed"] += 1
    if dry_run:
        log(
            f"dry-run plan created={stats['created']} closed={stats['closed']} skipped={stats['skipped']}"
        )


def paperclip_get(cfg: Config, path: str):
    return request_json("GET", cfg.api_url + path, paperclip_headers(cfg))[1]


def list_status_issues(cfg: Config) -> list[dict]:
    found: list[dict] = []
    offset = 0
    while offset <= 10000:
        query = urllib.parse.urlencode({"status": "in_review,blocked", "limit": "1000", "offset": str(offset)})
        payload = paperclip_get(cfg, f"/api/companies/{urllib.parse.quote(cfg.company_id)}/issues?{query}")
        if not isinstance(payload, list):
            raise HttpFailure(200, "issue list is not an array")
        found.extend(item for item in payload if isinstance(item, dict))
        if len(payload) < 1000:
            break
        offset += 1000
    return found


def issue_prefix(cfg: Config, issues: list[dict]) -> str:
    payload = paperclip_get(cfg, f"/api/companies/{urllib.parse.quote(cfg.company_id)}")
    if isinstance(payload, dict) and isinstance(payload.get("issuePrefix"), str) and payload["issuePrefix"]:
        return payload["issuePrefix"]
    for issue in issues:
        identifier = issue.get("identifier")
        if isinstance(identifier, str) and "-" in identifier:
            return identifier.split("-", 1)[0]
    return ""


def issue_link(cfg: Config, prefix: str, issue: dict) -> str:
    identifier = issue.get("identifier") if isinstance(issue.get("identifier"), str) else ""
    token = identifier or (issue.get("id") if isinstance(issue.get("id"), str) else "")
    used = prefix
    if not used and "-" in identifier:
        used = identifier.split("-", 1)[0]
    if used and token:
        return f"{cfg.api_url}/{used}/issues/{token}"
    return cfg.api_url


def format_sync_status(state: dict) -> str:
    last = state.get("lastSync")
    if not isinstance(last, dict):
        return "上次同步: 尚无记录"
    error = last.get("error") or "-"
    return (
        f"上次同步: {last.get('at') or '-'} ok={last.get('ok')} "
        f"created={last.get('created', 0)} closed={last.get('closed', 0)} "
        f"skipped={last.get('skipped', 0)} error={error}"
    )


def build_digest(cfg: Config, state: dict) -> str:
    issues = list_status_issues(cfg)
    prefix = issue_prefix(cfg, issues)
    approvals = paperclip_get(
        cfg, f"/api/companies/{urllib.parse.quote(cfg.company_id)}/approvals?status=pending"
    )
    if not isinstance(approvals, list):
        raise HttpFailure(200, "approval list is not an array")
    lines = [
        "#jira/digest #paperclip",
        f"Paperclip 注意力 {datetime.now().astimezone().date().isoformat()}",
        "",
        f"in_review/blocked ({len(issues)})",
    ]
    if not issues:
        lines.append("- 无")
    for issue in issues:
        identifier = issue.get("identifier") or issue.get("id") or "?"
        title = str(issue.get("title") or "").replace("\n", " ")
        lines.append(f"- {identifier} {title} {issue_link(cfg, prefix, issue)}")
    lines.append("")
    lines.append(f"pending approvals ({len(approvals)})")
    if not approvals:
        lines.append("- 无")
    for approval in approvals:
        if not isinstance(approval, dict):
            continue
        payload = approval.get("payload") if isinstance(approval.get("payload"), dict) else {}
        label = payload.get("title") or payload.get("name") or approval.get("type") or "approval"
        approval_id = approval.get("id") or "?"
        link = f"{cfg.api_url}/{prefix}/approvals/{approval_id}" if prefix else str(approval_id)
        lines.append(f"- {approval.get('type') or 'approval'} {label} {link}")
    lines.append("")
    lines.append(format_sync_status(state))
    return "\n".join(lines)


def post_flomo(url: str, content: str) -> None:
    try:
        _status, payload = request_json(
            "POST",
            url,
            {"Accept": "application/json", "Content-Type": "application/json"},
            {"content": content},
        )
    except HttpFailure as exc:
        log(f"warning flomo unreachable http {exc.status} {exc.snippet}")
        return
    if isinstance(payload, dict) and payload.get("code") not in (None, 0):
        message = str(payload.get("message") or payload.get("code"))[:200]
        log(f"warning flomo rejected {message}")
        return
    log("digest sent")


def run_digest(cfg: Config, dry_run: bool) -> None:
    state = load_state() if STATE_PATH.exists() else empty_state()
    memo = build_digest(cfg, state)
    if dry_run:
        print(memo, flush=True)
        log("dry-run digest not sent")
        return
    url = flomo_webhook()
    if not url:
        log("warning flomo webhook missing, digest not sent")
        return
    post_flomo(url, memo)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync Jira issues into local Paperclip")
    parser.add_argument("mode", nargs="?", default="sync", choices=("sync", "digest"))
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    cfg = load_config()
    try:
        if args.mode == "digest":
            run_digest(cfg, args.dry_run)
        else:
            run_sync(cfg, args.dry_run)
    except CookieExpired:
        return 2
    except HttpFailure as exc:
        log(f"error http {exc.status} {exc.snippet}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
