import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { attentionApi } from "../api/attention";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { queryKeys } from "../lib/queryKeys";
import { applyCompanyPrefix } from "@/lib/company-routes";
import { Link, useActiveCompanyPrefix, useNavigate } from "@/lib/router";
import {
  buildOfficeModel,
  type MeetingState,
  type OfficeAgent,
  type OfficeAttention,
  type OfficeIssue,
  type OfficeMeeting,
  type OfficeRun,
  type OfficeSeat,
} from "./officeModel";

const SEEN_KEY = "office.attn.seen";
const REFRESH_MS = 8_000;

const OFFICE_CSS = `
.office-root { font: 14px/1.5 InterVariable, -apple-system, "PingFang SC", sans-serif; background: #f3f1ed; color: #18181b; min-height: 100%; }
.office-root * { box-sizing: border-box; }
.office-root .wall { height: 64px; padding: 0 24px; background: #fff; border-bottom: 1px solid #e4e4e7; display: flex; align-items: center; gap: 14px; }
.office-root .wall img.wordmark { height: 24px; width: auto; }
.office-root .wall .page-name { font-size: 16px; font-weight: 600; }
.office-root .wall .spacer { flex: 1; }
.office-root .whiteboard { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #52525b; border: 2px solid #d6d3d1; border-radius: 8px; padding: 5px 12px; background: #fefce8; }
.office-root .attnchip { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: #b91c1c; border: 2px solid #fecaca; border-radius: 8px; padding: 5px 12px; background: #fef2f2; cursor: pointer; font-family: inherit; }
.office-root .attnchip:hover { background: #fee2e2; }
.office-root .attnchip .dot { background: #dc2626; }
.office-root .podium { grid-column: 1/-1; border: 2px solid #fecaca; background: #fef2f2; border-radius: 16px; padding: 14px 18px; }
.office-root .podium h3 { margin: 0; font-size: 12px; font-weight: 600; color: #b91c1c; letter-spacing: .05em; }
.office-root .podium .item { display: flex; align-items: center; gap: 10px; background: #fff; border: 1px solid #fecaca; border-radius: 10px; padding: 10px 14px; cursor: pointer; margin-top: 10px; }
.office-root .podium .item:hover { border-color: #fca5a5; box-shadow: 0 1px 4px rgba(185, 28, 28, .12); }
.office-root .podium .item .t { font-size: 14px; font-weight: 600; color: #18181b; }
.office-root .podium .item .w { font-size: 12px; color: #71717a; margin-top: 2px; }
.office-root .podium .item .go { margin-left: auto; flex: none; color: #b91c1c; font-size: 12px; font-weight: 600; }
.office-root .podium .acts { margin-left: auto; flex: none; display: flex; align-items: center; gap: 8px; }
.office-root .podium .acts button { font-size: 12px; font-weight: 600; border-radius: 7px; padding: 4px 12px; cursor: pointer; font-family: inherit; }
.office-root .podium .acts .ok { background: #16a34a; color: #fff; border: 1px solid #15803d; }
.office-root .podium .acts .ok:hover { background: #15803d; }
.office-root .podium .acts .no { background: #fff; color: #b91c1c; border: 1px solid #fca5a5; }
.office-root .podium .acts .no:hover { background: #fef2f2; }
.office-root .podium .acts button:disabled { opacity: .5; cursor: default; }
.office-root .podium .acts .reasoninput { font-size: 12px; padding: 4px 8px; border: 1px solid #fca5a5; border-radius: 7px; font-family: inherit; width: 180px; }
.office-root .podium .decided { margin-left: auto; flex: none; color: #15803d; font-size: 12px; font-weight: 600; }
.office-root .notifybtn { font-size: 12px; color: #71717a; border: 1px solid #e4e4e7; border-radius: 7px; padding: 4px 9px; background: #fff; cursor: pointer; font-family: inherit; }
.office-root .notifybtn:hover { background: #f4f4f5; }
.office-root .dot { width: 8px; height: 8px; border-radius: 50%; background: #16a34a; }
.office-root .dot.off { background: #a1a1aa; }
.office-root .updated { font-size: 12px; color: #a1a1aa; }
.office-root .floor { max-width: 1200px; margin: 0 auto; padding: 34px 24px 60px; display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 40px 28px; }
.office-root .zone { position: relative; padding-top: 30px; }
.office-root .bubble { position: absolute; top: 0; left: 16px; right: 16px; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 6px 12px; font-size: 12.5px; color: #3f3f46; box-shadow: 0 1px 2px rgba(0,0,0,.05); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.office-root .bubble:after { content: ''; position: absolute; left: 28px; bottom: -6px; width: 10px; height: 10px; background: #fff; border-right: 1px solid #e4e4e7; border-bottom: 1px solid #e4e4e7; transform: rotate(45deg); }
.office-root .bubble .tool { color: #b45309; font-weight: 500; }
.office-root table.conf { width: 100%; background: #fdf8ef; border: 1px solid #e3d9c6; border-radius: 16px; border-spacing: 0; border-collapse: separate; padding: 14px 16px 12px; box-shadow: 0 2px 6px rgba(0,0,0,.07); display: block; cursor: pointer; transition: box-shadow .15s; position: relative; }
.office-root table.conf:hover { box-shadow: 0 4px 14px rgba(0,0,0,.12); }
.office-root .zone.done table.conf { opacity: .5; }
.office-root .flame { position: absolute; top: -10px; right: 14px; font-size: 18px; filter: drop-shadow(0 1px 1px rgba(0,0,0,.2)); }
.office-root .timerchip { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 6px; background: #f4f4f5; border: 1px solid #e4e4e7; color: #52525b; }
.office-root .timerchip.hot { background: #fff7ed; border-color: #fed7aa; color: #c2410c; }
.office-root .pbar { height: 4px; background: #f0e9dc; border-radius: 999px; overflow: hidden; margin-top: 10px; }
.office-root .pbar i { display: block; height: 100%; background: #16a34a; border-radius: 999px; }
.office-root .bubble .quote { font-style: italic; color: #52525b; }
.office-root .t-head { display: flex; align-items: flex-start; gap: 10px; }
.office-root .t-title { font-size: 15.5px; font-weight: 600; line-height: 1.35; }
.office-root .t-title a { color: inherit; text-decoration: none; }
.office-root .t-title a:hover { text-decoration: underline; }
.office-root .badge { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 500; padding: 2px 9px; border-radius: 999px; border: 1px solid #e4e4e7; color: #52525b; background: #fafafa; }
.office-root .badge .dot { width: 7px; height: 7px; }
.office-root .badge.live { color: #15803d; border-color: #bbf7d0; background: #f0fdf4; }
.office-root .badge.live .dot { background: #16a34a; }
.office-root .badge.stale { color: #b45309; border-color: #fde68a; background: #fffbeb; }
.office-root .badge.stale .dot { background: #d97706; }
.office-root .badge.done { color: #52525b; }
.office-root .badge.done .dot { background: #a1a1aa; }
.office-root .meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; color: #71717a; margin-top: 6px; }
.office-root .meta a { color: #2563eb; text-decoration: none; }
.office-root .envtag { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 6px; background: #f4f4f5; border: 1px solid #e4e4e7; color: #52525b; }
.office-root .jirastatus { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 6px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1d4ed8; }
.office-root .seats { display: flex; justify-content: center; gap: 14px; margin-top: -2px; padding-top: 12px; }
.office-root .seat { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.office-root .seat img, .office-root .seat .fb { width: 34px; height: 34px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.15); background: #e4e4e7; }
.office-root .seat .fb { display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; color: #52525b; }
.office-root .seat .nm { font-size: 10.5px; color: #71717a; max-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.office-root .t-foot { display: flex; align-items: center; gap: 10px; font-size: 11.5px; color: #a1a1aa; border-top: 1px solid #f4f4f5; margin-top: 12px; padding-top: 8px; }
.office-root .kids { margin-left: auto; color: #71717a; cursor: pointer; user-select: none; background: none; border: 0; padding: 0; font: inherit; }
.office-root .kids:hover { color: #18181b; }
.office-root .kidlist { display: none; border-top: 1px dashed #e4e4e7; margin-top: 8px; padding-top: 8px; font-size: 12.5px; color: #52525b; }
.office-root .kidlist.open { display: block; }
.office-root .kidlist .kid { display: flex; gap: 8px; padding: 3px 0; }
.office-root .kidlist .kid .st { flex: none; color: #a1a1aa; width: 74px; }
.office-root .lounge { grid-column: 1 / -1; border: 2px dashed #d6d3d1; border-radius: 16px; padding: 16px 18px; background: rgba(255,255,255,.45); }
.office-root .lounge h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: #78716c; text-transform: uppercase; letter-spacing: .05em; }
.office-root .lounge .people { display: flex; flex-wrap: wrap; gap: 14px; }
.office-root .empty { color: #a8a29e; text-align: center; padding: 60px 0; grid-column: 1 / -1; }
`;

