import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { includeIssueHierarchyContext } from "./issue-hierarchy-context";

const task = (id: string, parentId: string | null = null) => ({ id, parentId } as Issue);

describe("task hierarchy context", () => {
  it("retains ancestors and descendants without promoting siblings or orphans", () => {
    const match = task("human", "agent-parent");
    const context = [task("agent-parent", "grandparent"), task("grandparent"), task("agent-child", "human"), task("grandchild", "agent-child"), task("unrelated"), task("orphan", "missing"), task("sibling", "agent-parent")];
    expect(includeIssueHierarchyContext([match], context).map((issue) => issue.id)).toEqual([
      "human", "agent-parent", "grandparent", "agent-child", "grandchild",
    ]);
    expect(includeIssueHierarchyContext([], context)).toEqual([]);
  });
  it("deduplicates matches and terminates cycles", () => {
    const match = task("human", "parent");
    expect(includeIssueHierarchyContext([match], [match, task("parent", "human")]).map((issue) => issue.id)).toEqual(["human", "parent"]);
  });
});
