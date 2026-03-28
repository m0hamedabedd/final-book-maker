import {
  ensureMethod,
  forwardResponse,
  getQueryParam,
  getRequiredEnv,
  type ApiRequest,
  type ApiResponse,
} from "./_lib/vercel";

const SUPADATA_BASE =
  process.env.SUPADATA_BASE_URL ?? "https://api.supadata.ai/v1";

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (!ensureMethod(req, res, ["GET"])) return;

  const videoId = getQueryParam(req, "videoId");
  const jobId = getQueryParam(req, "jobId");

  if (!videoId && !jobId) {
    res.status(400).json({ error: "Missing transcript videoId or jobId" });
    return;
  }

  const endpoint = jobId
    ? `${SUPADATA_BASE}/transcript/${encodeURIComponent(jobId)}`
    : `${SUPADATA_BASE}/transcript?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&text=true`;

  try {
    const response = await fetch(endpoint, {
      headers: {
        "x-api-key": getRequiredEnv("SUPADATA_API_KEY"),
      },
    });

    await forwardResponse(res, response);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to fetch transcript",
    });
  }
}
