import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { includeIssueHierarchyContext, loadIssueHierarchyChildren } from "./issue-hierarchy-context";

const task = (id: string, parentId: string | null = null) => ({ id, parentId, companyId: "company" } as Issue);

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

describe("bounded hierarchy reads", () => {
  it("caps rows and requests, and shares overlapping matching subtrees", async () => {
    const root = task("root");
    const child = task("child", "root");
    const calls: string[] = [];
    const read = async (id: string, limit: number, offset: number) => {
      calls.push(id);
      const rows = id === "root" ? [child] : id === "child"
        ? Array.from({ length: 500 }, (_, index) => task(`nested-${index}`, "child")) : [];
      return rows.slice(offset, offset + limit);
    };
    expect(await loadIssueHierarchyChildren("company", [root, child], [], 5, read)).toHaveLength(5);
    expect(calls).toEqual(["root", "child"]);
    calls.length = 0;
    expect(await loadIssueHierarchyChildren("company", [root, child], [], 10, read)).toHaveLength(10);
    expect(calls).toEqual(["root", "child"]);
  });
  it("probes collapsed parents without fetching their tree and rejects foreign-company rows", async () => {
    const calls: Array<[string, number]> = [];
    const rows = await loadIssueHierarchyChildren("company", [task("root")], ["root"], 5,
      async (id, limit) => { calls.push([id, limit]); return [task("child", "root")]; });
    expect(rows.map((issue) => issue.id)).toEqual(["child"]);
    expect(calls).toEqual([["root", 1]]);
    expect(await loadIssueHierarchyChildren("company", [task("root")], [], 1,
      async () => [{ ...task("foreign", "root"), companyId: "other" }])).toEqual([]);
  });
});
