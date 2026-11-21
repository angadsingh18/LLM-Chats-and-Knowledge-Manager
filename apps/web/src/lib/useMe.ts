import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "./api";

export interface Me {
  user: { id: string; email: string; name: string | null; avatarUrl: string | null };
  credential: { kind: string; scopes: string[] };
}

/** Resolves to the signed-in user, or null when signed out (401). */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      try {
        return await api<Me>("/v1/auth/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}
