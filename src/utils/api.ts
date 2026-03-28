// ─── Supadata API ───

const INTERNAL_API_BASE = "/api";

// Retry config
const MAX_RETRIES = 8;
const BASE_RETRY_MS = 3000;

// Concurrency config
export const GEMINI_BATCH_SIZE = 3;
export const TRANSCRIPT_BATCH_SIZE = 2;
export const TITLE_BATCH_SIZE = 3;
export const BETWEEN_SUPADATA_BATCH_MS = 2500;
export const BETWEEN_GEMINI_BATCH_MS = 2000;

// Chunking config — transcripts longer than this get split into chunks
const CHUNK_THRESHOLD = 12000; // chars — if transcript > this, split it
const CHUNK_SIZE = 10000; // target chars per chunk
const CHUNK_OVERLAP = 200; // overlap chars to avoid cutting mid-sentence

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
    // not a URL
  }
  return trimmed;
}

// ─── Generic retry wrapper for Supadata calls ───

async function supadataFetchWithRetry(
  url: string,
  onLog: (msg: string) => void,
  label: string
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url);

    if (res.status === 429) {
      if (attempt < MAX_RETRIES) {
        const waitMs = Math.min(BASE_RETRY_MS * Math.pow(2, attempt), 30000);
        onLog(`  ⏳ Rate limited on ${label}. Retry ${attempt + 1}/${MAX_RETRIES} — waiting ${Math.round(waitMs / 1000)}s...`);
        await delay(waitMs);
        continue;
      }
      throw new Error(`Supadata rate limit exceeded for ${label} after ${MAX_RETRIES} retries`);
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

// ─── Supadata: get playlist video IDs ───

export async function getPlaylistVideoIds(
  playlistId: string,
  onLog: (msg: string) => void
): Promise<string[]> {
  onLog(`Fetching video IDs for playlist: ${playlistId}`);
  const res = await supadataFetchWithRetry(
    `${INTERNAL_API_BASE}/playlist?id=${encodeURIComponent(playlistId)}`,
    onLog,
    "playlist"
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get playlist videos: ${res.status} ${text}`);
  }
  const data = await res.json();
  const ids: string[] = [
    ...(data.videoIds || []),
    ...(data.shortIds || []),
    ...(data.liveIds || []),
  ];
  onLog(`Found ${ids.length} videos in playlist`);
  return ids;
}

// ─── Supadata: get video metadata (title) with retry ───

export async function getVideoMetadata(
  videoId: string,
  onLog: (msg: string) => void
): Promise<{ title: string }> {
  try {
    const res = await supadataFetchWithRetry(
      `${INTERNAL_API_BASE}/video?id=${encodeURIComponent(videoId)}`,
      onLog,
      `title:${videoId}`
    );
    if (!res.ok) {
      return { title: `Video ${videoId}` };
    }
    const data = await res.json();
    return { title: data.title || `Video ${videoId}` };
  } catch {
    return { title: `Video ${videoId}` };
  }
}

// ─── Supadata: get transcript with retry ───

export async function getTranscript(
  videoId: string,
  onLog: (msg: string) => void
): Promise<{ content: string; lang: string }> {
  onLog(`Fetching transcript for ${videoId}...`);

  const res = await supadataFetchWithRetry(
    `${INTERNAL_API_BASE}/transcript?videoId=${encodeURIComponent(videoId)}`,
    onLog,
    `transcript:${videoId}`
  );

  if (res.status === 202) {
    const jobData = await res.json();
    const jobId = jobData.jobId;
    onLog(`  Transcript job started: ${jobId}, polling...`);
    return await pollTranscriptJob(jobId, onLog);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Transcript error for ${videoId}: ${res.status} ${text}`);
  }

  const data = await res.json();
  const charCount = (data.content || "").length;
  onLog(`  Transcript received (${data.lang || "unknown"} lang, ${charCount.toLocaleString()} chars)`);
  return { content: data.content, lang: data.lang || "en" };
}

