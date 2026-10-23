import { getOpenAiClient, CHAT_MODEL } from "@/lib/ai/openai";

export interface EmailToReply {
  from: string;
  subject: string;
  body: string;
  snippet: string;
}

export interface GeneratedReply {
  reply: string;
  tone: string;
  confidence: number;
  shouldAutoSend: boolean;
}

const REPLY_GENERATION_PROMPT = `You are an email assistant that generates professional, contextual email replies.

Analyze the incoming email and generate a concise, professional response.

Requirements:
- Keep replies short (2-3 sentences max)
- Match the tone of the incoming email
- Be helpful and clear
- Never make commitments you can't keep
- If it's a request you can't fulfill, politely decline

Return JSON with:
{
  "reply": "The response text",
  "tone": "professional|friendly|formal",
  "confidence": 0.0-1.0,
  "shouldAutoSend": true|false
}

shouldAutoSend should be true ONLY if:
- It's a simple acknowledgment
- It answers a straightforward question
- It's a response to a known/trusted sender

Otherwise return false (save as draft for user review).`;

export async function generateAutoReply(email: EmailToReply): Promise<GeneratedReply> {
  const client = getOpenAiClient();

  const prompt = `${REPLY_GENERATION_PROMPT}

INCOMING EMAIL:
From: ${email.from}
Subject: ${email.subject}
Body: ${email.body}`;

  const response = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.7,
    max_tokens: 300,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Failed to generate auto-reply");
  }

  try {
    const parsed = JSON.parse(content);
    return {
      reply: parsed.reply || "",
      tone: parsed.tone || "professional",
      confidence: parsed.confidence || 0.7,
      shouldAutoSend: parsed.shouldAutoSend || false,
    };
  } catch {
    // If JSON parsing fails, return a safe default
    return {
      reply:
        "Thank you for your email. I'll review this and get back to you soon.",
      tone: "professional",
      confidence: 0.5,
      shouldAutoSend: false,
    };
  }
}

export async function generateAutoReplyWithTemplate(
  email: EmailToReply,
  template?: string,
  tone: "professional" | "friendly" | "formal" = "professional",
): Promise<GeneratedReply> {
  const client = getOpenAiClient();

  const prompt = `You are an email assistant that generates replies using templates when provided.

${template ? `Use this template as a base: ${template}` : "Generate a contextual response."}

Match the tone to: ${tone}

Analyze the incoming email and generate a concise response.

Requirements:
- Keep replies short (2-3 sentences max)
- Match the tone of the incoming email
- Be helpful and clear
- Never make commitments you can't keep

Return JSON with:
{
  "reply": "The response text",
  "tone": "${tone}",
  "confidence": 0.0-1.0,
  "shouldAutoSend": true|false
}`;

  const response = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "user",
        content: `${prompt}\n\nINCOMING EMAIL:\nFrom: ${email.from}\nSubject: ${email.subject}\nBody: ${email.body}`,
      },
    ],
    temperature: 0.7,
    max_tokens: 300,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Failed to generate auto-reply");
  }

  try {
    return JSON.parse(content);
  } catch {
    return {
      reply:
        template || "Thank you for your email. I'll review this and get back to you soon.",
      tone,
      confidence: 0.5,
      shouldAutoSend: false,
    };
  }
}
