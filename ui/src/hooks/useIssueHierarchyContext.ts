import { useQueries } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

export function useIssueHierarchyContext(companyId: string | null, matches: Issue[], collapsedParents: string[], enabled: boolean) {
  const parents = [...new Set(matches.map((issue) => issue.parentId).filter((id): id is string => Boolean(id)))];
  const ancestorQueries = useQueries({ queries: parents.map((parentId) => ({
    queryKey: [...queryKeys.issues.list(companyId ?? "__unscoped__"), "hierarchy-ancestors", parentId],
    enabled: enabled && Boolean(companyId),
    staleTime: 30_000,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const ancestors: Issue[] = [];
      const visited = new Set<string>();
      let id: string | null = parentId;
      while (id && !visited.has(id)) {
        visited.add(id);
        try {
          const parent: Issue = await issuesApi.get(id, { signal });
          if (parent.companyId !== companyId) break;
          ancestors.push(parent);
          id = parent.parentId;
        } catch (error) {
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) break;
          throw error;
        }
      }
      return ancestors;
    },
  })) });
  const childQueries = useQueries({ queries: matches.map((issue) => {
    const collapsed = collapsedParents.includes(issue.id);
    return {
      queryKey: [...queryKeys.issues.list(companyId ?? "__unscoped__"), "hierarchy-children", issue.id, collapsed],
      enabled: enabled && Boolean(companyId),
      staleTime: 30_000,
      queryFn: ({ signal }: { signal: AbortSignal }) => collapsed
        ? issuesApi.list(companyId!, { parentId: issue.id, includeRoutineExecutions: true, limit: 1 }, { signal })
        : issuesApi.listAll(companyId!, { descendantOf: issue.id, includeRoutineExecutions: true }, { signal }),
    };
  }) });
  const queries = [...ancestorQueries, ...childQueries];
  return {
    issues: queries.flatMap((query) => query.data ?? []),
    error: queries.find((query) => query.error)?.error,
  };
}