async function pollTranscriptJob(
  jobId: string,
  onLog: (msg: string) => void
): Promise<{ content: string; lang: string }> {
  const maxAttempts = 120;
  for (let i = 0; i < maxAttempts; i++) {
    await delay(1500);
    try {
      const res = await fetch(
        `${INTERNAL_API_BASE}/transcript?jobId=${encodeURIComponent(jobId)}`
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (data.status === "completed") {
        const charCount = (data.content || "").length;
        onLog(`  Transcript job completed (${charCount.toLocaleString()} chars)`);
        return { content: data.content, lang: data.lang || "en" };
      }
      if (data.status === "failed") {
        throw new Error(`Transcript job failed: ${jobId}`);
      }
    } catch (err: any) {
      if (err.message?.includes("failed")) throw err;
    }
  }
  throw new Error(`Transcript job timed out: ${jobId}`);
}

// ─── Chunking: split long transcripts into manageable pieces ───

function splitTranscriptIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_THRESHOLD) {
    return [text]; // Short enough, no need to split
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;

    if (end >= text.length) {
      // Last chunk — take everything remaining
      chunks.push(text.slice(start).trim());
      break;
    }

    // Try to break at a sentence boundary (. or ? or ! or newline) near the end
    let breakPoint = end;
    const searchWindow = text.slice(end - 500, end + 500);
    
    // Look for sentence-ending punctuation near the target end
    const sentenceBreaks = ['. ', '.\n', '? ', '?\n', '! ', '!\n', '\n\n'];
    let bestBreak = -1;
    
    for (const sep of sentenceBreaks) {
      const idx = searchWindow.lastIndexOf(sep);
      if (idx !== -1) {
        const actualIdx = (end - 500) + idx + sep.length;
        if (actualIdx > start + CHUNK_SIZE * 0.7 && actualIdx < start + CHUNK_SIZE * 1.3) {
          if (bestBreak === -1 || actualIdx > bestBreak) {
            bestBreak = actualIdx;
          }
        }
      }
    }

    if (bestBreak > start) {
      breakPoint = bestBreak;
    }

    // Also try Arabic sentence endings
    const arabicBreaks = ['، ', '。', '؟ ', '! '];
    for (const sep of arabicBreaks) {
      const idx = searchWindow.lastIndexOf(sep);
      if (idx !== -1) {
        const actualIdx = (end - 500) + idx + sep.length;
        if (actualIdx > start + CHUNK_SIZE * 0.7 && actualIdx < start + CHUNK_SIZE * 1.3) {
          if (bestBreak === -1 || actualIdx > bestBreak) {
            bestBreak = actualIdx;
            breakPoint = bestBreak;
          }
        }
      }
    }

    chunks.push(text.slice(start, breakPoint).trim());
    // Start next chunk with small overlap for context
    start = Math.max(breakPoint - CHUNK_OVERLAP, breakPoint);
  }

  return chunks.filter(c => c.length > 0);
}

// ─── Gemini: rewrite transcript as book chapter (markdown) ───
// For long transcripts, splits into chunks and processes each separately

export async function rewriteAsBookChapter(
  transcript: string,
  chapterIndex: number,
  chapterTitle: string,
  onLog: (msg: string) => void
): Promise<string> {
  const inputChars = transcript.length;
  onLog(`Sending chapter ${chapterIndex + 1} to Gemini (input: ${inputChars.toLocaleString()} chars)...`);

  const chunks = splitTranscriptIntoChunks(transcript);

  if (chunks.length === 1) {
    // Short transcript — single call
    const result = await processChunk(transcript, chapterTitle, true, true, 1, 1, onLog);
    
    // Validate output isn't drastically shorter than input (possible summarization)
    if (result.length < inputChars * 0.25 && inputChars > 5000) {
      onLog(`  ⚠️ WARNING: Output (${result.length} chars) is much shorter than input (${inputChars} chars) — possible summarization detected`);
    }
    
    onLog(`  ✅ Chapter ${chapterIndex + 1} rewritten (${result.length.toLocaleString()} chars from ${inputChars.toLocaleString()} input)`);
    return result;
  }

  // Long transcript — process in chunks
  onLog(`  📎 Transcript is long (${inputChars.toLocaleString()} chars) — splitting into ${chunks.length} chunks for full coverage`);
  
  const processedChunks: string[] = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    onLog(`  📝 Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length.toLocaleString()} chars)...`);
    
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

    // Brief delay between chunk calls
    if (!isLast) {
      await delay(1500);
    }
  }

  // Combine all chunks
  const combined = processedChunks.join("\n\n");
  
  // Validate
  const ratio = combined.length / inputChars;
  if (ratio < 0.3 && inputChars > 10000) {
    onLog(`  ⚠️ WARNING: Combined output (${combined.length.toLocaleString()} chars) vs input (${inputChars.toLocaleString()} chars) — ratio ${ratio.toFixed(2)}. Possible summarization.`);
  }
  
  onLog(`  ✅ Chapter ${chapterIndex + 1} rewritten (${combined.length.toLocaleString()} chars from ${inputChars.toLocaleString()} input, ${chunks.length} chunks)`);
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
      chunkContext = `\n\n**IMPORTANT:** This is PART ${chunkNum} of ${totalChunks} of the full transcript. This is the BEGINNING. Start with the chapter heading "# ${chapterTitle}" and format this part. Do NOT add any conclusion — the transcript continues in the next part.`;
    } else if (isLastChunk) {
      chunkContext = `\n\n**IMPORTANT:** This is PART ${chunkNum} of ${totalChunks} of the full transcript. This is the FINAL part. Do NOT add a chapter heading — just continue formatting from where the previous part ended. You may add a natural conclusion if the speaker concludes.`;
    } else {
      chunkContext = `\n\n**IMPORTANT:** This is PART ${chunkNum} of ${totalChunks} of the full transcript (a MIDDLE part). Do NOT add a chapter heading and do NOT add any conclusion. Just continue formatting the text naturally from where the previous part ended.`;
    }
  }

  const prompt = `**Act as an expert book editor.** I will provide you with a raw transcript from a video titled "${chapterTitle}". Your task is to format and refine this transcript into a highly readable book chapter.

You must strictly follow these rules:

**1. STRICT DIALECT & LANGUAGE RULE:**
You must preserve the exact original spoken dialect. If the speaker is using Egyptian Arabic (العامية المصرية), the text MUST remain in Egyptian Arabic. **DO NOT** translate, convert, or "correct" the text into Modern Standard Arabic (الفصحى). Keep the speaker's original vocabulary, idioms, and natural voice.

**2. ZERO SUMMARIZATION — THIS IS THE MOST IMPORTANT RULE:**
Do not summarize, cut, or skip ANY stories, examples, concepts, or sentences. **Every single piece of information** from the transcript must be included in the final text. The output should be roughly the same length as the input or longer — NEVER shorter. If in doubt, include more rather than less.

**3. CLEANUP, BUT NO REWRITING:**
Remove spoken "noise" (stuttering, repeated words, excessive filler words like "um," "uh," "يعني," "فاهم قصدي"). However, **do not rewrite the sentences to sound overly formal or AI-generated.** Keep the natural, human tone of the speaker.

**4. READABILITY & FORMATTING:**
- Break the massive wall of text into logical, digestible paragraphs.
- Add proper punctuation (commas, periods, question marks, exclamation points).
- If the speaker changes topics, add a bold **Section Title** to break up the chapter naturally.
- Use Markdown formatting (# for chapter title, ## for sections, **bold**, *italic*, etc.)
${isFirstChunk && totalChunks === 1 ? `- Start with: # ${chapterTitle}` : ""}

