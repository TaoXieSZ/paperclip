/** Origins that represent a person's ordinary task or conversation. */
export const HUMAN_TASK_ORIGIN_KINDS = ["manual", "chat_channel", "onboarding_first_task"] as const;

/** Outbound email conversations are created by the sending tool. */
export const AUTOMATED_CHANNEL_ORIGIN_PREFIX = "email-send:";

export interface IssueCreationSourceFields {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  originKind?: string | null;
  originId?: string | null;
}

/** Creation is independent of who is assigned or responsible for execution. */
export function isAgentCreatedIssue(issue: IssueCreationSourceFields): boolean {
  return Boolean(issue.createdByAgentId)
    || (!issue.createdByUserId && issue.originKind !== "chat_channel")
    || (issue.originKind === "chat_channel" && Boolean(issue.originId?.startsWith(AUTOMATED_CHANNEL_ORIGIN_PREFIX)))
    || !HUMAN_TASK_ORIGIN_KINDS.includes(
      (issue.originKind ?? "manual") as typeof HUMAN_TASK_ORIGIN_KINDS[number],
    );
}
