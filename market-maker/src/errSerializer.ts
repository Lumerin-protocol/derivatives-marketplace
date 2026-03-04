import pino from "pino";

const MAX_FIELD_CHARS = 100;

function truncate(val: string): string {
  if (val.length <= MAX_FIELD_CHARS) return val;
  return `${val.slice(0, MAX_FIELD_CHARS)}\n... (${val.length - MAX_FIELD_CHARS} chars trimmed)`;
}

export function trimmedErrSerializer(err: unknown): Record<string, unknown> {
  const serialized = pino.stdSerializers.err(err as Error);
  if (typeof serialized !== "object" || serialized === null) return { raw: err };

  for (const key of Object.keys(serialized)) {
    const val = serialized[key];
    if (typeof val === "string") {
      serialized[key] = truncate(val);
    } else if (typeof val === "object" && val !== null) {
      delete serialized[key];
    }
  }

  // pino.stdSerializers.err omits non-enumerable `cause` — handle explicitly
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause) {
    serialized.cause = trimmedErrSerializer(cause);
  }

  return serialized;
}
