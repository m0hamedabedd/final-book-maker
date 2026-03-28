export interface ApiRequest {
  body?: unknown;
  method?: string;
  query: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  json: (body: unknown) => void;
  send: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
}

export function ensureMethod(
  req: ApiRequest,
  res: ApiResponse,
  allowedMethods: string[]
): boolean {
  if (req.method && allowedMethods.includes(req.method)) {
    return true;
  }

  res.setHeader("Allow", allowedMethods.join(", "));
  res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} not allowed` });
  return false;
}

export function getQueryParam(req: ApiRequest, key: string): string | undefined {
  const value = req.query[key];
  return Array.isArray(value) ? value[0] : value;
}

export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function parseJsonBody<T>(req: ApiRequest): T | null {
  if (req.body == null) return null;
  if (typeof req.body === "string") {
    return JSON.parse(req.body) as T;
  }
  return req.body as T;
}

export async function forwardResponse(
  res: ApiResponse,
  upstream: Response
): Promise<void> {
  const contentType = upstream.headers.get("content-type");
  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(upstream.status).send(await upstream.text());
}
