import { useState, useRef, useCallback, useEffect } from "react";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import {
  extractPlaylistId,
  getPlaylistVideos,
  getVideoMetadata,
  getTranscript,
  rewriteAsBookChapter,
  markdownToLatex,
  delay,
  runInBatches,
  GEMINI_BATCH_SIZE,
  TRANSCRIPT_BATCH_SIZE,
  BETWEEN_SUPADATA_BATCH_MS,
  BETWEEN_GEMINI_BATCH_MS,
  type TranscriptResult,
  type ChapterResult,
} from "./utils/api";
import { generateMainTex } from "./utils/latex";

// ─── Pipeline stages ───
type Stage =
  | "idle"
  | "fetching-videos"
  | "fetching-transcripts"
  | "processing-chapters"
  | "generating-book"
  | "done"
  | "error";

const STAGE_LABELS: Record<Stage, string> = {
  idle: "Ready",
  "fetching-videos": "Step 1 — Fetching playlist videos",
  "fetching-transcripts": "Step 2 — Getting transcriptions",
  "processing-chapters": "Step 3 — Rewriting chapters (Gemini) + LaTeX conversion",
  "generating-book": "Step 4 — Generating book package",
  done: "✅ Complete!",
  error: "❌ Error occurred",
};

const STAGE_ORDER: Stage[] = [
  "fetching-videos",
  "fetching-transcripts",
  "processing-chapters",
  "generating-book",
  "done",
];

