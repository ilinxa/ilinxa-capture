import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api-client";
import { jobKeys } from "@/lib/query-keys";

export function useJobPolling<T extends { status: string }>(jobId: string | null) {
  return useQuery<T>({
    queryKey: jobKeys.detail(jobId ?? ""),
    queryFn: () => apiClient.get<T>(`/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "completed" || status === "failed") return false;
      return 2000;
    },
  });
}