**5. NO AI FILLER:**
Do not add introductory or concluding AI remarks (e.g., do not write "In this chapter, we will..."). Just start formatting the text immediately.${chunkContext}

**Here is the transcript:**

${text}`;

  const result = await callGemini(prompt, onLog);

  // Clean up markdown code fences if the model wrapped the output
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

// ─── Convert Markdown to LaTeX locally (no API call!) ───

export function markdownToLatex(markdown: string, chapterTitle: string): string {
  let tex = markdown;

  // Step 1: Extract and protect code blocks
  const codeBlocks: string[] = [];
  tex = tex.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match.replace(/```\w*\n?/, "").replace(/\n?```/, ""));
    return `%%CODEBLOCK${codeBlocks.length - 1}%%`;
  });

  // Step 2: Convert inline code
  const inlineCodes: string[] = [];
  tex = tex.replace(/`([^`]+)`/g, (_match, code) => {
    inlineCodes.push(code);
    return `%%INLINECODE${inlineCodes.length - 1}%%`;
  });

  // Step 3: Convert headings
  let chapterFound = false;
  tex = tex.replace(/^# (.+)$/gm, (_match, title) => {
    if (!chapterFound) {
      chapterFound = true;
      return `\\chapter{${escapeLatex(title.trim())}}`;
    }
    return `\\section{${escapeLatex(title.trim())}}`;
  });

  if (!chapterFound) {
    tex = `\\chapter{${escapeLatex(chapterTitle)}}\n\n${tex}`;
  }

  // ## → \section
  tex = tex.replace(/^## (.+)$/gm, (_match, title) => {
    return `\\section{${escapeLatex(title.trim())}}`;
  });

  // ### → \subsection
  tex = tex.replace(/^### (.+)$/gm, (_match, title) => {
    return `\\subsection{${escapeLatex(title.trim())}}`;
  });

  // #### → \subsubsection
  tex = tex.replace(/^#### (.+)$/gm, (_match, title) => {
    return `\\subsubsection{${escapeLatex(title.trim())}}`;
  });

  // Step 4: Convert bold and italic
  tex = tex.replace(/\*\*\*(.+?)\*\*\*/g, "\\textbf{\\emph{$1}}");
  tex = tex.replace(/___(.+?)___/g, "\\textbf{\\emph{$1}}");
  tex = tex.replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}");
  tex = tex.replace(/__(.+?)__/g, "\\textbf{$1}");
  tex = tex.replace(/(?<![\\*])\*([^*\n]+?)\*(?!\*)/g, "\\emph{$1}");
  tex = tex.replace(/(?<![_\\])_([^_\n]+?)_(?!_)/g, "\\emph{$1}");

  // Step 5: Convert blockquotes
  tex = tex.replace(/^> (.+)$/gm, "\\begin{quote}\n$1\n\\end{quote}");
  tex = tex.replace(/\\end\{quote\}\n\\begin\{quote\}/g, "\n");

  // Step 6: Convert unordered lists
  tex = tex.replace(/^[-*+] (.+)$/gm, "\\item $1");
  tex = tex.replace(/((?:^\\item .+$\n?)+)/gm, (match) => {
    return `\\begin{itemize}\n${match}\\end{itemize}\n`;
  });

  // Step 7: Convert ordered lists
  tex = tex.replace(/^\d+\. (.+)$/gm, "\\item $1");

  // Step 8: Convert horizontal rules
  tex = tex.replace(/^[-*_]{3,}$/gm, "\\bigskip\\noindent\\rule{\\textwidth}{0.4pt}\\bigskip");

  // Step 9: Escape remaining special characters in body text
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

    let processed = line;
    processed = processed.replace(/(?<!\\)&/g, "\\&");
    processed = processed.replace(/(?<!\\)%/g, "\\%");
    processed = processed.replace(/(?<!\\)\$/g, "\\$");
    processed = processed.replace(/(?<!\\)#/g, "\\#");
    processed = processed.replace(/(?<!\\)~/g, "\\~{}");
    processed = processed.replace(/(?<!\\)\^/g, "\\^{}");

    return processed;
  });
  tex = processedLines.join("\n");

  // Step 10: Restore code blocks
  codeBlocks.forEach((code, i) => {
    const escaped = code.replace(/\\/g, "\\textbackslash{}").replace(/[{}]/g, "\\$&");
    tex = tex.replace(
      `%%CODEBLOCK${i}%%`,
      `\\begin{verbatim}\n${escaped}\n\\end{verbatim}`
    );
  });

  // Step 11: Restore inline code
  inlineCodes.forEach((code, i) => {
    tex = tex.replace(`%%INLINECODE${i}%%`, `\\texttt{${escapeLatex(code)}}`);
  });

  // Step 12: Convert smart quotes
  tex = tex.replace(/"([^"]+)"/g, "``$1''");
  tex = tex.replace(/\u201C/g, "``");
  tex = tex.replace(/\u201D/g, "''");

  // Clean up multiple blank lines
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

