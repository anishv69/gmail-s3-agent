# Vercel Production Deployment Guide
## Gmail S3 AI Agent — Phase 2

**Status:** Ready for production rollout  
**Date Prepared:** Oct 22, 2026  
**Tested on:** Neon ai-rag-testing branch  
**Test Result:** ✅ PASSED (AI Q&A with citations working)

---

## Overview

This guide covers deploying the AI RAG (Retrieval-Augmented Generation) feature to production on Vercel. The feature adds:
- Vector embeddings (pgvector) for semantic search
- AI-powered Q&A on indexed emails and S3 documents
- Grounded answers with source citations
- No breaking changes to existing Gmail sync

**Key Safety Principles:**
- ✅ No automatic migrations (manual approval required)
- ✅ Database snapshot before migration
- ✅ Production secrets never exposed
- ✅ Rollback plan ready
- ✅ No changes to production Gmail data

---

## Phase 1: Pre-Deployment (Local/Dev)

### 1.1 Code Review
- [ ] Review all AI-related files for hardcoded secrets or credentials
- [ ] Verify `.gitignore` includes `.env*` (checked: ✅ `.env.example` present)
- [ ] Confirm no test/debug code left in production paths
- [ ] Check TypeScript builds cleanly: `npm run build` (tested: ✅ PASSED)

### 1.2 Git Hygiene
```bash
# Ensure branch is clean
git status
git log --oneline -5

# Create a feature branch for the AI RAG feature
git checkout -b feat/ai-rag-production
```

### 1.3 Environment Variables Audit
- [ ] Confirm `.env.example` documents all required variables:
  - `DATABASE_URL` (Neon pooled)
  - `DIRECT_URL` (Neon direct, for migrations/locks)
  - `OPENAI_API_KEY`
  - `S3_BUCKET`, `S3_REGION`
  - `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
  - `DASHBOARD_USER`, `DASHBOARD_PASS`
  - `CRON_SECRET`
  - Other existing vars (Gmail OAuth, etc.)

### 1.4 Files Changed (Summary)
```
New AI/RAG files:
✅ src/app/ai-assistant/page.tsx
✅ src/components/ai-assistant.tsx
✅ src/app/api/ai/ask/route.ts
✅ src/app/api/ai/index/route.ts
✅ src/app/api/ai/search/route.ts
✅ src/app/api/ai/index-status/route.ts
✅ src/lib/ai/openai.ts
✅ src/lib/ai/extract-document.ts
✅ src/lib/ai/chunking.ts
✅ src/lib/ai/index-document.ts
✅ src/lib/ai/indexing.ts
✅ src/lib/ai/database.ts
✅ src/lib/s3-client.ts (existing, no breaking changes)
✅ prisma/schema.prisma (added AI models, vector extension)
✅ prisma/migrations/20261019000000_add_ai_rag_index/migration.sql

Existing files (unchanged):
✅ Gmail sync logic
✅ Dashboard APIs
✅ Email storage
```

### 1.5 Test Verification
- [ ] Offline AI tests pass: `npm run test` (tested: ✅ 10/10 PASSED)
- [ ] Live end-to-end test passed on ai-rag-testing (tested: ✅ PASSED)
- [ ] Gmail dashboard still works (tested: ✅ PASSED)
- [ ] /api/ai/ask returns correct answers with citations (tested: ✅ VERIFIED)

---

## Phase 2: GitHub / CI Setup

### 2.1 Create Pull Request
```bash
git add .
git commit -m "feat: Add AI RAG assistant with pgvector and OpenAI integration

- Add /ai-assistant page for question-answering on indexed emails/docs
- Implement RAG pipeline: extract → chunk → embed → store → retrieve
- Add pgvector extension and AI document/chunk tables to Neon
- Add least-privilege S3 IAM policy for rag-test/ prefix
- Integrate with existing Prisma and Neon setup
- No breaking changes to Gmail sync or dashboard

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

git push origin feat/ai-rag-production
```

### 2.2 PR Checklist (Add to PR Description)
```markdown
## Pre-Merge Checklist

- [ ] Code review: no hardcoded secrets, no debug code
- [ ] TypeScript builds cleanly
- [ ] All tests pass
- [ ] .env.example is updated with AI variables
- [ ] No changes to Gmail sync or existing APIs
- [ ] No production migrations run yet
- [ ] Security: S3 IAM policy is least-privilege (rag-test/ prefix)

