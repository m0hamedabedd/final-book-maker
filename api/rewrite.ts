import {
  ensureMethod,
  forwardResponse,
  getRequiredEnv,
  parseJsonBody,
  type ApiRequest,
  type ApiResponse,
} from "./_lib/vercel";

const GEMINI_BASE =
  process.env.GEMINI_BASE_URL ??
  "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL =
  process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite-preview";

interface RewriteBody {
  contents: unknown;
  generationConfig?: unknown;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (!ensureMethod(req, res, ["POST"])) return;

  try {
    const body = parseJsonBody<RewriteBody>(req);
    if (!body?.contents) {
      res.status(400).json({ error: "Missing Gemini request body" });
      return;
    }

    const response = await fetch(
      `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${getRequiredEnv("GEMINI_API_KEY")}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    await forwardResponse(res, response);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to rewrite transcript",
    });
  }
}
