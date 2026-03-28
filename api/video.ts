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

  const videoId = getQueryParam(req, "id");
  if (!videoId) {
    res.status(400).json({ error: "Missing video id" });
    return;
  }

  try {
    const response = await fetch(
      `${SUPADATA_BASE}/youtube/video?id=${encodeURIComponent(videoId)}`,
      {
        headers: {
          "x-api-key": getRequiredEnv("SUPADATA_API_KEY"),
        },
      }
    );

    await forwardResponse(res, response);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to fetch video metadata",
    });
  }
}
