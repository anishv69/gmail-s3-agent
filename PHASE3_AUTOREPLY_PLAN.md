# Phase 3: Smart Auto-Reply System

## Overview
Generate and send contextual AI-powered responses to incoming emails based on content understanding.

## Architecture

### 1. Auto-Reply Generator (`src/lib/ai/auto-reply.ts`)
- Input: Email content (sender, subject, body)
- Process: 
  - Extract email intent (question, request, notification, etc.)
  - Generate contextual response using LLM
  - Return draft reply
- Output: Generated email body

### 2. Auto-Reply Settings UI (`src/app/settings/auto-reply`)
- Enable/disable auto-reply
- Configure response templates
- Set filtering rules:
  - Auto-send to known contacts
  - Draft-only for unknown senders
  - Exclude specific senders/subjects
- Response tone settings (professional, friendly, etc.)

### 3. Auto-Reply Processing Worker
- Triggered on new email (via Gmail sync cron)
- Check auto-reply settings
- Generate response
- Send or save as draft
- Log all replies for audit trail

### 4. Auto-Reply Management UI (`src/app/auto-replies`)
- View all generated replies
- Edit before sending
- Resend or delete
- Filter by sender, date, status

## Data Model

```sql
CREATE TABLE AutoReplySettings (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  enabled BOOLEAN DEFAULT false,
  autoSendToKnown BOOLEAN DEFAULT false,
  responseTemplate TEXT,
  responseTone TEXT DEFAULT 'professional',
  excludeSenders TEXT[], -- JSON array of email addresses
  excludeSubjects TEXT[], -- JSON array of subject patterns
  createdAt TIMESTAMP DEFAULT NOW()
);

CREATE TABLE AutoReplies (
  id TEXT PRIMARY KEY,
  emailId TEXT NOT NULL REFERENCES Email(id),
  originalSender TEXT NOT NULL,
  generatedReply TEXT NOT NULL,
  status TEXT DEFAULT 'draft', -- draft, sent, skipped
  sentAt TIMESTAMP,
  createdAt TIMESTAMP DEFAULT NOW()
);
```

## Implementation Steps

1. ✅ Create `src/lib/ai/auto-reply.ts` - Reply generator function
2. ✅ Create API endpoint `/api/ai/generate-reply`
3. ✅ Add database tables for settings & replies
4. ✅ Integrate into email sync cron job
5. ✅ Build settings UI (`/settings/auto-reply`)
6. ✅ Build management dashboard (`/auto-replies`)
7. ✅ Add manual trigger button on each email
8. ✅ Test end-to-end workflow

## Current Progress
- [ ] Auto-reply generator
- [ ] API endpoint
- [ ] Database schema
- [ ] Email sync integration
- [ ] UI components