function ago(iso: string | null, now: number): string {
  if (!iso) return "-";
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d`;
}

function dur(seconds: number): string {
  if (!seconds) return "";
  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m`;
  return `${Math.floor(whole / 3600)}h${Math.floor((whole % 3600) / 60)}m`;
}

function sessionAge(iso: string | null, now: number): number {
  if (!iso) return 0;
  return Math.max(0, (now - new Date(iso).getTime()) / 1000);
}

function readSeen(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function notifyNew(items: OfficeAttention[], companyPrefix: string | null) {
  const keys = items.map((item) => item.key);
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    localStorage.setItem(SEEN_KEY, JSON.stringify(keys));
    return;
  }
  const seen = new Set(readSeen());
  const fresh = items.filter((item) => item.key && !seen.has(item.key));
  for (const item of fresh.slice(0, 3)) {
    const notification = new Notification("办公室 · 等你拍板", {
      body: item.title || item.whyNow || "",
      tag: item.key,
    });
    notification.onclick = () => {
      if (item.href) {
        const target = item.href.startsWith("/") ? applyCompanyPrefix(item.href, companyPrefix) : item.href;
        window.open(target, "_blank", "noopener");
      }
      notification.close();
    };
  }
  localStorage.setItem(SEEN_KEY, JSON.stringify(keys));
}

