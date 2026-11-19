export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const stringOr = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
