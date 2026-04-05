// ─── Internal API (Python serverless functions on Vercel) ───

const INTERNAL_API_BASE = "/api";

// Retry config
const MAX_RETRIES = 8;
const BASE_RETRY_MS = 3000;

// Concurrency config
export const GEMINI_BATCH_SIZE = 3;
export const TRANSCRIPT_BATCH_SIZE = 2;
export const TITLE_BATCH_SIZE = 3;           // kept for compatibility, not used in fetching
export const BETWEEN_SUPADATA_BATCH_MS = 1500; // shorter — no external API key limits
export const BETWEEN_GEMINI_BATCH_MS = 2000;

// Chunking config — transcripts longer than this get split into chunks
const CHUNK_THRESHOLD = 12000; // chars
const CHUNK_SIZE = 10000;
const CHUNK_OVERLAP = 200;

// ─── Types ───

export interface VideoInfo {
  id: string;
  title: string;
}

export interface TranscriptResult {
  videoId: string;
  title: string;
  content: string;
  lang: string;
}

export interface ChapterResult {
  index: number;
  title: string;
  markdownContent: string;
  latexContent: string;
}

// ─── Helper: extract playlist ID from URL or raw ID ───

export function extractPlaylistId(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const listParam = url.searchParams.get("list");
    if (listParam) return listParam;
  } catch {
    // not a URL — treat as raw ID
  }
  return trimmed;
}

// ─── Generic retry wrapper ───

async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  onLog: (msg: string) => void,
  label: string
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, init);

    if (res.status === 429) {
      if (attempt < MAX_RETRIES) {
        const waitMs = Math.min(BASE_RETRY_MS * Math.pow(2, attempt), 30_000);
        onLog(`  ⏳ Rate limited on ${label}. Retry ${attempt + 1}/${MAX_RETRIES} — waiting ${Math.round(waitMs / 1000)}s...`);
        await delay(waitMs);
        continue;
      }
      throw new Error(`Rate limit exceeded for ${label} after ${MAX_RETRIES} retries`);
    }

    if (res.status === 500 || res.status === 503) {
      if (attempt < MAX_RETRIES) {
        const waitMs = BASE_RETRY_MS * Math.pow(2, attempt);
        onLog(`  ⚠️ Server error on ${label} (${res.status}), retrying in ${Math.round(waitMs / 1000)}s...`);
        await delay(waitMs);
        continue;
      }
    }

    return res;
  }
  throw new Error(`Failed to fetch ${label} after retries`);
}

// ─── Playlist: get video IDs (and titles when available) ───
//
// The Python /api/playlist endpoint returns:
//   { playlistTitle, videoIds, videos: [{id, title}], shortIds, liveIds }
//
// "videos" includes titles fetched server-side by pytubefix, so the frontend
// can skip the per-video /api/video round-trip entirely.

