"use client";

import Image from "next/image";
import Link from "next/link";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  Bot,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  Inbox,
  LoaderCircle,
  Mail,
  Paperclip,
  PenSquare,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type AttachmentSummary = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
};

type EmailSummary = {
  id: string;
  threadId?: string;
  sender: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  attachments: AttachmentSummary[];
  gmailLabels: string[];
  messageCount?: number;
};

type EmailDetail = EmailSummary & {
  recipients: string;
  bodyText: string;
  bodyHtml: string | null;
  gmailMessageId: string;
};

type AttachmentPreview = {
  id: string;
  fileName: string;
  mimeType: string;
  url: string | null;
};

type HistoryState = {
  status: "not_started" | "running" | "completed";
  processedMessages: number;
  skippedMessages: number;
  uploadedAttachments: number;
};

type InboxSyncStatus = {
  status: "idle" | "running" | "success" | "error" | "checking" | "disabled";
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  processedMessages: number;
  skippedMessages: number;
  uploadedAttachments: number;
  errorMessage: string | null;
  schedulerEnabled?: boolean;
  intervalMs?: number;
  nextScheduledAt?: string | null;
  schedulerSyncing?: boolean;
};

type ListResponse = {
  emails: EmailSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const PAGE_SIZE = 25;
type MailFilter = "inbox" | "sent" | "starred" | "attachments" | "archive";

const navigationItems: {
  id: MailFilter;
  label: string;
  icon: typeof Inbox;
}[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "sent", label: "Sent", icon: Send },
  { id: "starred", label: "Starred", icon: Star },
  { id: "attachments", label: "Attachments", icon: Paperclip },
  { id: "archive", label: "Archive", icon: Archive },
];

function filterTitle(filter: MailFilter): string {
  return filter === "attachments"
    ? "Attachments"
    : filter[0].toUpperCase() + filter.slice(1);
}

