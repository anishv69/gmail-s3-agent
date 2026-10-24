"use client";

export type StreamSource = {
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

export type ConversationTurnInput = {
  role: "user" | "assistant";
  content: string;
};

type StreamEvent =
  | { type: "token"; value: string }
  | { type: "done"; answer: string; sources: StreamSource[] }
  | { type: "error"; message: string };

/**
 * Calls /api/ai/ask and streams the response as newline-delimited JSON,
 * invoking onToken as each chunk of text arrives so the UI can render the
 * answer live. onDone fires once with the final, authoritative answer text
 * and sources - callers should replace any accumulated token text with it,
 * since the server may append a "Sources: ..." suffix or correct citation
 * markers only after the full text is known.
 */
export async function streamAiAnswer(options: {
  question: string;
  history?: ConversationTurnInput[];
  timeZone?: string;
  onToken: (text: string) => void;
  onDone: (result: { answer: string; sources: StreamSource[] }) => void;
  onError: (message: string) => void;
}): Promise<void> {
  const { question, history, timeZone, onToken, onDone, onError } = options;

  function processLine(line: string) {
    let event: StreamEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "token") {
      onToken(event.value);
    } else if (event.type === "done") {
      onDone({ answer: event.answer, sources: event.sources ?? [] });
    } else if (event.type === "error") {
      onError(event.message || "Unable to generate an answer.");
    }
  }

  try {
    const response = await fetch("/api/ai/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        question,
        history: history ?? [],
        timeZone: timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
      }),
    });

    if (!response.ok || !response.body) {
      let message = "Unable to generate an answer.";
      try {
        const data = await response.json();
        if (data && typeof data.error === "string") message = data.error;
      } catch {
        // Response wasn't JSON; keep the default message.
      }
      onError(message);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) processLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    const remaining = buffer.trim();
    if (remaining) processLine(remaining);
  } catch (error) {
    onError(error instanceof Error ? error.message : "Unable to generate an answer.");
  }
}
