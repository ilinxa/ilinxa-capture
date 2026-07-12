export const jobKeys = {
  all: ["jobs"] as const,
  detail: (id: string) => [...jobKeys.all, id] as const,
};

export const metadataKeys = {
  all: ["metadata"] as const,
};