## Production Migration Plan (Manual Step)
- Neon migration file: `20261019000000_add_ai_rag_index`
- This PR does NOT run the migration
- Migration scheduled for: [DATE/TIME DECIDED BY OPS]
- Database snapshot taken: [SNAPSHOT ID]
```

### 2.3 Vercel Preview Deploy
- [ ] Merge PR to `main` or use Vercel preview deploy
- [ ] Wait for Vercel to build and deploy preview
- [ ] Verify preview environment variables are set (test Neon branch, test AWS keys if needed)

### 2.4 Preview Verification
```bash
# Once preview is live, run smoke tests
curl -s https://[preview-url]/api/health | jq .
curl -s https://[preview-url]/ai-assistant | head -20
curl -s -X POST https://[preview-url]/api/ai/ask \
  -H "Authorization: Basic [CREDS]" \
  -H "Content-Type: application/json" \
  -d '{"question": "test"}' | jq .
```

---

## Phase 3: Production Neon Setup

### 3.1 Production Database Planning

**Before touching production:**

1. **Backup production Neon database**
   - Go to Neon Console → Production branch
   - Click "Branch settings" → "Backup"
   - Take a full snapshot (note the snapshot ID)
   - Confirm restore plan works (test restore to a temporary branch)

2. **Verify connection strings**
   ```bash
   # MUST confirm these point to production, NOT test branch
   echo $DATABASE_URL | grep -i production  # should NOT contain "ai-rag-testing"
   echo $DIRECT_URL | grep -i production    # should NOT contain "ai-rag-testing"
   
   # Optional: verify branch ID from Neon Console
   # Production branch ID should be something like: br-main-[hash]
   # Test branch ID was: br-spring-mode-b45g323n (WRONG for production)
   ```

3. **Check connection pool limits**
   - Neon default: 100 connections per project
   - Current usage: Check Neon Console → Monitoring
   - Ensure headroom for new vector queries

### 3.2 Pre-Migration Verification (Read-Only)

**Run these from a local machine or Vercel pre-deploy step:**

```sql
-- Check existing data is safe
SELECT COUNT(*) as email_count FROM "GmailMessage";
SELECT COUNT(*) as label_count FROM "GmailLabel";

-- Verify no conflicting tables
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('AiDocument', 'AiDocumentChunk', 'AiIndexState');
-- Result: should be empty (0 rows)

-- Check current extensions
SELECT extname FROM pg_extension;
-- Result: vector should NOT be present yet
```

---

## Phase 4: Production Migration (Manual, Operator-Gated)

### 4.1 Migration Plan Document
Create a migration ticket/doc with this info:

```
Migration: Add pgvector and AI tables to production Neon
Migration file: 20261019000000_add_ai_rag_index
Estimated duration: 2–5 minutes
Estimated downtime: None (schema-only, no data changes)
Rollback plan: Restore from Neon snapshot [ID]
Risk level: LOW (no changes to existing tables)

Pre-migration snapshot ID: [SNAPSHOT_ID]
Migration window: [DATE] [TIME UTC]
Approver: [OPS TEAM LEAD]
Operator: [WHO WILL RUN THIS]
```

### 4.2 Migration Execution (Step-by-Step)

**Step 1: Prepare environment**
```bash
# On a trusted machine with production secrets
export DIRECT_URL="[production-direct-url-from-neon]"
export DATABASE_URL="[production-pooled-url-from-neon]"

# Verify we're targeting production (NOT test branch)
psql $DIRECT_URL -c "SELECT current_setting('neon.branch_id', true) AS branch_id;"
# Expected: should NOT contain "ai-rag-testing"

# Verify no existing AI tables
psql $DIRECT_URL -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('AiDocument', 'AiDocumentChunk', 'AiIndexState');"
# Expected: 0
```

**Step 2: Run Prisma migration**
```bash
# Run the pending migration
npx prisma migrate deploy

# Output should show:
# Applying migration: 20261019000000_add_ai_rag_index
# Migration complete
```

**Step 3: Verify migration succeeded**
```sql
-- 1. Check pgvector extension
SELECT extname FROM pg_extension WHERE extname = 'vector';
-- Expected: vector (exactly 1 row)

-- 2. Check AI tables exist
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('AiDocument', 'AiDocumentChunk', 'AiIndexState')
ORDER BY table_name;
-- Expected: 3 rows (AiDocument, AiDocumentChunk, AiIndexState)

