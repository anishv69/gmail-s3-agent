"use client";

import { useState, useEffect } from "react";
import { Send, Trash2, Edit2, ArrowLeft } from "lucide-react";
import Link from "next/link";

interface AutoReply {
  id: string;
  emailId: string;
  originalFrom: string;
  originalSubject: string;
  generatedReply: string;
  status: "draft" | "sent" | "pending_send" | "skipped";
  confidence: number;
  createdAt: string;
  sentAt: string | null;
}

export default function AutoRepliesPage() {
  const [replies, setReplies] = useState<AutoReply[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "draft" | "sent" | "pending_send">(
    "all"
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [sendingAll, setSendingAll] = useState(false);
  const [generatingBatch, setGeneratingBatch] = useState(false);
  const [displayCount, setDisplayCount] = useState(20);

  useEffect(() => {
    loadReplies();
  }, []);

  async function loadReplies() {
    try {
      const response = await fetch("/api/auto-replies");
      if (response.ok) {
        const data = await response.json();
        setReplies(data);
      }
    } catch (error) {
      console.error("Failed to load replies:", error);
    } finally {
      setIsLoading(false);
    }
  }

  async function sendReply(id: string, replyText: string) {
    try {
      const response = await fetch(`/api/auto-replies/${id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: replyText }),
      });

      if (response.ok) {
        setReplies(
          replies.map((r) =>
            r.id === id ? { ...r, status: "sent" as const, sentAt: new Date().toISOString() } : r
          )
        );
        setEditingId(null);
      }
    } catch (error) {
      console.error("Failed to send reply:", error);
    }
  }

  async function sendAllPending() {
    if (!confirm("Send all pending auto-replies?")) return;
    
    setSendingAll(true);
    try {
      const response = await fetch("/api/auto-replies/send-pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        const result = await response.json();
        // Reload replies to get updated statuses
        await loadReplies();
        alert(`Successfully sent ${result.sent} replies!`);
      }
    } catch (error) {
      console.error("Failed to send pending replies:", error);
      alert("Failed to send pending replies");
    } finally {
      setSendingAll(false);
    }
  }

  async function generateBatchReplies() {
    if (!confirm("Generate auto-replies for emails without replies? This may take a moment...")) return;
    
    setGeneratingBatch(true);
    try {
      const response = await fetch("/api/auto-replies/generate-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        const result = await response.json();
        // Reload replies to get new ones
        await loadReplies();
        alert(`Generated ${result.generated} new auto-replies!`);
      } else {
        const error = await response.json();
        alert(error.error || "Failed to generate batch replies");
      }
    } catch (error) {
      console.error("Failed to generate batch replies:", error);
      alert("Failed to generate batch replies");
    } finally {
      setGeneratingBatch(false);
    }
  }

  async function deleteReply(id: string) {
    if (!confirm("Delete this auto-reply?")) return;

    try {
      const response = await fetch(`/api/auto-replies/${id}`, {
        method: "DELETE",
      });

      if (response.ok) {
        setReplies(replies.filter((r) => r.id !== id));
      }
    } catch (error) {
      console.error("Failed to delete reply:", error);
    }
  }

  const filtered = replies.filter(
    (r) => filter === "all" || r.status === filter
  );

  const statusColors = {
    draft: "bg-yellow-100 text-yellow-800",
    sent: "bg-green-100 text-green-800",
    pending_send: "bg-blue-100 text-blue-800",
    skipped: "bg-gray-100 text-gray-800",
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-slate-600">Loading auto-replies...</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 pr-24">
      <div className="mb-6 flex items-center gap-4">
        <Link href="/" className="text-blue-600 hover:underline flex items-center gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back to Inbox
        </Link>
      </div>

      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Auto-Replies</h1>
        <div className="flex gap-3">
          <button
            onClick={sendAllPending}
            disabled={sendingAll || filtered.filter(r => r.status === 'pending_send').length === 0}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sendingAll ? "Sending..." : `Send All Pending (${filtered.filter(r => r.status === 'pending_send').length})`}
          </button>
          <button
            onClick={generateBatchReplies}
            disabled={generatingBatch}
            className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generatingBatch ? "Generating..." : "Generate More"}
          </button>
          <Link href="/settings/auto-reply" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            Settings
          </Link>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 mb-6 items-center justify-between">
        <div className="flex gap-2">
          {["all", "draft", "pending_send", "sent"].map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setFilter(tab as any);
                setDisplayCount(20); // Reset display count when filtering
              }}
              className={`px-4 py-2 rounded-lg font-medium transition ${
                filter === tab
                  ? "bg-blue-600 text-white"
                  : "bg-slate-200 text-slate-700 hover:bg-slate-300"
              }`}
            >
              {tab === "all"
                ? "All"
                : tab === "pending_send"
                ? "Pending"
                : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
        <div className="text-sm text-slate-600 font-medium">
          Showing {Math.min(displayCount, filtered.length)} of {filtered.length}
        </div>
      </div>

      {/* Replies List */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <p className="text-lg">No auto-replies yet</p>
          <p className="text-sm">Enable auto-reply in settings to get started</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.slice(0, displayCount).map((reply) => (
            <div key={reply.id} className="bg-white rounded-lg border border-slate-200 p-5">
              {/* Header Row */}
              <div className="flex justify-between items-start gap-4 mb-4">
                <div className="flex-1">
                  <p className="font-semibold text-slate-900">
                    From: {reply.originalFrom}
                  </p>
                  <p className="text-sm text-slate-600 mt-1">
                    Subject: {reply.originalSubject}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap ${
                      statusColors[reply.status]
                    }`}
                  >
                    {reply.status === "pending_send" ? "Pending" : reply.status}
                  </span>
                  <span className="text-xs text-slate-500 bg-slate-100 px-2 py-1 rounded whitespace-nowrap">
                    {(reply.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              </div>

              {/* Reply Text */}
              {editingId === reply.id ? (
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm mb-4"
                  rows={4}
                />
              ) : (
                <div className="bg-slate-50 px-4 py-3 rounded-lg mb-4 border border-slate-200">
                  <p className="text-sm text-slate-700 leading-relaxed">
                    {reply.generatedReply}
                  </p>
                </div>
              )}

              {/* Meta */}
              <div className="text-xs text-slate-500 mb-4">
                {new Date(reply.createdAt).toLocaleString()}
                {reply.sentAt && ` • Sent: ${new Date(reply.sentAt).toLocaleString()}`}
              </div>

              {/* Actions */}
              {reply.status === "draft" || reply.status === "pending_send" ? (
                <div className="mt-3 flex gap-2">
                  {editingId === reply.id ? (
                    <>
                      <button
                        onClick={() => sendReply(reply.id, editText)}
                        className="flex-1 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium flex items-center justify-center gap-2"
                      >
                        <Send className="h-4 w-4" />
                        Send Reply
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-3 py-2 bg-slate-300 text-slate-700 rounded-lg hover:bg-slate-400 text-sm font-medium"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setEditingId(reply.id);
                          setEditText(reply.generatedReply);
                        }}
                        className="flex-1 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium flex items-center justify-center gap-2"
                      >
                        <Edit2 className="h-4 w-4" />
                        Edit & Review
                      </button>
                      <button
                        onClick={() => sendReply(reply.id, reply.generatedReply)}
                        className="flex-1 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium flex items-center justify-center gap-2"
                      >
                        <Send className="h-4 w-4" />
                        Send Now
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => deleteReply(reply.id)}
                    className="px-3 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          
          {/* Load More Button */}
          {displayCount < filtered.length && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() => setDisplayCount(displayCount + 20)}
                className="px-6 py-2 bg-slate-600 text-white rounded-lg hover:bg-slate-700 font-medium text-sm"
              >
                Load More ({filtered.length - displayCount} remaining)
              </button>
            </div>
          )}
          
          {/* Show All Button */}
          {displayCount < filtered.length && (
            <div className="flex justify-center pt-2">
              <button
                onClick={() => setDisplayCount(filtered.length)}
                className="px-6 py-2 text-slate-600 text-sm hover:underline"
              >
                Show All
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