function formatDate(value: string, includeTime = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

function formatCountdown(nextScheduledAt: string, now: number): string {
  const nextAt = new Date(nextScheduledAt).getTime();
  if (!Number.isFinite(nextAt)) return "--:--";
  const seconds = Math.max(0, Math.ceil((nextAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getSenderName(sender: string): string {
  const match = sender.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  return sender.split("@")[0] || "Unknown sender";
}

function getInitials(sender: string): string {
  const words = getSenderName(sender)
    .split(/[\s._-]+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(name: string): string {
  return name.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE";
}

function isInlinePreviewable(mimeType: string): boolean {
  return [
    "application/pdf",
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ].includes(mimeType.split(";")[0].trim().toLowerCase());
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || "Request failed. Please try again.");
  }
  return body;
}

export function MailDashboard({
  initialEmails,
  initialTotal,
  initialLastSync,
  initialHistory,
  mailboxLabel,
}: {
  initialEmails: EmailSummary[];
  initialTotal: number;
  initialLastSync: string | null;
  initialHistory: HistoryState;
  mailboxLabel: string;
}) {
  const [emails, setEmails] = useState(initialEmails);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(
    Math.max(1, Math.ceil(initialTotal / PAGE_SIZE)),
  );
  const [filter, setFilter] = useState<MailFilter>("inbox");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedId, setSelectedId] = useState(initialEmails[0]?.id ?? null);
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState<{ id: string; message: string } | null>(
    null,
  );
  const [detailRetry, setDetailRetry] = useState(0);
  const [lastSync, setLastSync] = useState(initialLastSync);
  const [syncStatus, setSyncStatus] = useState<InboxSyncStatus>({
    status: "checking",
    lastAttemptAt: null,
    lastSuccessfulAt: initialLastSync,
    processedMessages: 0,
    skippedMessages: 0,
    uploadedAttachments: 0,
    errorMessage: null,
  });
  const [history, setHistory] = useState(initialHistory);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const [attachmentPreviewLoading, setAttachmentPreviewLoading] = useState(false);
  const [attachmentPreviewError, setAttachmentPreviewError] = useState("");
  const listRequestSequence = useRef(0);
  const lastSuccessfulSyncSeen = useRef(initialLastSync);
  const hasLoadedSyncStatus = useRef(false);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [countdownNow, setCountdownNow] = useState(Date.now());
  const [syncNotification, setSyncNotification] = useState("");
  const syncNotificationTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const timer = window.setInterval(() => setCountdownNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const loadList = useCallback(async () => {
    const requestSequence = ++listRequestSequence.current;
    setListLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        filter,
      });
      if (debouncedSearch) params.set("q", debouncedSearch);
      const result = await readResponse<ListResponse>(
        await fetch(`/api/emails?${params.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
        }),
      );
      if (requestSequence !== listRequestSequence.current) return;
      setEmails(result.emails);
      setTotal(result.total);
      setTotalPages(Math.max(1, result.totalPages));
      setSelectedId((current) =>
        result.emails.some((email) => email.id === current)
          ? current
          : (result.emails[0]?.id ?? null),
      );
    } catch (loadError) {
      if (requestSequence !== listRequestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load emails.");
    } finally {
      if (requestSequence === listRequestSequence.current) setListLoading(false);
    }
  }, [debouncedSearch, filter, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), 0);
    return () => window.clearTimeout(timer);
  }, [loadList]);

  useEffect(() => {
    let active = true;
    let requestInFlight = false;

    async function refreshSyncStatus() {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const result = await readResponse<InboxSyncStatus & { schedulerEnabled: boolean }>(
          await fetch("/api/sync-status", {
            cache: "no-store",
            credentials: "same-origin",
          }),
        );
        if (!active) return;
        const nextStatus = result.schedulerEnabled
          ? result
          : {
              ...result,
              status: "disabled" as const,
              errorMessage: "Automatic synchronization is disabled. Enable GMAIL_SYNC_ENABLED to start polling.",
            };
        setSyncStatus(nextStatus);
        setLastSync(nextStatus.lastSuccessfulAt);
        if (!hasLoadedSyncStatus.current) {
          lastSuccessfulSyncSeen.current = nextStatus.lastSuccessfulAt;
          hasLoadedSyncStatus.current = true;
        } else if (
          nextStatus.status === "success" &&
          nextStatus.lastSuccessfulAt &&
          nextStatus.lastSuccessfulAt !== lastSuccessfulSyncSeen.current
        ) {
          lastSuccessfulSyncSeen.current = nextStatus.lastSuccessfulAt;
          void loadList();
          setDetailRefresh((value) => value + 1);
          if (nextStatus.processedMessages > 0) {
            setSyncNotification(
              `${nextStatus.processedMessages} new ${
                nextStatus.processedMessages === 1 ? "email" : "emails"
              } imported`,
            );
            if (syncNotificationTimer.current !== undefined) {
              window.clearTimeout(syncNotificationTimer.current);
            }
            syncNotificationTimer.current = window.setTimeout(
              () => setSyncNotification(""),
              5000,
            );
          }
        }
      } catch (statusError) {
        if (!active) return;
        setSyncStatus((current) => ({
          ...current,
          status: "error",
          errorMessage:
            statusError instanceof Error
              ? statusError.message
              : "Unable to check Gmail synchronization status.",
        }));
      } finally {
        requestInFlight = false;
      }
    }

    void refreshSyncStatus();
    const interval = window.setInterval(() => void refreshSyncStatus(), 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [loadList]);

  useEffect(
    () => () => {
      if (syncNotificationTimer.current !== undefined) {
        window.clearTimeout(syncNotificationTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setDetailLoading(true);
      setDetailError(null);
      fetch(`/api/emails/${encodeURIComponent(selectedId)}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      })
        .then(readResponse<{ email: EmailDetail }>)
        .then((result) => {
          if (!controller.signal.aborted && result.email.id === selectedId) {
            setDetail(result.email);
          } else if (!controller.signal.aborted) {
            setDetailError({
              id: selectedId,
              message: "The returned message did not match the selected email.",
            });
          }
        })
        .catch((loadError: unknown) => {
          if (controller.signal.aborted) return;
          setDetailError({
            id: selectedId,
            message:
              loadError instanceof Error ? loadError.message : "Unable to load message.",
          });
        })
        .finally(() => {
          if (!controller.signal.aborted) setDetailLoading(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [selectedId, detailRetry, detailRefresh]);

  const visibleDetail = detail?.id === selectedId ? detail : null;
  const visibleDetailError =
    detailError?.id === selectedId ? detailError.message : "";

  useEffect(() => {
    return () => {
      if (attachmentPreview?.url) URL.revokeObjectURL(attachmentPreview.url);
    };
  }, [attachmentPreview?.url]);

  function changeFilter(next: MailFilter) {
    setFilter(next);
    setPage(1);
    setMobilePreview(false);
  }

  async function runHistoryBatch(restart = false) {
    setHistoryBusy(true);
    setError("");
    try {
      const query = restart ? "?restart=true" : "";
      const response = await fetch(`/api/history-sync${query}`, {
        method: "POST",
        credentials: "same-origin",
      });
      const next = await readResponse<HistoryState>(response);
      setHistory(next);
      await loadList();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Historical sync failed.");
    } finally {
      setHistoryBusy(false);
    }
  }

  async function previewAttachment(attachment: AttachmentSummary) {
    if (!isInlinePreviewable(attachment.mimeType)) return;

    setAttachmentPreview({
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      url: null,
    });
    setAttachmentPreviewError("");
    setAttachmentPreviewLoading(true);
    try {
      const response = await fetch(
        `/api/attachments/${encodeURIComponent(attachment.id)}?disposition=inline`,
        { cache: "no-store", credentials: "same-origin" },
      );
      if (!response.ok) {
        let message = `Attachment request failed (HTTP ${response.status}).`;
        try {
          const body = (await response.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // Retain the HTTP status message when the server did not return JSON.
        }
        throw new Error(message);
      }
      const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (contentType !== attachment.mimeType.split(";")[0].trim().toLowerCase()) {
        throw new Error("The attachment response type did not match the archived file.");
      }
      const url = URL.createObjectURL(await response.blob());
      setAttachmentPreview((current) =>
        current?.id === attachment.id ? { ...current, url } : current,
      );
    } catch (error) {
      setAttachmentPreviewError(
        error instanceof Error ? error.message : "Unable to preview this attachment.",
      );
    } finally {
      setAttachmentPreviewLoading(false);
    }
  }

  async function downloadAttachment(attachment: AttachmentPreview) {
    setAttachmentPreviewError("");
    setAttachmentPreviewLoading(true);
    try {
      const response = await fetch(
        `/api/attachments/${encodeURIComponent(attachment.id)}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      if (!response.ok) {
        let message = `Attachment request failed (HTTP ${response.status}).`;
        try {
          const body = (await response.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // Retain the HTTP status message when the server did not return JSON.
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setAttachmentPreview(null);
    } catch (error) {
      setAttachmentPreviewError(
        error instanceof Error ? error.message : "Unable to download this attachment.",
      );
    } finally {
      setAttachmentPreviewLoading(false);
    }
  }

  return (
    <main className="flex h-dvh min-h-[560px] overflow-hidden bg-[#F5F6F8] p-2.5 text-slate-800 sm:p-4 lg:p-6">
      <div className="flex min-w-0 flex-1 gap-2.5 overflow-hidden sm:gap-4">
        <aside className="hidden w-20 shrink-0 flex-col items-center rounded-[24px] border border-slate-200/70 bg-white py-5 shadow-[0_8px_28px_rgba(15,23,42,0.04)] md:flex">
          <div className="grid size-11 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-200/70">
            <Mail size={21} strokeWidth={2.2} />
          </div>
          <button
            type="button"
            disabled
            title="Compose is unavailable because this archive uses read-only Gmail access."
            aria-label="Compose unavailable in read-only mode"
            className="mt-8 grid size-11 place-items-center rounded-2xl bg-blue-50 text-blue-600 opacity-70"
          >
            <PenSquare size={19} />
          </button>
          <nav aria-label="Mailbox folders" className="mt-5 flex flex-col gap-2">
            {navigationItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                aria-label={label}
                aria-pressed={filter === id}
                title={label}
                onClick={() => changeFilter(id)}
                className={`grid size-11 place-items-center rounded-2xl transition ${filter === id ? "bg-blue-50 text-blue-600" : "text-slate-400 hover:bg-slate-50 hover:text-slate-700"}`}
              >
                <Icon size={19} strokeWidth={1.9} />
              </button>
            ))}
          </nav>
          <Link
            href="/ai-assistant"
            title="AI Assistant"
            aria-label="AI Assistant"
            className="mt-3 grid size-11 place-items-center rounded-2xl bg-indigo-50 text-indigo-600 transition hover:bg-indigo-100"
          >
            <Sparkles size={19} strokeWidth={1.9} />
          </Link>
          <button
            type="button"
            disabled
            title="Settings are managed by the application environment."
            aria-label="Settings are managed by the application environment"
            className="mt-auto grid size-11 place-items-center rounded-2xl text-slate-400 opacity-60"
          >
            <Settings size={19} />
          </button>
          <div className="mt-4 grid size-10 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700 ring-2 ring-white">
            {getInitials(mailboxLabel) || "M"}
          </div>
        </aside>

        <section className={`${mobilePreview ? "hidden" : "flex"} w-full min-w-0 flex-col overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)] md:flex md:w-[340px] md:shrink-0 lg:w-[400px]`}>
          <div className="border-b border-slate-100 px-5 pb-5 pt-6 md:px-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-600">
                  <span className="size-1.5 rounded-full bg-blue-500" />
                  Gmail archive
                  <Link
                    href="/auto-replies"
                    title="View Auto-Replies"
                    aria-label="Go to auto-replies"
                    className="ml-2 inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-700 transition hover:bg-amber-100"
                  >
                    <Bot size={14} strokeWidth={2.2} />
                    Auto-Replies
                  </Link>
                </div>
                <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.045em] text-slate-950">
                  {filterTitle(filter)}
                </h1>
              </div>
              <div className="rounded-xl bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-800">
                {total.toLocaleString()}
              </div>
            </div>

            <label className="mt-5 flex h-12 items-center gap-2.5 rounded-2xl border border-slate-200 bg-[#F8FAFC] px-3.5 transition focus-within:border-blue-300 focus-within:bg-white focus-within:ring-4 focus-within:ring-blue-50">
              <Search size={17} className="shrink-0 text-slate-400" />
              <input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Search sender, subject, content..."
                aria-label="Search archived emails"
                className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-500"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="text-slate-400 hover:text-slate-700"
                >
                  <X size={15} />
                </button>
              )}
            </label>

            <div className="mt-4 grid grid-cols-6 gap-1 md:hidden">
              {navigationItems.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => changeFilter(id)}
                  aria-pressed={filter === id}
                  aria-label={label}
                  title={label}
                  className={`inline-flex min-w-0 items-center justify-center rounded-xl px-1 py-2 text-[10px] font-semibold ${filter === id ? "bg-blue-50 text-blue-700" : "bg-slate-50 text-slate-500"}`}
                >
                  <Icon size={13} className="shrink-0" />
                </button>
              ))}
              <Link
                href="/ai-assistant"
                aria-label="AI Assistant"
                title="AI Assistant"
                className="inline-flex min-w-0 items-center justify-center rounded-xl bg-indigo-50 px-1 py-2 text-[10px] font-semibold text-indigo-700"
              >
                <Sparkles size={13} className="shrink-0" />
              </Link>
            </div>
            <div className="mt-4 flex items-center justify-end">
              <button
                title="Historical sync processes one resumable Gmail page per click."
                onClick={() => void runHistoryBatch(history.status === "completed")}
                disabled={historyBusy}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-blue-600 hover:bg-blue-50 disabled:opacity-50"
              >
                {historyBusy ? (
                  <LoaderCircle size={14} className="animate-spin" />
                ) : (
                  <Archive size={14} />
                )}
                {history.status === "running"
                  ? "Continue history"
                  : history.status === "completed"
                    ? "Restart history"
                    : "Archive history"}
              </button>
            </div>
            {listLoading && emails.length > 0 && (
              <div className="mt-2 flex items-center gap-1.5 text-[10px] text-blue-500">
                <LoaderCircle size={11} className="animate-spin" />
                Updating messages…
              </div>
            )}
            {history.status !== "not_started" && (
              <div className="mt-3 flex items-center justify-between text-[10px] text-slate-400">
                <span>
                  History {history.status} · {history.processedMessages.toLocaleString()} saved
                </span>
                <span>{history.uploadedAttachments.toLocaleString()} files</span>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {error && (
              <div role="alert" className="mx-4 mt-4 rounded-xl bg-rose-50 px-3 py-2.5 text-xs text-rose-700">
                {error}
              </div>
            )}
            {listLoading && emails.length === 0 ? (
              <div aria-label="Loading emails" className="space-y-1 p-4">
                {Array.from({ length: 6 }, (_, index) => (
                  <div key={index} className="flex animate-pulse gap-3 rounded-2xl p-3">
                    <div className="size-10 shrink-0 rounded-full bg-slate-100" />
                    <div className="min-w-0 flex-1 space-y-2 py-1">
                      <div className="h-3 w-2/3 rounded bg-slate-100" />
                      <div className="h-3 w-4/5 rounded bg-slate-100" />
                      <div className="h-2.5 w-full rounded bg-slate-50" />
                    </div>
                  </div>
                ))}
              </div>
            ) : emails.length === 0 ? (
              <div className="px-7 py-16 text-center">
                <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
                  <Mail size={21} />
                </div>
                <h2 className="mt-4 text-sm font-semibold text-slate-800">No emails found</h2>
                <p className="mt-1.5 text-xs leading-5 text-slate-400">
                  Try another search or archive more Gmail history.
                </p>
              </div>
            ) : (
              emails.map((email) => {
                const active = email.id === selectedId;
                return (
                  <button
                    key={email.id}
                    onClick={() => {
                      if (email.id !== selectedId) {
                        setDetail(null);
                        setDetailLoading(true);
                        setDetailError(null);
                      }
                      setSelectedId(email.id);
                      setMobilePreview(true);
                    }}
                    className={`group relative flex w-full gap-3.5 border-b border-slate-100 px-4 py-[18px] text-left transition md:px-5 ${active ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : "hover:bg-slate-50"}`}
                  >
                    {active && <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-blue-600" />}
                    <div className="relative mt-0.5 grid size-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-blue-100 to-indigo-100 text-xs font-bold text-blue-800">
                      {getInitials(email.sender) || "?"}
                      {active && <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-white bg-blue-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`flex min-w-0 items-center gap-1.5 truncate text-sm ${active ? "font-semibold text-slate-950" : "font-medium text-slate-800"}`}>
                          {email.gmailLabels.includes("UNREAD") && (
                            <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-blue-600" />
                          )}
                          <span className="truncate">{getSenderName(email.sender)}</span>
                          {email.messageCount && email.messageCount > 1 && (
                            <span className="shrink-0 text-xs font-normal text-slate-500">
                              ({email.messageCount})
                            </span>
                          )}
                        </span>
                        <time className="shrink-0 text-xs text-slate-500">
                          {formatDate(email.receivedAt, true)}
                        </time>
                      </div>
                      <div className="mt-1.5 truncate text-sm font-semibold text-blue-800">
                        {email.subject || "(no subject)"}
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-[13px] leading-[1.6] text-slate-600">
                        {email.snippet || "No message preview"}
                      </p>
                      {(email.attachments.length > 0 || email.gmailLabels.includes("STARRED")) && (
                        <div className="mt-2 flex items-center gap-2">
                          {email.attachments.length > 0 && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-1 text-[9px] font-medium text-slate-500">
                              <Paperclip size={10} />
                              {email.attachments.length} {email.attachments.length === 1 ? "file" : "files"}
                            </span>
                          )}
                          {email.gmailLabels.includes("STARRED") && (
                            <Star size={12} className="fill-amber-400 text-amber-400" aria-label="Starred" />
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="flex h-[58px] shrink-0 items-center justify-between border-t border-slate-100 px-4 text-[11px] text-slate-400 md:px-5">
            <span>
              {total === 0
                ? "No messages"
                : `${((page - 1) * PAGE_SIZE + 1).toLocaleString()}–${Math.min(page * PAGE_SIZE, total).toLocaleString()} of ${total.toLocaleString()}`}
            </span>
            <div className="flex gap-1">
              <button
                aria-label="Previous page"
                disabled={page <= 1 || listLoading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                className="grid size-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30"
              >
                <ChevronLeft size={17} />
              </button>
              <button
                aria-label="Next page"
                disabled={page >= totalPages || listLoading}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                className="grid size-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30"
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
        </section>

        <section className={`${mobilePreview ? "flex" : "hidden"} min-w-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)] md:flex`}>
          {selectedId !== null &&
          (detailLoading || (!visibleDetail && !visibleDetailError)) ? (
            <div className="grid flex-1 place-items-center text-sm text-slate-400">
              <span className="flex items-center gap-2">
                <LoaderCircle size={18} className="animate-spin" /> Loading message
              </span>
            </div>
          ) : visibleDetailError ? (
            <div role="alert" className="grid flex-1 place-items-center px-6 text-center">
              <div>
                <h2 className="text-sm font-semibold text-rose-700">Message could not be loaded</h2>
                <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">{visibleDetailError}</p>
                <button
                  onClick={() => setDetailRetry((current) => current + 1)}
                  className="mt-4 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : visibleDetail ? (
            <>
              <header className="flex h-[68px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 md:px-8">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setMobilePreview(false)}
                    aria-label="Back to email list"
                    className="grid size-9 place-items-center rounded-xl text-slate-500 hover:bg-slate-100 md:hidden"
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <div className="hidden text-[11px] font-medium text-slate-400 md:block">
                    {filterTitle(filter)} <span className="px-1.5 text-slate-300">/</span>
                    <span className="text-slate-700">Message</span>
                  </div>
                  <span className="rounded-lg bg-blue-50 px-2.5 py-1.5 text-[10px] font-semibold text-blue-600 md:hidden">
                    Message
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="hidden items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[10px] font-medium text-emerald-700 sm:inline-flex">
                    <ShieldCheck size={13} /> Archived securely
                  </span>
                  <button
                    onClick={() => window.open(`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(visibleDetail.gmailMessageId)}`, "_blank", "noopener,noreferrer")}
                    className="flex h-9 items-center gap-2 rounded-xl border border-slate-200 px-3 text-[11px] font-semibold text-slate-600 shadow-sm transition hover:border-blue-200 hover:text-blue-600"
                  >
                    Open in Gmail <ChevronDown size={13} />
                  </button>
                </div>
              </header>

              <article className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto max-w-[860px] px-5 py-7 md:px-10 md:py-10 xl:px-14">
                  <div className="flex items-start justify-between gap-5">
                    <div className="min-w-0">
                      <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-blue-600">
                        <Sparkles size={13} /> Archived message
                      </div>
                      <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.035em] text-slate-950 md:text-[36px]">
                        {visibleDetail.subject || "(no subject)"}
                      </h2>
                      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-slate-600">
                        <span>To {visibleDetail.recipients || "you"}</span>
                        <span className="text-slate-200">·</span>
                        <time>{formatDate(visibleDetail.receivedAt, true)}</time>
                      </div>
                    </div>
                    <span className="hidden rounded-xl bg-slate-50 px-3 py-2 text-[10px] text-slate-400 sm:block">
                      Read-only archive
                    </span>
                  </div>

                  <div className="mt-8 flex items-center gap-3 border-y border-slate-200 py-5">
                    <div className="grid size-12 shrink-0 place-items-center rounded-full bg-gradient-to-br from-blue-100 to-violet-100 text-sm font-bold text-blue-800">
                      {getInitials(visibleDetail.sender) || "?"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-semibold text-slate-900">
                        {getSenderName(visibleDetail.sender)}
                      </div>
                      <div className="truncate text-[13px] text-slate-600">{visibleDetail.sender}</div>
                    </div>
                    <time className="hidden shrink-0 text-xs text-slate-600 sm:block">
                      {formatDate(visibleDetail.receivedAt, true)}
                    </time>
                  </div>

                  {visibleDetail.bodyHtml ? (
                    <div
                      className="email-html mt-8 break-words text-[15px] leading-[1.8] text-slate-800"
                      dangerouslySetInnerHTML={{ __html: visibleDetail.bodyHtml }}
                    />
                  ) : (
                    <div className="email-body mt-8 whitespace-pre-wrap break-words text-[15px] leading-[1.8] text-slate-800">
                      {visibleDetail.bodyText || visibleDetail.snippet || "This email has no text body."}
                    </div>
                  )}

                  {visibleDetail.attachments.length > 0 && (
                    <section className="mt-9">
                      <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold text-slate-700">
                        <Paperclip size={14} className="text-blue-500" />
                        {visibleDetail.attachments.length} {visibleDetail.attachments.length === 1 ? "attachment" : "attachments"}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {visibleDetail.attachments.map((attachment) => (
                          <div
                            key={attachment.id}
                            className="group flex min-w-0 items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-[0_2px_8px_rgba(15,23,42,0.03)] transition hover:border-blue-200 hover:shadow-md"
                          >
                            <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-600">
                              <FileText size={20} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[11px] font-semibold text-slate-700">
                                {attachment.fileName}
                              </div>
                              <div className="mt-1 text-[9px] text-slate-400">
                                {fileExtension(attachment.fileName)} · {formatSize(attachment.size)}
                              </div>
                            </div>
                            {isInlinePreviewable(attachment.mimeType) && (
                              <button
                                type="button"
                                onClick={() => void previewAttachment(attachment)}
                                className="shrink-0 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-50"
                                aria-label={`Preview ${attachment.fileName}`}
                              >
                                Preview
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                void downloadAttachment({
                                  id: attachment.id,
                                  fileName: attachment.fileName,
                                  mimeType: attachment.mimeType,
                                  url: null,
                                })
                              }
                              className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-blue-50 hover:text-blue-700"
                              aria-label={`Download ${attachment.fileName}`}
                              title="Download attachment"
                            >
                              <ArrowDownToLine size={16} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  <div className="mt-9 rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-3.5 text-[11px] leading-5 text-blue-800">
                    This archived message is read-only. Reply, forward, delete,
                    and read-status actions are not enabled for this Gmail connection.
                  </div>
                </div>
              </article>
            </>
          ) : (
            <div className="grid flex-1 place-items-center px-6 text-center">
              <div>
                <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-slate-100 text-slate-400">
                  <Mail size={23} />
                </div>
                <h2 className="mt-4 text-sm font-semibold text-slate-700">Select a message</h2>
                <p className="mt-1 text-xs text-slate-400">Choose an email to preview its archived content.</p>
              </div>
            </div>
          )}
          <footer className="flex min-h-[54px] shrink-0 flex-col justify-center gap-1 border-t border-slate-100 px-5 py-2 text-[10px] text-slate-500 sm:flex-row sm:items-center sm:justify-between md:px-8">
            <span className="flex items-center gap-1.5"><ShieldCheck size={12} className="text-emerald-500" /> Private archive</span>
            <div className="flex min-w-0 flex-col gap-0.5 sm:items-end">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span
                  aria-label={`Gmail sync ${syncStatus.status}`}
                  className={`size-1.5 shrink-0 rounded-full ${
                    syncStatus.status === "running" || syncStatus.schedulerSyncing
                      ? "animate-pulse bg-blue-500"
                      : syncStatus.status === "error" ||
                          syncStatus.status === "disabled" ||
                          syncStatus.status === "idle"
                        ? "bg-rose-500"
                        : "bg-emerald-500"
                  }`}
                />
                <span>
                  {syncStatus.status === "running" || syncStatus.schedulerSyncing
                    ? "Syncing"
                    : syncStatus.status === "error" ||
                        syncStatus.status === "disabled" ||
                        syncStatus.status === "idle"
                      ? "Error"
                      : "Connected"}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {lastSync
                    ? `Last sync ${formatDate(lastSync, true)}`
                    : "No successful sync yet"}
                </span>
                <span aria-hidden="true">·</span>
                <span aria-label="Time until next Gmail sync">
                  {syncStatus.schedulerEnabled && syncStatus.nextScheduledAt
                    ? `Next sync in ${formatCountdown(syncStatus.nextScheduledAt, countdownNow)}`
                    : "Next sync unavailable"}
                </span>
                {syncStatus.status === "success" && syncStatus.processedMessages > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {syncStatus.processedMessages} new{" "}
                      {syncStatus.processedMessages === 1 ? "email" : "emails"}
                    </span>
                  </>
                )}
              </div>
              {syncStatus.errorMessage && (
                <span className="max-w-full text-rose-700 sm:max-w-[440px] sm:text-right" role="status">
                  {syncStatus.errorMessage}
                </span>
              )}
            </div>
          </footer>
        </section>
      </div>
      {attachmentPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-sm sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAttachmentPreview(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${attachmentPreview.fileName}`}
            className="flex h-[min(90dvh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
          >
            <header className="flex min-h-16 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-6">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-slate-900 sm:text-base">
                  {attachmentPreview.fileName}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">{attachmentPreview.mimeType}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void downloadAttachment(attachmentPreview)}
                  disabled={attachmentPreviewLoading}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
                >
                  <ArrowDownToLine size={14} /> Download
                </button>
                <button
                  type="button"
                  aria-label="Close attachment preview"
                  onClick={() => setAttachmentPreview(null)}
                  className="grid size-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
                >
                  <X size={18} />
                </button>
              </div>
            </header>
            <div className="relative min-h-0 flex-1 bg-slate-100">
              {attachmentPreviewLoading ? (
                <div className="grid h-full place-items-center text-sm text-slate-600">
                  <span className="flex items-center gap-2">
                    <LoaderCircle size={18} className="animate-spin" /> Retrieving attachment…
                  </span>
                </div>
              ) : attachmentPreviewError ? (
                <div role="alert" className="grid h-full place-items-center p-6 text-center">
                  <div className="max-w-lg rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
                    <h3 className="text-base font-semibold text-slate-900">Attachment unavailable</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{attachmentPreviewError}</p>
                    {attachmentPreviewError.includes("S3 denied") && (
                      <p className="mt-3 text-xs leading-5 text-slate-600">
                        Ask the AWS administrator to grant <code>s3:GetObject</code> only on this app’s
                        private bucket <code>emails/*</code> prefix. Do not make the bucket public.
                      </p>
                    )}
                  </div>
                </div>
              ) : attachmentPreview.url && attachmentPreview.mimeType.toLowerCase().startsWith("image/") ? (
                <div className="flex h-full items-center justify-center overflow-auto p-4">
                  <Image
                    src={attachmentPreview.url}
                    alt={attachmentPreview.fileName}
                    width={1600}
                    height={1200}
                    unoptimized
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : attachmentPreview.url ? (
                <iframe
                  title={`PDF preview: ${attachmentPreview.fileName}`}
                  src={attachmentPreview.url}
                  className="h-full w-full border-0"
                />
              ) : null}
            </div>
          </section>
        </div>
      )}
      {syncNotification && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm font-medium text-emerald-800 shadow-lg"
        >
          <span className="grid size-5 place-items-center rounded-full bg-emerald-100 text-emerald-700">
            ✓
          </span>
          {syncNotification}
        </div>
      )}
    </main>
  );
}