-- 3. Check indexes
SELECT indexname FROM pg_indexes 
WHERE table_name IN ('AiDocument', 'AiDocumentChunk', 'AiIndexState')
ORDER BY indexname;
-- Expected: should include hnsw index on AiDocumentChunk(embedding)

-- 4. Verify existing Gmail tables are unchanged
SELECT COUNT(*) FROM "GmailMessage";
SELECT COUNT(*) FROM "GmailLabel";
-- Expected: same counts as pre-migration
```

**Step 4: Document completion**
```bash
# Timestamp and log
echo "Migration 20261019000000_add_ai_rag_index completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> MIGRATION_LOG.md
echo "Snapshot ID for rollback: [ID]" >> MIGRATION_LOG.md
```

### 4.3 Rollback Procedure (If Needed)

If migration causes issues:

```bash
# Option 1: Restore Neon from pre-migration snapshot
# 1. Go to Neon Console → Production branch → Branching → Restore
# 2. Select snapshot ID: [PRE_MIGRATION_ID]
# 3. Confirm and wait for restore to complete

# Option 2: Create a temporary child branch for testing
# (already proven safe on ai-rag-testing, can reuse that if needed)

# After rollback:
# - Revert any production environment changes
# - Identify root cause
# - Do NOT retry migration without fix
```

---

## Phase 5: Vercel Production Deploy

### 5.1 Set Production Environment Variables

**In Vercel Console:**
1. Go to Project → Settings → Environment Variables
2. Add/update these variables (use Vercel's encrypted storage):

```
DATABASE_URL=postgresql://[user]:[pass]@[neon-production].neon.tech/...
DIRECT_URL=postgresql://[user]:[pass]@[neon-production-direct].neon.tech/...
OPENAI_API_KEY=[production-key-or-restricted-key]
S3_BUCKET=gmail-s3-agent-2026-unique999
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=[least-privilege-iam-user]
S3_SECRET_ACCESS_KEY=[key]
S3_ENDPOINT= (if custom, else omit)
S3_FORCE_PATH_STYLE=false (unless required)
DASHBOARD_USER=[production-auth-user]
DASHBOARD_PASS=[production-auth-pass]
CRON_SECRET=[existing-secret]
[Other existing vars: Gmail OAuth, etc.]
```

**Do NOT store secrets in git or commit .env files.**

### 5.2 Promote to Production

```bash
# Option A: Manual approval in Vercel UI
# 1. Go to Deployment history
# 2. Find the build from merged feat/ai-rag-production branch
# 3. Click "Promote to Production"

# Option B: Automatic (if configured)
# Vercel auto-promotes merges to main branch

# Wait for deployment to complete (5–10 min)
# Watch Vercel deployment logs
```

### 5.3 Production Verification

Once deployed:

```bash
# 1. Health check
curl -s https://gmail-s3-agent.vercel.app/api/health | jq .
# Expected: { "status": "ok" }

# 2. AI Assistant page loads
curl -s https://gmail-s3-agent.vercel.app/ai-assistant | grep -o '<title>.*</title>'
# Expected: should contain page title

# 3. Check indexes are ready
curl -s -H "Authorization: Basic [CREDS]" \
  https://gmail-s3-agent.vercel.app/api/ai/index-status | jq .
# Expected: { "status": "ready", "... }

# 4. Test a single ask (optional, if you have a test doc indexed)
curl -s -X POST \
  -H "Authorization: Basic [CREDS]" \
  -H "Content-Type: application/json" \
  -d '{"question": "test"}' \
  https://gmail-s3-agent.vercel.app/api/ai/ask | jq .
# Expected: response with answer or "insufficient information" (normal)

# 5. Smoke test Gmail dashboard
curl -s -H "Authorization: Basic [CREDS]" \
  https://gmail-s3-agent.vercel.app/api/emails | jq '.total'