export default function App() {
  // Form state
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [bookTitle, setBookTitle] = useState("");
  const [bookSubtitle, setBookSubtitle] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [language, setLanguage] = useState<"en" | "ar">("en");

  // Pipeline state
  const [stage, setStage] = useState<Stage>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);

  // Results
  const [transcripts, setTranscripts] = useState<TranscriptResult[]>([]);
  const [chapters, setChapters] = useState<ChapterResult[]>([]);
  const [zipBlob, setZipBlob] = useState<Blob | null>(null);

  // Cancel flag
  const cancelRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Timer
  const startTimer = useCallback(() => {
    setElapsedMs(0);
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 500);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopTimer(), [stopTimer]);

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  };

  const handleStart = async () => {
    if (!playlistUrl.trim()) return;
    cancelRef.current = false;
    setLogs([]);
    setErrorMsg("");
    setTranscripts([]);
    setChapters([]);
    setZipBlob(null);
    setProgress({ current: 0, total: 0 });
    startTimer();

    try {
      // ─── Stage 1: Fetch video IDs + titles in one call ───
      setStage("fetching-videos");
      const playlistId = extractPlaylistId(playlistUrl);

      // getPlaylistVideos returns both ids and infos (with titles) from pytubefix
      const { infos: rawInfos } = await getPlaylistVideos(playlistId, addLog);

      if (rawInfos.length === 0) throw new Error("No videos found in playlist");
      if (cancelRef.current) return cleanup();

      // If pytubefix didn't return titles, fall back to individual /api/video calls
      let videoInfos = rawInfos;
      const missingTitles = rawInfos.filter((v) => !v.title || v.title.startsWith("Video "));
      if (missingTitles.length > 0) {
        addLog(`Fetching ${missingTitles.length} missing video titles...`);
        const updated = await runInBatches(
          rawInfos,
          3,
          async (v) => {
            if (!v.title || v.title.startsWith("Video ")) {
              const meta = await getVideoMetadata(v.id, addLog);
              addLog(`  📹 ${meta.title}`);
              return { ...v, title: meta.title };
            }
            addLog(`  📹 ${v.title}`);
            return v;
          },
          BETWEEN_SUPADATA_BATCH_MS,
          undefined,
          addLog
        );
        videoInfos = updated;
      } else {
        rawInfos.forEach((v) => addLog(`  📹 ${v.title}`));
      }

      if (cancelRef.current) return cleanup();

      // Sort by leading number in title (01, 02 …)
      videoInfos.sort((a, b) => {
        const numA = parseInt(a.title.match(/^(\d+)/)?.[1] ?? "0", 10);
        const numB = parseInt(b.title.match(/^(\d+)/)?.[1] ?? "0", 10);
        if (numA !== 0 && numB !== 0) return numA - numB;
        return 0;
      });
      addLog(`📋 Videos sorted by chapter order`);

      // ─── Stage 2: Transcripts ───
      setStage("fetching-transcripts");
      setProgress({ current: 0, total: videoInfos.length });
      addLog(
        `\nFetching transcripts (${TRANSCRIPT_BATCH_SIZE} at a time)...`
      );

      let detectedArabic = false;
      const allTranscripts: TranscriptResult[] = [];

      const transcriptResults = await runInBatches(
        videoInfos,
        TRANSCRIPT_BATCH_SIZE,
        async (info) => {
          if (cancelRef.current) return null;
          try {
            const result = await getTranscript(info.id, addLog);
            if (result.lang === "ar" && !detectedArabic) {
              detectedArabic = true;
              setLanguage("ar");
              addLog("  🌍 Detected Arabic language");
            }
            return {
              videoId: info.id,
              title: info.title,
              content: result.content,
              lang: result.lang,
            } as TranscriptResult;
          } catch (err: unknown) {
            addLog(`  ⚠️ Skipping ${info.title}: ${(err as Error).message}`);
            return null;
          }
        },
        BETWEEN_SUPADATA_BATCH_MS,
        (completed) => setProgress({ current: completed, total: videoInfos.length }),
        addLog
      );

      for (const t of transcriptResults) {
        if (t) allTranscripts.push(t);
      }

      if (allTranscripts.length === 0)
        throw new Error("No transcripts could be retrieved");

      setTranscripts(allTranscripts);
      addLog(`\n✅ Got ${allTranscripts.length}/${videoInfos.length} transcripts`);

      // ─── Stage 3: Rewrite via Gemini + local LaTeX conversion ───
      setStage("processing-chapters");
      setProgress({ current: 0, total: allTranscripts.length });
      const isArabic = detectedArabic || language === "ar";
      addLog(`\n═══ Processing ${allTranscripts.length} chapters ═══`);
      addLog(`Step A: Gemini rewrites transcripts → markdown (${GEMINI_BATCH_SIZE} in parallel)`);
      addLog(`Step B: Local markdown → LaTeX conversion (instant, no API)`);

      const finalChapters: ChapterResult[] = [];

      for (
        let batchStart = 0;
        batchStart < allTranscripts.length;
        batchStart += GEMINI_BATCH_SIZE
      ) {
        if (cancelRef.current) return cleanup();

        const batchEnd = Math.min(batchStart + GEMINI_BATCH_SIZE, allTranscripts.length);
        const batch = allTranscripts.slice(batchStart, batchEnd);

        addLog(
          `\n── Gemini Batch ${Math.floor(batchStart / GEMINI_BATCH_SIZE) + 1}: chapters ${batchStart + 1}–${batchEnd} ──`
        );

        const batchResults = await Promise.all(
          batch.map(async (t, j) => {
            const idx = batchStart + j;
            try {
              const markdown = await rewriteAsBookChapter(t.content, idx, t.title, addLog);
              const latex = markdownToLatex(markdown, t.title);
              addLog(`  📄 Chapter ${idx + 1} LaTeX converted (${latex.length} chars)`);
              return { index: idx, title: t.title, markdownContent: markdown, latexContent: latex } as ChapterResult;
            } catch (err: unknown) {
              const msg = (err as Error).message;
              addLog(`  ❌ Chapter ${idx + 1} failed: ${msg}`);
              const fallbackLatex = `\\chapter{${t.title}}\n\n% Error: ${msg}\n\n${t.content.replace(/[%&$#_{}~^]/g, "\\$&")}`;
              return { index: idx, title: t.title, markdownContent: t.content, latexContent: fallbackLatex } as ChapterResult;
            }
          })
        );

        finalChapters.push(...batchResults);
        setProgress({ current: finalChapters.length, total: allTranscripts.length });

        if (batchEnd < allTranscripts.length) {
          addLog(`  ⏳ Brief pause before next batch...`);
          await delay(BETWEEN_GEMINI_BATCH_MS);
        }
      }

      finalChapters.sort((a, b) => a.index - b.index);
      setChapters(finalChapters);

      // ─── Stage 4: Generate ZIP ───
      setStage("generating-book");
      addLog("\n═══ Generating book package ═══");

      const mainTex = generateMainTex({
        title: bookTitle || "Book Title",
        subtitle: bookSubtitle || "A Subtitle",
        author: authorName || "Author",
        isArabic,
        chapterCount: finalChapters.length,
      });

      const zip = new JSZip();
      const bookFolder = zip.folder("book")!;
      bookFolder.file("main.tex", mainTex);

      const chaptersFolder = bookFolder.folder("chapters")!;
      finalChapters.forEach((ch, i) => {
        chaptersFolder.file(`chapter${i + 1}.tex`, ch.latexContent);
      });

      const mdFolder = bookFolder.folder("markdown_chapters")!;
      finalChapters.forEach((ch, i) => {
        mdFolder.file(`chapter${i + 1}.md`, ch.markdownContent);
      });

      const transcriptsFolder = bookFolder.folder("raw_transcripts")!;
      allTranscripts.forEach((t, i) => {
        transcriptsFolder.file(
          `${i + 1}_${t.title.replace(/[^a-zA-Z0-9\u0600-\u06FF ]/g, "_").substring(0, 50)}.md`,
          `# ${t.title}\n\n${t.content}`
        );
      });

      addLog("Creating ZIP archive...");
      const blob = await zip.generateAsync({ type: "blob" });
      setZipBlob(blob);

      stopTimer();
      addLog(`\n✅ Book package ready! Total time: ${formatTime(Date.now() - startTimeRef.current)}`);
      setStage("done");
    } catch (err: unknown) {
      stopTimer();
      if (cancelRef.current) {
        addLog("⛔ Process cancelled");
        setStage("idle");
      } else {
        const msg = (err as Error).message || "Unknown error";
        setErrorMsg(msg);
        addLog(`❌ Error: ${msg}`);
        setStage("error");
      }
    }
  };

  const cleanup = () => {
    stopTimer();
    addLog("⛔ Process cancelled");
    setStage("idle");
  };

  const handleCancel = () => {
    cancelRef.current = true;
    stopTimer();
    addLog("Cancelling...");
  };

  const handleDownload = () => {
    if (zipBlob) {
      const safeName = (bookTitle || "book")
        .replace(/[^a-zA-Z0-9\u0600-\u06FF ]/g, "_")
        .substring(0, 40);
      saveAs(zipBlob, `${safeName}_latex_book.zip`);
    }
  };

  const isRunning = !["idle", "done", "error"].includes(stage);
  const currentStageIndex = STAGE_ORDER.indexOf(stage);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800/50 bg-slate-900/50 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-lg shadow-lg shadow-violet-500/20">
            📖
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Playlist → Book</h1>
            <p className="text-xs text-slate-400">
              YouTube playlist to LaTeX book — no API keys needed ⚡
            </p>
          </div>
          {isRunning && (
            <div className="ml-auto flex items-center gap-2 rounded-lg bg-violet-500/10 px-3 py-1.5 text-sm font-mono text-violet-300">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400" />
              {formatTime(elapsedMs)}
            </div>
          )}
          {stage === "done" && (
            <div className="ml-auto flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-sm font-mono text-emerald-300">
              ✓ {formatTime(elapsedMs)}
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
          {/* Left column: Form + Controls */}
          <div className="space-y-6 lg:col-span-2">
            {/* Input Form */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
                Configuration
              </h2>
              <div className="space-y-4">
                {[
                  { label: "YouTube Playlist URL *", value: playlistUrl, set: setPlaylistUrl, placeholder: "https://youtube.com/playlist?list=PLxxxxx" },
                  { label: "Book Title *", value: bookTitle, set: setBookTitle, placeholder: "My Book Title" },
                  { label: "Subtitle", value: bookSubtitle, set: setBookSubtitle, placeholder: "An optional subtitle" },
                  { label: "Author Name *", value: authorName, set: setAuthorName, placeholder: "Author Name" },
                ].map(({ label, value, set, placeholder }) => (
                  <div key={label}>
                    <label className="mb-1 block text-xs font-medium text-slate-400">{label}</label>
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => set(e.target.value)}
                      placeholder={placeholder}
                      disabled={isRunning}
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 transition focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
                    />
                  </div>
                ))}
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">Language</label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as "en" | "ar")}
                    disabled={isRunning}
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 transition focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
                  >
                    <option value="en">English</option>
                    <option value="ar">Arabic (عربي)</option>
                  </select>
                  <p className="mt-1 text-xs text-slate-500">Auto-detected from transcripts</p>
                </div>
              </div>
            </div>

            {/* Info box */}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
              <p className="mb-2 text-xs font-semibold text-emerald-400">⚡ How it works</p>
              <ul className="space-y-1 text-xs text-emerald-300/70">
                <li>• Playlist & titles fetched via <strong>pytubefix</strong> (no API key)</li>
                <li>• Transcripts fetched via <strong>youtube-transcript-api</strong></li>
                <li>• {TRANSCRIPT_BATCH_SIZE} transcripts in parallel with auto-retry</li>
                <li>• Gemini: {GEMINI_BATCH_SIZE} chapters rewritten simultaneously</li>
                <li>• Long transcripts auto-split — zero summarization</li>
                <li>• LaTeX converted locally (instant)</li>
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                Est. ~3–8 min for 8–9 chapters
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3">
              {!isRunning && stage !== "done" && (
                <button
                  onClick={handleStart}
                  disabled={!playlistUrl.trim()}
                  className="flex-1 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/25 transition hover:from-violet-500 hover:to-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  🚀 Start Processing
                </button>
              )}
              {isRunning && (
                <button
                  onClick={handleCancel}
                  className="flex-1 rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-3 text-sm font-semibold text-red-400 transition hover:bg-red-500/20"
                >
                  ⛔ Cancel
                </button>
              )}
              {stage === "done" && (
                <>
                  <button
                    onClick={handleDownload}
                    className="flex-1 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-500/25 transition hover:from-emerald-500 hover:to-teal-500"
                  >
                    📦 Download Book ZIP
                  </button>
                  <button
                    onClick={() => { setStage("idle"); setLogs([]); }}
                    className="rounded-xl border border-slate-700 bg-slate-800 px-5 py-3 text-sm font-semibold text-slate-300 transition hover:bg-slate-700"
                  >
                    🔄
                  </button>
                </>
              )}
              {stage === "error" && (
                <button
                  onClick={() => { setStage("idle"); setErrorMsg(""); }}
                  className="flex-1 rounded-xl border border-slate-700 bg-slate-800 px-5 py-3 text-sm font-semibold text-slate-300 transition hover:bg-slate-700"
                >
                  🔄 Try Again
                </button>
              )}
            </div>

            {/* Pipeline Steps */}
            {stage !== "idle" && (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
                <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
                  Pipeline Progress
                </h2>
                <div className="space-y-3">
                  {STAGE_ORDER.map((s, i) => {
                    const isActive = s === stage;
                    const isCompleted = currentStageIndex > i;
                    const isFuture = currentStageIndex < i;
                    return (
                      <div key={s} className="flex items-center gap-3">
                        <div
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-all ${
                            isCompleted ? "bg-emerald-500 text-white"
                            : isActive ? "animate-pulse bg-violet-500 text-white"
                            : isFuture ? "border border-slate-700 bg-slate-800 text-slate-500"
                            : "bg-slate-800 text-slate-500"
                          }`}
                        >
                          {isCompleted ? "✓" : i + 1}
                        </div>
                        <span
                          className={`text-sm ${
                            isActive ? "font-medium text-violet-300"
                            : isCompleted ? "text-emerald-400"
                            : "text-slate-500"
                          }`}
                        >
                          {STAGE_LABELS[s]}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {progress.total > 0 && isRunning && (
                  <div className="mt-4">
                    <div className="mb-1 flex justify-between text-xs text-slate-400">
                      <span>{progress.current} / {progress.total}</span>
                      <span>{Math.round((progress.current / progress.total) * 100)}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-500"
                        style={{ width: `${(progress.current / progress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Results Summary */}
            {stage === "done" && chapters.length > 0 && (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-6 shadow-xl">
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-emerald-400">
                  📗 Book Generated
                </h2>
                <div className="space-y-2 text-sm text-slate-300">
                  {[
                    ["Title", bookTitle || "Untitled"],
                    ["Author", authorName || "Unknown"],
                    ["Chapters", String(chapters.length)],
                    ["Transcripts", String(transcripts.length)],
                    ["Language", language === "ar" ? "Arabic" : "English"],
                    ["Compiler", language === "ar" ? "XeLaTeX" : "pdfLaTeX"],
                    ["Time", formatTime(elapsedMs)],
                  ].map(([k, v]) => (
                    <p key={k}><span className="text-slate-400">{k}:</span> {v}</p>
                  ))}
                </div>
                <div className="mt-4 border-t border-slate-700/50 pt-3">
                  <p className="text-xs text-slate-500">
                    ZIP contains: main.tex, chapters/ (LaTeX), markdown_chapters/, raw_transcripts/
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Right column: Logs */}
          <div className="lg:col-span-3">
            <div className="sticky top-8 rounded-2xl border border-slate-800 bg-slate-950/90 shadow-xl">
              <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
                  Processing Log
                </h2>
                {isRunning && (
                  <div className="flex items-center gap-2 text-xs text-violet-400">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400" />
                    {STAGE_LABELS[stage]}
                  </div>
                )}
                {errorMsg && (
                  <span className="max-w-[200px] truncate text-xs text-red-400">{errorMsg}</span>
                )}
              </div>
              <div className="h-[calc(100vh-12rem)] overflow-y-auto p-4 font-mono text-xs leading-relaxed">
                {logs.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-slate-600">
                    <div className="text-center">
                      <p className="text-3xl">📋</p>
                      <p className="mt-2">Logs will appear here once processing starts</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {logs.map((log, i) => (
                      <div
                        key={i}
                        className={
                          log.includes("❌") ? "text-red-400"
                          : log.includes("✅") ? "text-emerald-400"
                          : log.includes("⚠️") ? "text-amber-400"
                          : log.includes("═══") ? "font-bold text-violet-300"
                          : log.includes("──") ? "text-indigo-300"
                          : log.includes("⏳") ? "text-amber-300/60"
                          : "text-slate-400"
                        }
                      >
                        {log}
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Chapter Overview */}
        {stage === "done" && chapters.length > 0 && (
          <div className="mt-8">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
              Chapter Overview
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {chapters.map((ch) => (
                <div
                  key={ch.index}
                  className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 transition hover:border-slate-700"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/20 text-xs font-bold text-violet-400">
                      {ch.index + 1}
                    </span>
                    <span className="text-xs text-slate-500">chapter{ch.index + 1}.tex</span>
                  </div>
                  <h3 className="line-clamp-2 text-sm font-medium text-slate-200">{ch.title}</h3>
                  <div className="mt-2 flex gap-3 text-xs text-slate-500">
                    <span>📝 {ch.markdownContent.length.toLocaleString()} md</span>
                    <span>📄 {ch.latexContent.length.toLocaleString()} tex</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="mt-12 border-t border-slate-800/50 py-6 text-center text-xs text-slate-600">
        Playlist → Book | YouTube to LaTeX Book Generator | ⚡ Powered by youtube-transcript-api + pytubefix
      </footer>
    </div>
  );
}
