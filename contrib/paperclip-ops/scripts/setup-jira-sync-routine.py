#!/usr/bin/env python3
"""Install or update the "同步 Jira 工单" routine in a local paperclip instance.

Idempotent: matches an existing routine by title and updates it, otherwise
creates it. Run after editing the routine description or when onboarding a
new instance.

Usage:
  PAPERCLIP_COMPANY_ID=<uuid> python3 setup-jira-sync-routine.py
Env:
  PAPERCLIP_API_URL       Default http://127.0.0.1:3100
  PAPERCLIP_COMPANY_ID    Required.
  PAPERCLIP_API_KEY       Optional Bearer token.
  SYNC_AGENT_ID           Assignee agent. Required on first create.
"""
import json
import os
import sys
import urllib.request

TITLE = "同步 Jira 工单"
DESCRIPTION = """手动触发的 Jira → paperclip 同步。

执行步骤:
1. 在 shell 运行: PAPERCLIP_COMPANY_ID={company_id} /usr/bin/python3 <SCRIPTS_DIR>/paperclip-jira-sync.py sync
2. 把输出末尾的 sync done 行(created/closed/skipped 数)和任何 error/warn 贴进本 issue 评论。
3. exit 2 = Jira cookie 失效:评论提醒 board 刷新 cookie,然后把本 issue 置 blocked。
4. 正常完成则标 done,评论一行总结(新建/关闭/跳过数量 + 新建票的 identifier 列表)。"""


def api(base, key, method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw else None


def main():
    base = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100").rstrip("/")
    cid = os.environ.get("PAPERCLIP_COMPANY_ID", "").strip()
    key = os.environ.get("PAPERCLIP_API_KEY", "").strip() or None
    if not cid:
        print("error: PAPERCLIP_COMPANY_ID is required", file=sys.stderr)
        return 1
    description = DESCRIPTION.format(company_id=cid).replace("<SCRIPTS_DIR>", os.environ.get("SCRIPTS_DIR", "/Users/txie/scripts"))
    routines = api(base, key, "GET", f"/api/companies/{cid}/routines")
    existing = next((r for r in (routines or []) if r.get("title") == TITLE), None)
    if existing:
        api(base, key, "PATCH", f"/api/routines/{existing['id']}", {"description": description})
        print(f"updated routine {existing['id']} ({TITLE})")
        return 0
    agent_id = os.environ.get("SYNC_AGENT_ID", "").strip()
    if not agent_id:
        print("error: SYNC_AGENT_ID is required on first create", file=sys.stderr)
        return 1
    created = api(base, key, "POST", f"/api/companies/{cid}/routines", {
        "title": TITLE,
        "description": description,
        "assigneeAgentId": agent_id,
        "priority": "low",
        "status": "active",
        "concurrencyPolicy": "coalesce_if_active",
    })
    print(f"created routine {created['id']} ({TITLE})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