// ─── Gemini API call with retry & exponential backoff ───

async function callGemini(
  prompt: string,
  onLog: (msg: string) => void
): Promise<string> {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 65536,
      temperature: 0.2,
    },
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
            const errorText = await res.text();
            const errorData = JSON.parse(errorText);
            const retryInfo = errorData?.error?.details?.find(
              (d: any) => d["@type"]?.includes("RetryInfo")
            );
            if (retryInfo?.retryDelay) {
              const seconds = parseFloat(retryInfo.retryDelay.replace("s", ""));
              if (!isNaN(seconds) && seconds > 0) {
                waitMs = Math.max((seconds + 3) * 1000, waitMs);
              }
            }
          } catch {
            // ignore parse errors
          }

          waitMs = Math.min(waitMs, 60000);
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

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini API error: ${res.status} ${text}`);
      }

      const data = await res.json();
      const finishReason = data?.candidates?.[0]?.finishReason;
      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      
      if (!content) {
        if (finishReason === "SAFETY") {
          onLog(`  ⚠️ Response blocked by safety filter, retrying with slight modification...`);
          if (attempt < MAX_RETRIES) {
            await delay(2000);
            continue;
          }
        }
        throw new Error(`Empty response from Gemini (finishReason: ${finishReason})`);
      }
      
      // Log finish reason to detect truncation
      if (finishReason === "MAX_TOKENS") {
        onLog(`  ⚠️ Response was TRUNCATED (MAX_TOKENS hit) — output may be incomplete`);
      }
      
      return content;
    } catch (err: any) {
      if (
        attempt < MAX_RETRIES &&
        (err.message?.includes("Failed to fetch") ||
          err.message?.includes("NetworkError") ||
          err.message?.includes("network") ||
          err.name === "TypeError")
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

// ─── Batch runner with delay between batches ───

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

    const batchResults = await Promise.all(
      batch.map((item, j) => fn(item, i + j))
    );
    results.push(...batchResults);
    onBatchDone?.(results.length);

    if (delayBetweenBatchesMs > 0 && i + batchSize < items.length) {
      await delay(delayBetweenBatchesMs);
    }
  }
  return results;
}
