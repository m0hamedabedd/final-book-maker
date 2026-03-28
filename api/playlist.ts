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

  const playlistId = getQueryParam(req, "id");
  if (!playlistId) {
    res.status(400).json({ error: "Missing playlist id" });
    return;
  }

  try {
    const response = await fetch(
      `${SUPADATA_BASE}/youtube/playlist/videos?id=${encodeURIComponent(playlistId)}&limit=100`,
      {
        headers: {
          "x-api-key": getRequiredEnv("SUPADATA_API_KEY"),
        },
      }
    );

    await forwardResponse(res, response);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to fetch playlist videos",
    });
  }
}