# Expected: number > 0 (your email count)
```

### 5.4 Monitor for Issues

**First 60 minutes post-deploy:**
- [ ] Check Vercel deployment logs for errors
- [ ] Monitor Neon database metrics (connections, CPU, queries/sec)
- [ ] Check application error logs (Vercel Functions logs, any third-party APM)
- [ ] Verify no unexpected OpenAI API usage spikes
- [ ] Confirm Gmail sync still works and email counts stable

---

## Phase 6: Post-Deployment Tasks

### 6.1 Document Completion
- [ ] Update deployment log with:
  - Merge date/time
  - Vercel deploy date/time
  - Migration date/time
  - Snapshot ID used
  - Any issues encountered and resolved
- [ ] Notify team of successful production deployment

### 6.2 Optional: Index Production Emails/Documents
- [ ] Plan indexing scope (e.g., last 30 days of emails, or a specific folder)
- [ ] Start with small batches to monitor OpenAI usage
- [ ] Monitor embedding costs and set alerts if needed
- [ ] Index selectively to avoid large bills

### 6.3 Monitoring & Alerts
- [ ] Set up alerts for:
  - Vercel function errors (5xx errors)
  - Neon connection pool saturation
  - OpenAI API rate limits or quota issues
  - Slow vector queries (>2s latency)
- [ ] Monitor Neon slow query log for newly added AI queries

### 6.4 Cleanup (Optional)
- [ ] Remove test PDF from S3: `s3://gmail-s3-agent-2026-unique999/rag-test/gmail-rag-demo-sample.pdf`
- [ ] Archive test Neon branch `ai-rag-testing` (keep for reference) or delete if no longer needed

---

## Contingency & Support

### If Something Goes Wrong

1. **Page returns 500 errors:**
   - Check Vercel Function logs
   - Verify DATABASE_URL and DIRECT_URL are set correctly
   - Confirm Neon database is accessible
   - Restart Vercel deployment

2. **Vector queries are slow:**
   - Check Neon slow query log
   - Verify HNSW index was created: `SELECT * FROM pg_indexes WHERE table_name = 'AiDocumentChunk';`
   - Increase `work_mem` or tune Neon compute if needed

3. **OpenAI API quota exceeded:**
   - Check OpenAI usage dashboard
   - Verify API key is valid and billing-enabled
   - Review indexing logs to identify cost drivers
   - Pause indexing and contact OpenAI support if needed

4. **Gmail data appears missing:**
   - THIS SHOULD NOT HAPPEN (AI migration doesn't touch GmailMessage/GmailLabel)
   - Check: `SELECT COUNT(*) FROM "GmailMessage";`
   - If counts changed, immediately restore from pre-migration snapshot

### Escalation & Support
- **Database issues:** Contact Neon support with snapshot ID and migration details
- **OpenAI API issues:** Contact OpenAI support with API key and request logs
- **Deployment issues:** Check Vercel docs or contact Vercel support
- **Code issues:** Review migration SQL and AI endpoint code for bugs

---

## Success Criteria

✅ **Phase 2 complete when:**
1. PR merged to main
2. Code builds cleanly on Vercel
3. Production migration applied successfully
4. pgvector extension enabled on production
5. AI tables created and indexed
6. /ai-assistant page loads on production
7. /api/ai/ask responds correctly with citations
8. Existing Gmail data intact
9. No unexpected errors in first 60 minutes
10. Team notified of successful deployment

---

## Timeline Estimate

| Phase | Task | Duration | Approver |
|-------|------|----------|----------|
| 1 | Code review & tests | 1–2 hours | Team Lead |
| 2 | PR & preview deploy | 15–30 min | —  |
| 3 | Neon backup & pre-checks | 30 min | DBA/Ops |
| 4 | Production migration | 5–15 min | Ops Lead (manual) |
| 5 | Vercel production deploy | 10–15 min | DevOps |
| 6 | Monitoring & verification | 60 min | On-call Engineer |

**Total time:** ~3–4 hours wall-clock, with human approval gates.

---

## Appendix: Useful Commands

### Check Neon branch ID
```bash
psql $DIRECT_URL -c "SELECT current_setting('neon.branch_id', true) AS branch_id;"
```

### List AI tables and indexes
```bash
psql $DIRECT_URL -c "
  SELECT t.tablename, i.indexname, i.indexdef 
  FROM pg_tables t 
  LEFT JOIN pg_indexes i ON t.tablename = i.tablename 
  WHERE t.schemaname = 'public' 
  AND t.tablename IN ('AiDocument', 'AiDocumentChunk', 'AiIndexState') 
  ORDER BY t.tablename, i.indexname;
"
```

### View migration SQL
```bash
cat prisma/migrations/20261019000000_add_ai_rag_index/migration.sql
```

### Monitor Neon performance
```bash
# In Neon Console:
# 1. Go to Production branch → Monitoring
# 2. Check: Connections, CPU %, Queries/sec, Active sessions
# 3. Look for unexpected spikes in connections or slow queries
```

---

**Document Version:** 1.0  
**Last Updated:** Oct 22, 2026  
**Status:** Ready for production deployment
