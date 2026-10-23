"use client";

import Link from "next/link";
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  FileText,
  LoaderCircle,
  Plus,
  Sparkles,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Source = {
  citation: string;
  sourceType: "EMAIL" | "ATTACHMENT";
  title: string;
  sender: string | null;
  receivedAt: string | null;
  gmailMessageId: string | null;
  attachmentId: string | null;
  mimeType: string;
  score: number;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

type IndexStatus = {
  status: string;
  phase: string;
  processedDocuments: number;
  skippedDocuments: number;
  failedDocuments: number;
  totalSources: number;
  indexedSources: number;
  pendingSources: number;
};

const examples = [
  "What are my latest emails about?",
  "Summarize emails received yesterday.",
  "What did a specific sender say?",
  "Summarize a PDF attachment stored in S3.",
];

const EMPTY_STATUS: IndexStatus = {
  status: "idle",
  phase: "EMAIL",
  processedDocuments: 0,
  skippedDocuments: 0,
  failedDocuments: 0,
  totalSources: 0,
  indexedSources: 0,
  pendingSources: 0,
};

async function readJson<T>(response: Response): Promise<T> {
  const data: unknown = await response.json();
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Request failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return data as T;
}

function formatReceivedAt(value: string | null): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function AiAssistant() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answerError, setAnswerError] = useState("");
  const [indexStatus, setIndexStatus] = useState<IndexStatus>(EMPTY_STATUS);
  const [indexing, setIndexing] = useState(false);
  const [indexError, setIndexError] = useState("");
  const [indexNotice, setIndexNotice] = useState("");
  const [indexConfigured, setIndexConfigured] = useState(true);
  const conversationEnd = useRef<HTMLDivElement>(null);

  const loadIndexStatus = useCallback(async () => {
    try {
      const status = await readJson<IndexStatus>(
        await fetch("/api/ai/index-status", {
          cache: "no-store",
          credentials: "same-origin",
        }),
      );
      setIndexStatus(status);
    } catch (error) {
      setIndexError(error instanceof Error ? error.message : "Unable to read index status.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadIndexStatus(), 0);
    return () => window.clearTimeout(timer);
  }, [loadIndexStatus]);

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, asking]);

  async function sendQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = question.trim();
    if (!value || asking) return;
    setMessages((current) => [...current, { role: "user", content: value }]);
    setQuestion("");
    setAsking(true);
    setAnswerError("");
    try {
      const result = await readJson<{ answer: string; sources: Source[] }>(
        await fetch("/api/ai/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            question: value,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            // Send recent turns (prior to this question) so follow-up
            // questions are understood in context.
            history: messages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
          }),
        }),
      );
      setMessages((current) => [
        ...current,
        { role: "assistant", content: result.answer, sources: result.sources },
      ]);
    } catch (error) {
      setAnswerError(error instanceof Error ? error.message : "Unable to answer the question.");
    } finally {
      setAsking(false);
    }
  }

  async function indexDocuments() {
    if (indexing) return;
    setIndexing(true);
    setIndexError("");
    setIndexNotice("");
    try {
      if (indexStatus.status !== "running") {
        const started = await readJson<IndexStatus>(
          await fetch("/api/ai/index", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ action: "start" }),
          }),
        );
        setIndexStatus(started);
      }

      let status = indexStatus.status === "running" ? indexStatus : null;
      if (status === null) {
        const response = await fetch("/api/ai/index-status", {
          cache: "no-store",
          credentials: "same-origin",
        });
        status = await readJson<IndexStatus>(response);
      }

      for (let batch = 0; batch < 10 && status.status === "running"; batch += 1) {
        status = await readJson<IndexStatus>(
          await fetch("/api/ai/index", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ action: "batch", limit: 2 }),
          }),
        );
        setIndexStatus(status);
      }
      setIndexNotice(
        status.status === "completed"
          ? "Indexing finished."
          : "Batch finished. Continue indexing to process more documents.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to index documents.";
      setIndexError(message);
      if (/OPENAI_API_KEY/.test(message)) setIndexConfigured(false);
    } finally {
      setIndexing(false);
      void loadIndexStatus();
    }
  }

  return (
    <main className="min-h-dvh bg-[#F5F6F8] px-3 py-5 text-slate-800 sm:px-6 sm:py-8">
      <div className="mx-auto flex min-h-[calc(100dvh-2.5rem)] max-w-6xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_18px_60px_rgba(15,23,42,0.08)] sm:min-h-[calc(100dvh-4rem)]">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              aria-label="Back to inbox"
              className="grid size-10 place-items-center rounded-xl border border-slate-200 text-slate-600 transition hover:bg-slate-50"
            >
              <ArrowLeft size={18} />
            </Link>
            <div className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-white">
              <Sparkles size={19} />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-950">AI Assistant</p>
              <p className="text-xs text-slate-500">Ask across archived email and attachments</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setMessages([]);
              setAnswerError("");
              setQuestion("");
            }}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
          >
            <Plus size={16} />
            New conversation
          </button>
        </header>

        <section className="border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <BookOpen size={16} className="text-indigo-600" />
              <span>
                {indexStatus.indexedSources.toLocaleString()} of{" "}
                {indexStatus.totalSources.toLocaleString()} sources indexed
              </span>
              {indexStatus.failedDocuments > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                  {indexStatus.failedDocuments} failed
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void indexDocuments()}
              disabled={indexing || !indexConfigured}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {indexing ? <LoaderCircle size={16} className="animate-spin" /> : <FileText size={16} />}
              {indexing
                ? "Indexing batch…"
                : indexStatus.status === "running"
                  ? "Continue indexing"
                  : "Index or update library"}
            </button>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all"
              style={{
                width: `${
                  indexStatus.totalSources
                    ? Math.min(100, (indexStatus.indexedSources / indexStatus.totalSources) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Indexing runs in small batches. Email text is read from PostgreSQL; attachment files are read privately from S3.
          </p>
          {indexNotice && <p className="mt-2 text-xs font-medium text-emerald-700">{indexNotice}</p>}
          {indexError && <p role="alert" className="mt-2 text-xs text-rose-700">{indexError}</p>}
        </section>

        <section
          aria-label="Conversation"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 sm:px-8"
        >
          {messages.length === 0 ? (
            <div className="mx-auto my-auto w-full max-w-2xl py-10">
              <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-indigo-50 text-indigo-600">
                <Sparkles size={24} />
              </div>
              <h1 className="mt-5 text-center text-2xl font-semibold tracking-tight text-slate-950">
                Ask your archive
              </h1>
              <p className="mx-auto mt-2 max-w-lg text-center text-sm leading-6 text-slate-500">
                Answers use relevant passages from your indexed emails and attachments, with source references.
              </p>
              <div className="mt-7 grid gap-2 sm:grid-cols-2">
                {examples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setQuestion(example)}
                    className="rounded-2xl border border-slate-200 px-4 py-3 text-left text-sm text-slate-600 transition hover:border-indigo-200 hover:bg-indigo-50/60 hover:text-indigo-800"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
              {messages.map((message, index) => (
                <article
                  key={`${message.role}-${index}`}
                  className={`max-w-[92%] rounded-2xl px-4 py-3 sm:max-w-[85%] ${
                    message.role === "user"
                      ? "ml-auto bg-indigo-600 text-white"
                      : "mr-auto border border-slate-200 bg-white text-slate-800"
                  }`}
                >
                  <p className="whitespace-pre-wrap text-sm leading-7">{message.content}</p>
                  {message.sources && message.sources.length > 0 && (
                    <div className="mt-4 border-t border-slate-200 pt-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Sources
                      </p>
                      <div className="space-y-2">
                        {message.sources.map((source) => (
                          <a
                            key={`${source.sourceType}-${source.attachmentId ?? source.gmailMessageId}`}
                            href={
                              source.attachmentId
                                ? `/api/attachments/${encodeURIComponent(source.attachmentId)}?disposition=inline`
                                : source.gmailMessageId
                                  ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(source.gmailMessageId)}`
                                  : undefined
                            }
                            target={source.attachmentId || source.gmailMessageId ? "_blank" : undefined}
                            rel={source.attachmentId || source.gmailMessageId ? "noreferrer" : undefined}
                            className="block rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-700 hover:bg-indigo-50"
                          >
                            <span className="font-semibold text-indigo-700">{source.citation}</span>{" "}
                            <span className="font-medium">{source.title}</span>
                            <span className="block pt-1 text-slate-500">
                              {source.sourceType === "EMAIL" ? "Email" : source.mimeType}
                              {source.sender ? ` · ${source.sender}` : ""}
                              {source.receivedAt ? ` · ${formatReceivedAt(source.receivedAt)}` : ""}
                            </span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
              ))}
              {asking && (
                <div className="mr-auto inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-500">
                  <LoaderCircle size={16} className="animate-spin" />
                  Searching sources and drafting an answer…
                </div>
              )}
              <div ref={conversationEnd} />
            </div>
          )}
        </section>

        <footer className="border-t border-slate-100 px-5 py-4 sm:px-8">
          {answerError && <p role="alert" className="mb-3 text-sm text-rose-700">{answerError}</p>}
          <form onSubmit={sendQuestion} className="mx-auto flex max-w-3xl items-end gap-3">
            <label className="sr-only" htmlFor="ai-question">Ask a question</label>
            <textarea
              id="ai-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              maxLength={1200}
              rows={2}
              placeholder="Ask a question about your emails or attachments…"
              className="max-h-40 min-h-14 flex-1 resize-y rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 outline-none transition placeholder:text-slate-400 focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-100"
            />
            <button
              type="submit"
              disabled={asking || !question.trim()}
              aria-label="Send question"
              className="grid size-12 shrink-0 place-items-center rounded-2xl bg-indigo-600 text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {asking ? <LoaderCircle size={18} className="animate-spin" /> : <ArrowUp size={19} />}
            </button>
          </form>
          <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-slate-400">
            AI responses may be inaccurate. Verify important details using the cited original sources.
          </p>
        </footer>
      </div>
    </main>
  );
}
