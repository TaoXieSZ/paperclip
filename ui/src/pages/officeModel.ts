// One meeting table per root work item. State is a single field so a table
// cannot be both in session and adjourned.

const JIRA_RE = /^\[([A-Z]+-\d+)\]/;
const ENV_RE = /luobutest|luobustage/i;
const STALE_AFTER_SEC = 600;

export type MeetingState = "live" | "stale" | "done";

export type OfficeSeat = {
  name: string;
  url: string | null;
};

export type OfficeChild = {
  identifier: string | null;
  title: string;
  status: string;
};

export type OfficeMeeting = {
  id: string;
  identifier: string;
  title: string;
  issuePath: string | null;
  jiraKey: string | null;
  jiraStatus: string | null;
  env: string | null;
  state: MeetingState;
  statusMessage: string | null;
  tool: string | null;
  snippet: string | null;
  lastOutputAt: string | null;
  avatars: OfficeSeat[];
  children: OfficeChild[];
  kidsDone: number;
  priority: string;
  sessionStartedAt: string | null;
  silenceSec: number;
};

export type OfficeAttention = {
  key: string;
  title: string | null;
  href: string | null;
  whyNow: string;
};

export type OfficeModel = {
  meetings: OfficeMeeting[];
  lounge: OfficeSeat[];
  attention: OfficeAttention[];
};

export type OfficeIssue = {
  id: string;
  parentId: string | null;
  title: string;
  identifier: string | null;
  status: string;
  priority: string;
};

export type OfficeRun = {
  status: string;
  issueId?: string | null;
  agentName: string;
  avatarUrl?: string | null;
  agentAppearance?: { avatarUrl?: string | null } | null;
  startedAt?: string | null;
  outputSilence?: unknown;
  currentStatusMessage?: string | null;
  livenessReason?: string | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  lastOutputAt?: string | null;
};

export type OfficeAgent = {
  name: string;
  status: string;
  avatarUrl?: string | null;
};

export type OfficeAttentionInput = {
  items?: Array<{
    dedupKey?: string | null;
    whyNow?: string | null;
    subject?: {
      id?: string | null;
      title?: string | null;
      href?: string | null;
    } | null;
  }>;
};

export function silenceSec(value: unknown): number {
  if (typeof value === "number") return value;
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  // Live-runs returns silenceAgeMs. The sidecar also accepted seconds/secs/value/ms.
  if (typeof record.silenceAgeMs === "number") return record.silenceAgeMs / 1000;
  for (const key of ["seconds", "secs", "value", "ms"] as const) {
    const entry = record[key];
    if (typeof entry === "number") return key === "ms" ? entry / 1000 : entry;
  }
  return 0;
}

export function rootOf(issue: OfficeIssue, byId: Map<string, OfficeIssue>): OfficeIssue {
  const seen = new Set<string>();
  let cur: OfficeIssue | undefined = issue;
  while (cur && cur.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
  }
  return cur ?? issue;
}

export function groupState(runs: OfficeRun[]): MeetingState {
  const running = runs.filter((run) => run.status === "running");
  if (running.length === 0) return "done";
  const stale = running.every((run) => silenceSec(run.outputSilence) > STALE_AFTER_SEC);
  return stale ? "stale" : "live";
}

function outputStamp(run: OfficeRun): string {
  if (typeof run.lastOutputAt === "string" && run.lastOutputAt) return run.lastOutputAt;
  if (!run.outputSilence || typeof run.outputSilence !== "object") return "";
  const value = (run.outputSilence as { lastOutputAt?: unknown }).lastOutputAt;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return "";
}

function seatUrl(run: OfficeRun): string | null {
  if (run.avatarUrl) return run.avatarUrl;
  const url = run.agentAppearance?.avatarUrl;
  return url || null;
}

function attentionOf(feed: OfficeAttentionInput | null | undefined): OfficeAttention[] {
  return (feed?.items ?? []).map((item) => ({
    key: item.dedupKey || item.subject?.id || "",
    title: item.subject?.title ?? null,
    href: item.subject?.href ?? null,
    whyNow: item.whyNow ?? "",
  }));
}

export function buildOfficeModel(input: {
  runs: OfficeRun[];
  issues: OfficeIssue[];
  agents: OfficeAgent[];
  attention?: OfficeAttentionInput | null;
}): OfficeModel {
  const byId = new Map(input.issues.map((issue) => [issue.id, issue]));
  const groups = new Map<string, OfficeRun[]>();
  for (const run of input.runs) {
    const issue = run.issueId ? byId.get(run.issueId) : undefined;
    if (!issue) continue;
    const root = rootOf(issue, byId);
    const list = groups.get(root.id) ?? [];
    list.push(run);
    groups.set(root.id, list);
  }

  const meetings: OfficeMeeting[] = [];
  for (const [rootId, gruns] of groups) {
    const root = byId.get(rootId);
    if (!root) continue;
    const title = root.title || "(unknown)";
    const jira = JIRA_RE.exec(title);
    const env = ENV_RE.exec(title);
    const stripped = title.replace(JIRA_RE, "").trim();
    const latest = gruns.reduce((best, run) => (outputStamp(run) > outputStamp(best) ? run : best));
    const seats = new Map<string, OfficeSeat>();
    for (const run of gruns) {
      const name = run.agentName || "?";
      seats.set(name, { name, url: seatUrl(run) });
    }
    const kidsAll = input.issues.filter((issue) => issue.parentId === rootId && issue.status !== "cancelled");
    const running = gruns.filter((run) => run.status === "running");
    const started = running
      .map((run) => run.startedAt)
      .filter((value): value is string => !!value)
      .sort()[0] ?? null;
    const silence = running.reduce((max, run) => Math.max(max, silenceSec(run.outputSilence)), 0);
    const identifier = root.identifier || "?";
    meetings.push({
      id: rootId,
      identifier,
      title: stripped || title,
      issuePath: root.identifier ? `/issues/${root.identifier}` : null,
      jiraKey: jira?.[1] ?? null,
      jiraStatus: root.status || null,
      env: env?.[0] ?? null,
      state: groupState(gruns),
      statusMessage: latest.currentStatusMessage || latest.livenessReason || null,
      tool: latest.currentToolName ?? null,
      snippet: latest.lastAssistantSnippet ?? null,
      lastOutputAt: outputStamp(latest) || null,
      avatars: [...seats.values()],
      children: kidsAll.map((child) => ({
        identifier: child.identifier,
        title: child.title,
        status: child.status,
      })),
      kidsDone: kidsAll.filter((child) => child.status === "done").length,
      priority: root.priority,
      sessionStartedAt: started,
      silenceSec: silence,
    });
  }

  const order: Record<MeetingState, number> = { live: 0, stale: 1, done: 2 };
  meetings.sort((a, b) => order[a.state] - order[b.state] || b.children.length - a.children.length);

  return {
    meetings,
    lounge: input.agents
      .filter((agent) => agent.status !== "running" && agent.status !== "paused")
      .map((agent) => ({ name: agent.name, url: agent.avatarUrl ?? null })),
    attention: attentionOf(input.attention),
  };
}
