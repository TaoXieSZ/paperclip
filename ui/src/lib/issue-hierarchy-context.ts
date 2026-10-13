import type { Issue } from "@paperclipai/shared";

/** Context never promotes an unrelated or orphaned automated task to a result. */
export function includeIssueHierarchyContext(matches: Issue[], context: Issue[]): Issue[] {
  const byId = new Map([...context, ...matches].map((issue) => [issue.id, issue]));
  const result = new Map(matches.map((issue) => [issue.id, issue]));
  for (const match of matches) {
    const visited = new Set([match.id]);
    let parentId = match.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      result.set(parent.id, parent);
      parentId = parent.parentId;
    }
  }
  // Descendants are rooted at matches, not at contextual ancestors.
  const descendantIds = new Set(matches.map((issue) => issue.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const issue of context) {
      if (!descendantIds.has(issue.id) && issue.parentId && descendantIds.has(issue.parentId)) {
        descendantIds.add(issue.id);
        result.set(issue.id, issue);
        changed = true;
      }
    }
  }
  return [...result.values()];
}