function toIssue(issue: Issue): OfficeIssue {
  return {
    id: issue.id,
    parentId: issue.parentId,
    title: issue.title,
    identifier: issue.identifier,
    status: issue.status,
    priority: issue.priority,
  };
}

function toRun(run: LiveRunForIssue): OfficeRun {
  const stamped = run.outputSilence?.lastOutputAt;
  const lastOutputAt = typeof stamped === "string"
    ? stamped
    : stamped instanceof Date
      ? stamped.toISOString()
      : null;
  return {
    status: run.status,
    issueId: run.issueId,
    agentName: run.agentName,
    avatarUrl: run.avatarUrl,
    startedAt: run.startedAt,
    outputSilence: run.outputSilence,
    currentStatusMessage: run.currentStatusMessage,
    livenessReason: run.livenessReason,
    currentToolName: run.currentToolName,
    lastAssistantSnippet: run.lastAssistantSnippet,
    lastOutputAt,
  };
}

function toAgent(agent: Agent): OfficeAgent {
  return { name: agent.name, status: agent.status, avatarUrl: agent.avatarUrl ?? null };
}

function StateBadge({ state }: { state: MeetingState }) {
  const label = state === "live" ? "讨论中" : state === "stale" ? "冷场" : "散会";
  return (
    <span className={`badge ${state}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

function Seat({ seat }: { seat: OfficeSeat }) {
  const initial = (seat.name || "?")[0] ?? "?";
  return (
    <div className="seat">
      {seat.url ? <img src={seat.url} title={seat.name} alt="" /> : <span className="fb" title={seat.name}>{initial}</span>}
      <span className="nm">{seat.name}</span>
    </div>
  );
}

function MeetingTable({
  meeting,
  now,
  kidsOpen,
  onToggleKids,
  onOpen,
}: {
  meeting: OfficeMeeting;
  now: number;
  kidsOpen: boolean;
  onToggleKids: () => void;
  onOpen: (path: string) => void;
}) {
  const quote = meeting.snippet || meeting.statusMessage;
  const hot = meeting.priority === "critical" || meeting.priority === "high";
  const progress = meeting.children.length
    ? Math.round((100 * meeting.kidsDone) / meeting.children.length)
    : 0;
  return (
    <div className={meeting.state === "done" ? "zone done" : "zone"}>
      {quote ? (
        <div className="bubble">
          {meeting.tool ? <span className="tool">⚙ {meeting.tool}</span> : null}
          {meeting.tool ? " · " : null}
          <span className="quote">{quote}</span>
        </div>
      ) : null}
      <table
        className="conf"
        onClick={(event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (target.closest("a, .kids, .kidlist")) return;
          if (meeting.issuePath) onOpen(meeting.issuePath);
        }}
      >
        <tbody>
          <tr>
            <td>
              {hot ? <span className="flame" title={meeting.priority}>🔥</span> : null}
              <div className="t-head">
                <div className="t-title">
                  {meeting.issuePath ? (
                    <Link to={meeting.issuePath}>{meeting.identifier} · {meeting.title}</Link>
                  ) : (
                    <span>{meeting.identifier} · {meeting.title}</span>
                  )}
                </div>
                <span style={{ flex: 1 }} />
                <StateBadge state={meeting.state} />
              </div>
              <div className="meta">
                {meeting.jiraKey ? (
                  <a href={`https://roblox.atlassian.net/browse/${meeting.jiraKey}`} target="_blank" rel="noreferrer">
                    {meeting.jiraKey}
                  </a>
                ) : null}
                {meeting.jiraStatus ? <span className="jirastatus">Jira: {meeting.jiraStatus}</span> : null}
                {meeting.env ? <span className="envtag">{meeting.env}</span> : null}
                {meeting.sessionStartedAt ? (
                  <span className="timerchip">已开 {dur(sessionAge(meeting.sessionStartedAt, now))}</span>
                ) : null}
                {meeting.state === "stale" && meeting.silenceSec ? (
                  <span className="timerchip hot">冷场 {dur(meeting.silenceSec)}</span>
                ) : null}
              </div>
              <div className="seats">{meeting.avatars.map((seat) => <Seat key={seat.name} seat={seat} />)}</div>
              {meeting.children.length ? (
                <div className="pbar"><i style={{ width: `${progress}%` }} /></div>
              ) : null}
              <div className="t-foot">
                <span>最后发言 {ago(meeting.lastOutputAt, now)}前</span>
                {meeting.children.length ? (
                  <button type="button" className="kids" onClick={onToggleKids}>
                    {kidsOpen ? "▾" : "▸"} {meeting.kidsDone}/{meeting.children.length} 议题
                  </button>
                ) : null}
              </div>
              {meeting.children.length ? (
                <div className={kidsOpen ? "kidlist open" : "kidlist"}>
                  {meeting.children.map((child) => (
                    <div className="kid" key={child.identifier ?? child.title}>
                      <span className="st">{child.status}</span>
                      <span>{child.identifier} · {child.title}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function Office() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const companyPrefix = useActiveCompanyPrefix();
  const [now, setNow] = useState(() => Date.now());
  const [openKids, setOpenKids] = useState<ReadonlySet<string>>(() => new Set());
  const [notifyVisible, setNotifyVisible] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);
  const [rejectingKey, setRejectingKey] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [decidedKeys, setDecidedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const queryClient = useQueryClient();

  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId,
    refetchInterval: false,
    leaderOnly: true,
  });
  const liveRunsQuery = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRunsQuery.data, liveRunsQuery.dataUpdatedAt);

  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: REFRESH_MS,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: REFRESH_MS,
  });
  const attentionQuery = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: REFRESH_MS,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Office" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setNotifyVisible(typeof Notification !== "undefined" && Notification.permission === "default");
  }, []);

  const model = useMemo(
    () => buildOfficeModel({
      runs: (liveRunsQuery.data ?? []).map(toRun),
      issues: (issuesQuery.data ?? []).map(toIssue),
      agents: (agentsQuery.data ?? []).map(toAgent),
      attention: attentionQuery.data,
    }),
    [liveRunsQuery.data, issuesQuery.data, agentsQuery.data, attentionQuery.data],
  );

  useEffect(() => {
    if (!attentionQuery.isSuccess) return;
    notifyNew(model.attention, companyPrefix);
  }, [attentionQuery.isSuccess, attentionQuery.dataUpdatedAt, model.attention, companyPrefix]);

  const liveCount = model.meetings.filter((meeting) => meeting.state === "live").length;
  const active = model.meetings.filter((meeting) => meeting.state !== "done");
  const done = model.meetings.filter((meeting) => meeting.state === "done");
  async function decide(a: OfficeAttention, verdict: "accept" | "reject", reason?: string) {
    if (!a.issueId || !a.interactionId) return;
    setDecisionBusy(a.key + verdict);
    try {
      if (verdict === "accept") {
        await issuesApi.acceptInteraction(a.issueId, a.interactionId, {});
      } else {
        await issuesApi.rejectInteraction(a.issueId, a.interactionId, reason);
      }
      setDecidedKeys((prev) => new Set(prev).add(a.key));
      await queryClient.invalidateQueries({ queryKey: queryKeys.attention(selectedCompanyId!) });
    } finally {
      setDecisionBusy(null);
      setRejectingKey(null);
      setRejectReason("");
    }
  }

  const error = liveRunsQuery.error ?? issuesQuery.error ?? agentsQuery.error ?? attentionQuery.error;
  const updatedAt = Math.max(
    liveRunsQuery.dataUpdatedAt || 0,
    issuesQuery.dataUpdatedAt || 0,
    agentsQuery.dataUpdatedAt || 0,
    attentionQuery.dataUpdatedAt || 0,
  );
  const updatedLabel = error instanceof Error
    ? `paperclip 不可达: ${error.message}`
    : updatedAt
      ? `每 8 秒 · ${new Date(updatedAt).toLocaleTimeString()}`
      : "";
  const attention = model.attention;

  return (
    <div className="office-root -m-4 md:-m-6">
      <style>{OFFICE_CSS}</style>
      <div className="wall">
        <img className="wordmark" src="/brands/roblox-wordmark.png" alt="Roblox" />
        <span className="page-name">Office</span>
        <span className="spacer" />
        <span className="whiteboard">
          <span className={liveRunsQuery.isFetched && liveCount === 0 ? "dot off" : "dot"} />
          <span>{liveRunsQuery.isFetched ? `${liveCount} 桌在开会` : "…"}</span>
        </span>
        {attention.length ? (
          <button
            type="button"
            className="attnchip"
            onClick={() => {
              const href = attention[0]?.href;
              if (!href) return;
              if (href.startsWith("/")) navigate(href);
              else window.open(href, "_blank", "noopener");
            }}
          >
            <span className="dot" />
            <span>{attention.length} 件等你拍板</span>
          </button>
        ) : null}
        {notifyVisible ? (
          <button
            type="button"
            className="notifybtn"
            onClick={() => {
              void Notification.requestPermission().then(() => setNotifyVisible(false));
            }}
          >
            开启通知
          </button>
        ) : null}
        <span className="updated">{updatedLabel}</span>
      </div>
      <div className="floor">
        {attention.length ? (
          <div className="podium">
            <h3>等你拍板 ({attention.length})</h3>
            {attention.map((a) => {
              const decided = decidedKeys.has(a.key);
              const canDecide = !decided && a.kind === "request_confirmation" && a.issueId && a.interactionId;
              const busy = decisionBusy === a.key + "accept" || decisionBusy === a.key + "reject";
              return (
                <div
                  key={a.key}
                  className="item"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (!a.href) return;
                    if (a.href.startsWith("/")) navigate(a.href);
                    else window.open(a.href, "_blank", "noopener");
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || !a.href) return;
                    if (a.href.startsWith("/")) navigate(a.href);
                    else window.open(a.href, "_blank", "noopener");
                  }}
                >
                  <div>
                    <div className="t">{a.title ?? "(无标题)"}</div>
                    {a.whyNow ? <div className="w">{a.whyNow}</div> : null}
                  </div>
                  {decided ? <span className="decided">已拍板 ✓</span> : null}
                  {canDecide ? (
                    <span className="acts" onClick={(e) => e.stopPropagation()}>
                      {rejectingKey === a.key ? (
                        <>
                          <input
                            className="reasoninput"
                            placeholder="拒绝原因(可空)"
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                          />
                          <button
                            type="button"
                            className="no"
                            disabled={busy}
                            onClick={() => void decide(a, "reject", rejectReason.trim() || undefined)}
                          >
                            确认拒绝
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="ok"
                            disabled={busy}
                            onClick={() => void decide(a, "accept")}
                          >
                            接受
                          </button>
                          <button
                            type="button"
                            className="no"
                            disabled={busy}
                            onClick={() => { setRejectingKey(a.key); setRejectReason(""); }}
                          >
                            拒绝
                          </button>
                        </>
                      )}
                    </span>
                  ) : null}
                  {!decided && !canDecide ? <span className="go">去拍板 →</span> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {active.length === 0 ? <div className="empty">会议室空着,现在没有议题</div> : null}
        {active.map((meeting) => (
          <MeetingTable
            key={meeting.id}
            meeting={meeting}
            now={now}
            kidsOpen={openKids.has(meeting.id)}
            onToggleKids={() => {
              setOpenKids((prev) => {
                const next = new Set(prev);
                if (next.has(meeting.id)) next.delete(meeting.id);
                else next.add(meeting.id);
                return next;
              });
            }}
            onOpen={(path) => navigate(path)}
          />
        ))}
        {done.map((meeting) => (
          <MeetingTable
            key={meeting.id}
            meeting={meeting}
            now={now}
            kidsOpen={openKids.has(meeting.id)}
            onToggleKids={() => {
              setOpenKids((prev) => {
                const next = new Set(prev);
                if (next.has(meeting.id)) next.delete(meeting.id);
                else next.add(meeting.id);
                return next;
              });
            }}
            onOpen={(path) => navigate(path)}
          />
        ))}
        {model.lounge.length ? (
          <div className="lounge">
            <h3>休息区</h3>
            <div className="people">{model.lounge.map((seat) => <Seat key={seat.name} seat={seat} />)}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
