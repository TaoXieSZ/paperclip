import { describe, expect, it } from "vitest";
import { buildOfficeModel, groupState, silenceSec, type OfficeIssue, type OfficeRun } from "./officeModel";

const root: OfficeIssue = {
  id: "r",
  parentId: null,
  title: "[LUOBU-1] luobutest bringup",
  identifier: "PAP-1",
  status: "in_progress",
  priority: "high",
};

const child: OfficeIssue = {
  id: "c",
  parentId: "r",
  title: "step",
  identifier: "PAP-2",
  status: "done",
  priority: "medium",
};

const cancelled: OfficeIssue = {
  id: "x",
  parentId: "r",
  title: "dropped",
  identifier: "PAP-3",
  status: "cancelled",
  priority: "low",
};

function run(overrides: Partial<OfficeRun> = {}): OfficeRun {
  return {
    status: "running",
    issueId: "c",
    agentName: "Ada",
    avatarUrl: "/a.png",
    startedAt: "2026-10-15T00:00:00.000Z",
    outputSilence: { silenceAgeMs: 1_000 },
    currentToolName: "bash",
    lastAssistantSnippet: "hello",
    currentStatusMessage: "working",
    lastOutputAt: "2026-10-15T01:00:00.000Z",
    ...overrides,
  };
}

describe("office model", () => {
  it("seats a child run at the root table and strips the jira token", () => {
    const model = buildOfficeModel({
      runs: [run()],
      issues: [root, child, cancelled],
      agents: [
        { name: "Ada", status: "running", avatarUrl: "/a.png" },
        { name: "Bea", status: "idle", avatarUrl: "/b.png" },
        { name: "Cam", status: "paused", avatarUrl: null },
      ],
      attention: {
        items: [{
          dedupKey: "attn-1",
          whyNow: "needs a decision",
          subject: { id: "s1", title: "Ship it", href: "/issues/PAP-1" },
        }],
      },
    });

    expect(model.meetings).toEqual([
      {
        id: "r",
        identifier: "PAP-1",
        title: "luobutest bringup",
        issuePath: "/issues/PAP-1",
        jiraKey: "LUOBU-1",
        jiraStatus: "in_progress",
        env: "luobutest",
        state: "live",
        statusMessage: "working",
        tool: "bash",
        snippet: "hello",
        lastOutputAt: "2026-10-15T01:00:00.000Z",
        avatars: [{ name: "Ada", url: "/a.png" }],
        children: [{ identifier: "PAP-2", title: "step", status: "done" }],
        kidsDone: 1,
        priority: "high",
        sessionStartedAt: "2026-10-15T00:00:00.000Z",
        silenceSec: 1,
      },
    ]);
    expect(model.lounge).toEqual([{ name: "Bea", url: "/b.png" }]);
    expect(model.attention).toEqual([
      { key: "attn-1", title: "Ship it", href: "/issues/PAP-1", whyNow: "needs a decision" },
    ]);
  });

  it("marks a quiet running table stale and a finished table done", () => {
    expect(silenceSec({ silenceAgeMs: 700_000 })).toBe(700);
    expect(groupState([run({ outputSilence: { silenceAgeMs: 700_000 } })])).toBe("stale");
    expect(groupState([run({ status: "succeeded" })])).toBe("done");

    const model = buildOfficeModel({
      runs: [
        run({ outputSilence: { silenceAgeMs: 700_000 }, lastOutputAt: "2026-10-15T02:00:00.000Z" }),
        run({ status: "succeeded", issueId: "other", agentName: "Bea", lastOutputAt: "2026-10-15T03:00:00.000Z" }),
      ],
      issues: [
        root,
        child,
        { id: "other", parentId: null, title: "notes", identifier: "PAP-9", status: "done", priority: "low" },
      ],
      agents: [],
    });

    expect(model.meetings.map((meeting) => [meeting.identifier, meeting.state])).toEqual([
      ["PAP-1", "stale"],
      ["PAP-9", "done"],
    ]);
    expect(model.meetings[0]?.silenceSec).toBe(700);
  });
});