export async function getPlaylistVideos(
  playlistId: string,
  onLog: (msg: string) => void
): Promise<{ ids: string[]; infos: VideoInfo[] }> {
  onLog(`Fetching playlist: ${playlistId}`);

  const res = await fetchWithRetry(
    `${INTERNAL_API_BASE}/playlist?id=${encodeURIComponent(playlistId)}`,
    undefined,
    onLog,
    "playlist"
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get playlist: ${res.status} ${text}`);
  }

  const data = await res.json();

  // Prefer the richer `videos` array; fall back to bare `videoIds`
  const infos: VideoInfo[] = (data.videos ?? []).filter(
    (v: { id: string; title: string | null }) => v.id
  ).map((v: { id: string; title: string | null }) => ({
    id: v.id,
    title: v.title ?? `Video ${v.id}`,
  }));

  const ids: string[] = infos.length
    ? infos.map((v) => v.id)
    : [
        ...(data.videoIds ?? []),
        ...(data.shortIds ?? []),
        ...(data.liveIds ?? []),
      ];

  onLog(`Found ${ids.length} videos in playlist`);
  return { ids, infos };
}

// ─── Keep the old getPlaylistVideoIds for back-compat with App.tsx ───

export async function getPlaylistVideoIds(
  playlistId: string,
  onLog: (msg: string) => void
): Promise<string[]> {
  const { ids } = await getPlaylistVideos(playlistId, onLog);
  return ids;
}

// ─── Video metadata (title) — only needed if playlist didn't include titles ───

export async function getVideoMetadata(
  videoId: string,
  onLog: (msg: string) => void
): Promise<{ title: string }> {
  try {
    const res = await fetchWithRetry(
      `${INTERNAL_API_BASE}/video?id=${encodeURIComponent(videoId)}`,
      undefined,
      onLog,
      `title:${videoId}`
    );
    if (!res.ok) return { title: `Video ${videoId}` };
    const data = await res.json();
    return { title: data.title || `Video ${videoId}` };
  } catch {
    return { title: `Video ${videoId}` };
  }
}

// ─── Transcript ───

export async function getTranscript(
  videoId: string,
  onLog: (msg: string) => void
): Promise<{ content: string; lang: string }> {
  onLog(`Fetching transcript for ${videoId}...`);

  const res = await fetchWithRetry(
    `${INTERNAL_API_BASE}/transcript?videoId=${encodeURIComponent(videoId)}`,
    undefined,
    onLog,
    `transcript:${videoId}`
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Transcript error for ${videoId}: ${res.status} ${text}`);
  }

  const data = await res.json();
  const charCount = (data.content || "").length;
  onLog(`  Transcript received (${data.lang || "unknown"} lang, ${charCount.toLocaleString()} chars)`);
  return { content: data.content, lang: data.lang || "en" };
}

// ─── Chunking ───

function splitTranscriptIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_THRESHOLD) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;
    if (end >= text.length) {
      chunks.push(text.slice(start).trim());
      break;
    }

    const searchWindow = text.slice(end - 500, end + 500);
    let bestBreak = -1;

    for (const sep of [". ", ".\n", "? ", "?\n", "! ", "!\n", "\n\n"]) {
      const idx = searchWindow.lastIndexOf(sep);
      if (idx !== -1) {
        const actualIdx = end - 500 + idx + sep.length;
        if (
          actualIdx > start + CHUNK_SIZE * 0.7 &&
          actualIdx < start + CHUNK_SIZE * 1.3
        ) {
          if (bestBreak === -1 || actualIdx > bestBreak) bestBreak = actualIdx;
        }
      }
    }

    for (const sep of ["، ", "؟ ", "! "]) {
      const idx = searchWindow.lastIndexOf(sep);
      if (idx !== -1) {
        const actualIdx = end - 500 + idx + sep.length;
        if (
          actualIdx > start + CHUNK_SIZE * 0.7 &&
          actualIdx < start + CHUNK_SIZE * 1.3 &&
          actualIdx > bestBreak
        ) {
          bestBreak = actualIdx;
        }
      }
    }

    const breakPoint = bestBreak > start ? bestBreak : end;
    chunks.push(text.slice(start, breakPoint).trim());
    start = Math.max(breakPoint - CHUNK_OVERLAP, breakPoint);
  }

  return chunks.filter((c) => c.length > 0);
}

// ─── Gemini rewrite ───

export async function rewriteAsBookChapter(
  transcript: string,
  chapterIndex: number,
  chapterTitle: string,
  onLog: (msg: string) => void
): Promise<string> {
  const inputChars = transcript.length;
  onLog(
    `Sending chapter ${chapterIndex + 1} to Gemini (input: ${inputChars.toLocaleString()} chars)...`
  );

  const chunks = splitTranscriptIntoChunks(transcript);

  if (chunks.length === 1) {
    const result = await processChunk(transcript, chapterTitle, true, true, 1, 1, onLog);
    if (result.length < inputChars * 0.25 && inputChars > 5000) {
      onLog(
        `  ⚠️ WARNING: Output (${result.length} chars) is much shorter than input (${inputChars} chars) — possible summarization`
      );
    }
    onLog(
      `  ✅ Chapter ${chapterIndex + 1} rewritten (${result.length.toLocaleString()} chars from ${inputChars.toLocaleString()} input)`
    );
    return result;
  }

  onLog(
    `  📎 Long transcript (${inputChars.toLocaleString()} chars) — splitting into ${chunks.length} chunks`
  );

  const processedChunks: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    onLog(
      `  📝 Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length.toLocaleString()} chars)...`
    );
    const result = await processChunk(
      chunks[i],
      chapterTitle,
      isFirst,
      isLast,
      i + 1,
      chunks.length,
      onLog
    );
    processedChunks.push(result);
    if (!isLast) await delay(1500);
  }

  const combined = processedChunks.join("\n\n");
  const ratio = combined.length / inputChars;
  if (ratio < 0.3 && inputChars > 10000) {
    onLog(
      `  ⚠️ WARNING: Combined output (${combined.length.toLocaleString()}) vs input (${inputChars.toLocaleString()}) — ratio ${ratio.toFixed(2)}`
    );
  }
  onLog(
    `  ✅ Chapter ${chapterIndex + 1} rewritten (${combined.length.toLocaleString()} chars, ${chunks.length} chunks)`
  );
  return combined;
}

async function processChunk(
  text: string,
  chapterTitle: string,
  isFirstChunk: boolean,
  isLastChunk: boolean,
  chunkNum: number,
  totalChunks: number,
  onLog: (msg: string) => void
): Promise<string> {
  let chunkContext = "";
  if (totalChunks > 1) {
    if (isFirstChunk) {
      chunkContext = `\n\n**IMPORTANT:** This is PART ${chunkNum} of ${totalChunks}. This is the BEGINNING. Start with "# ${chapterTitle}" and format this part. Do NOT add a conclusion — the transcript continues.`;
    } else if (isLastChunk) {
      chunkContext = `\n\n**IMPORTANT:** This is PART ${chunkNum} of ${totalChunks} (FINAL). Do NOT add a chapter heading — continue from where the previous part ended. You may add a natural conclusion.`;
    } else {
      chunkContext = `\n\n**IMPORTANT:** This is PART ${chunkNum} of ${totalChunks} (MIDDLE). Do NOT add a chapter heading and do NOT add a conclusion. Just continue formatting naturally.`;
    }
  }

  const prompt = `Act as an expert book editor. I will provide you with a raw transcript from a video titled "${chapterTitle}". Your task is to transform this transcript into a polished, highly readable book chapter while strictly preserving the speaker's original tone and dialect.

Follow these rules carefully:

1. **STRICT DIALECT & LANGUAGE PRESERVATION**
   - Keep the exact original spoken dialect (e.g., Egyptian Arabic, العامية المصرية). 
   - Do NOT translate into Modern Standard Arabic (الفصحى) or any other dialect.

2. **NO SUMMARIZATION OR CUTTING CONTENT**
   - Include every story, example, and sentence.
   - The output should be roughly the same length or longer than the original text. NEVER shorten it.

3. **CLEANUP WITHOUT REWRITING**
   - Remove fillers, stutters, repeated words, and spoken noises (e.g., "um", "uh", "يعني").
   - Do not rewrite or formalize sentences. Keep the natural human tone intact.

4. **IMPROVE READABILITY & STRUCTURE**
   - Break the text into clear, logical paragraphs.
   - Insert proper punctuation.
   - Add **Section Titles** in bold when topics change.
   - Use Markdown formatting (#, ##, **bold**, *italic*) where appropriate.
   - Smooth minor abrupt transitions for readability, without changing meaning.

5. **STRICTLY NO AI FILLER**
   - Do not add introductions, conclusions, or commentary from the AI. Start formatting immediately.

6. **FLEXIBLE CONNECTIVITY**
   - Where spoken language is fragmented, connect sentences naturally for reading flow while preserving the original meaning.
   - Maintain all nuances, humor, or emphasis the speaker conveys.

${isFirstChunk && totalChunks === 1 ? `- Start with: # ${chapterTitle}` : ""}

${chunkContext}

Here is the transcript:

${text}`;

  const result = await callGemini(prompt, onLog);

  let cleaned = result.trim();
  if (cleaned.startsWith("```markdown")) {
    cleaned = cleaned.replace(/^```markdown\s*\n?/, "").replace(/\n?```\s*$/, "");
  } else if (cleaned.startsWith("```md")) {
    cleaned = cleaned.replace(/^```md\s*\n?/, "").replace(/\n?```\s*$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  return cleaned;
}

// ─── Markdown → LaTeX (local, no API) ───

export function markdownToLatex(markdown: string, chapterTitle: string): string {
  let tex = markdown;

  const codeBlocks: string[] = [];
  tex = tex.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match.replace(/```\w*\n?/, "").replace(/\n?```/, ""));
    return `%%CODEBLOCK${codeBlocks.length - 1}%%`;
  });

  const inlineCodes: string[] = [];
  tex = tex.replace(/`([^`]+)`/g, (_match, code) => {
    inlineCodes.push(code);
    return `%%INLINECODE${inlineCodes.length - 1}%%`;
  });

  let chapterFound = false;
  tex = tex.replace(/^# (.+)$/gm, (_match, title) => {
    if (!chapterFound) {
      chapterFound = true;
      return `\\chapter{${escapeLatex(title.trim())}}`;
    }
    return `\\section{${escapeLatex(title.trim())}}`;
  });

  if (!chapterFound) tex = `\\chapter{${escapeLatex(chapterTitle)}}\n\n${tex}`;

  tex = tex.replace(/^## (.+)$/gm, (_m, t) => `\\section{${escapeLatex(t.trim())}}`);
  tex = tex.replace(/^### (.+)$/gm, (_m, t) => `\\subsection{${escapeLatex(t.trim())}}`);
  tex = tex.replace(/^#### (.+)$/gm, (_m, t) => `\\subsubsection{${escapeLatex(t.trim())}}`);

  tex = tex.replace(/\*\*\*(.+?)\*\*\*/g, "\\textbf{\\emph{$1}}");
  tex = tex.replace(/___(.+?)___/g, "\\textbf{\\emph{$1}}");
  tex = tex.replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}");
  tex = tex.replace(/__(.+?)__/g, "\\textbf{$1}");
  tex = tex.replace(/(?<![\\*])\*([^*\n]+?)\*(?!\*)/g, "\\emph{$1}");
  tex = tex.replace(/(?<![_\\])_([^_\n]+?)_(?!_)/g, "\\emph{$1}");

  tex = tex.replace(/^> (.+)$/gm, "\\begin{quote}\n$1\n\\end{quote}");
  tex = tex.replace(/\\end\{quote\}\n\\begin\{quote\}/g, "\n");

  tex = tex.replace(/^[-*+] (.+)$/gm, "\\item $1");
  tex = tex.replace(/((?:^\\item .+$\n?)+)/gm, (match) => `\\begin{itemize}\n${match}\\end{itemize}\n`);
  tex = tex.replace(/^\d+\. (.+)$/gm, "\\item $1");
  tex = tex.replace(/^[-*_]{3,}$/gm, "\\bigskip\\noindent\\rule{\\textwidth}{0.4pt}\\bigskip");

  const lines = tex.split("\n");
  const processedLines = lines.map((line) => {
    if (
      line.startsWith("\\chapter{") ||
      line.startsWith("\\section{") ||
      line.startsWith("\\subsection{") ||
      line.startsWith("\\subsubsection{") ||
      line.startsWith("\\begin{") ||
      line.startsWith("\\end{") ||
      line.startsWith("\\item ") ||
      line.startsWith("\\bigskip") ||
      line.includes("%%CODEBLOCK") ||
      line.includes("%%INLINECODE") ||
      line.trim() === ""
    ) {
      return line;
    }
    let p = line;
    p = p.replace(/(?<!\\)&/g, "\\&");
    p = p.replace(/(?<!\\)%/g, "\\%");
    p = p.replace(/(?<!\\)\$/g, "\\$");
    p = p.replace(/(?<!\\)#/g, "\\#");
    p = p.replace(/(?<!\\)~/g, "\\~{}");
    p = p.replace(/(?<!\\)\^/g, "\\^{}");
    return p;
  });
  tex = processedLines.join("\n");

  codeBlocks.forEach((code, i) => {
    const escaped = code.replace(/\\/g, "\\textbackslash{}").replace(/[{}]/g, "\\$&");
    tex = tex.replace(`%%CODEBLOCK${i}%%`, `\\begin{verbatim}\n${escaped}\n\\end{verbatim}`);
  });

  inlineCodes.forEach((code, i) => {
    tex = tex.replace(`%%INLINECODE${i}%%`, `\\texttt{${escapeLatex(code)}}`);
  });

  tex = tex.replace(/"([^"]+)"/g, "``$1''");
  tex = tex.replace(/\u201C/g, "``");
  tex = tex.replace(/\u201D/g, "''");
  tex = tex.replace(/\n{4,}/g, "\n\n\n");

  return tex;
}

function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\~{}")
    .replace(/\^/g, "\\^{}");
}

// ─── Gemini API call ───

async function callGemini(prompt: string, onLog: (msg: string) => void): Promise<string> {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 65536, temperature: 0.2 },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${INTERNAL_API_BASE}/rewrite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        if (attempt < MAX_RETRIES) {
          let waitMs = BASE_RETRY_MS * Math.pow(2, attempt);
          try {
            const errorData = JSON.parse(await res.text());
            const retryInfo = errorData?.error?.details?.find((d: { "@type"?: string; retryDelay?: string }) =>
              d["@type"]?.includes("RetryInfo")
            );
            if (retryInfo?.retryDelay) {
              const s = parseFloat(retryInfo.retryDelay.replace("s", ""));
              if (!isNaN(s) && s > 0) waitMs = Math.max((s + 3) * 1000, waitMs);
            }
          } catch { /* ignore */ }
          waitMs = Math.min(waitMs, 60_000);
          onLog(`  ⏳ Rate limited (429). Retry ${attempt + 1}/${MAX_RETRIES} — waiting ${Math.round(waitMs / 1000)}s...`);
          await delay(waitMs);
          continue;
        }
        throw new Error(`Gemini rate limit exceeded after ${MAX_RETRIES} retries`);
      }

      if (res.status === 503 || res.status === 500) {
        if (attempt < MAX_RETRIES) {
          const waitMs = BASE_RETRY_MS * Math.pow(2, attempt);
          onLog(`  ⚠️ Server error (${res.status}), retrying in ${Math.round(waitMs / 1000)}s...`);
          await delay(waitMs);
          continue;
        }
      }

      if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);

      const data = await res.json();
      const finishReason = data?.candidates?.[0]?.finishReason;
      const content: string = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      if (!content) {
        if (finishReason === "SAFETY" && attempt < MAX_RETRIES) {
          onLog(`  ⚠️ Safety filter triggered, retrying...`);
          await delay(2000);
          continue;
        }
        throw new Error(`Empty response from Gemini (finishReason: ${finishReason})`);
      }

      if (finishReason === "MAX_TOKENS") {
        onLog(`  ⚠️ Response TRUNCATED (MAX_TOKENS hit) — output may be incomplete`);
      }

      return content;
    } catch (err: unknown) {
      const e = err as Error;
      if (
        attempt < MAX_RETRIES &&
        (e.message?.includes("Failed to fetch") ||
          e.message?.includes("NetworkError") ||
          e.message?.includes("network") ||
          (err as { name?: string }).name === "TypeError")
      ) {
        const waitMs = BASE_RETRY_MS * Math.pow(2, attempt);
        onLog(`  ⚠️ Network error, retrying in ${Math.round(waitMs / 1000)}s...`);
        await delay(waitMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Gemini call failed after retries");
}

// ─── Helpers ───

export function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>,
  delayBetweenBatchesMs: number = 0,
  onBatchDone?: (completedSoFar: number) => void,
  onLog?: (msg: string) => void
): Promise<R[]> {
  const results: R[] = [];
  const totalBatches = Math.ceil(items.length / batchSize);

  for (let i = 0; i < items.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    const batch = items.slice(i, i + batchSize);

    if (onLog && totalBatches > 1) {
      onLog(`  📦 Batch ${batchNum}/${totalBatches} (${batch.length} items)...`);
    }

    const batchResults = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    results.push(...batchResults);
    onBatchDone?.(results.length);

    if (delayBetweenBatchesMs > 0 && i + batchSize < items.length) {
      await delay(delayBetweenBatchesMs);
    }
  }
  return results;
}
