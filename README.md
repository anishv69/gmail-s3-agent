# Gmail S3 Agent

A Next.js service that periodically checks one Gmail inbox, stores messages and
their metadata in PostgreSQL, uploads message attachments to a private S3
bucket, and displays archived messages in a dashboard.

The dashboard loads message details on selection and paginates/searches the
archive through authenticated APIs. Newly synchronized HTML message bodies are
stored separately and sanitized on the server before preview; existing
text-only archive rows remain readable without rewriting stored messages.
Gmail system labels are stored separately for server-side Inbox, Sent, Starred,
and Archive filters. Existing unlabelled archive rows remain visible in Inbox
until the resumable history scan refreshes their labels from Gmail.

## Requirements

- Node.js 20+
- A Google account for `varma5dev@gmail.com`
- A Google Cloud project with the Gmail API enabled
- PostgreSQL and an S3 bucket for full archival
- A scheduler that can make an authenticated HTTP POST request

## 1. Create Google OAuth credentials

Do not send passwords, verification codes, client secrets, or refresh tokens in
chat or commit them to source control. You will paste the credentials only into
your local `.env` file.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and
   create or select a project for this app.
2. In **APIs & Services → Library**, find **Gmail API** and click **Enable**.
3. Open **Google Auth Platform**:
   - Under **Branding**, configure the app name and user-support email. Add a
     developer contact email and save.
   - Under **Audience**, choose **External** for a personal Gmail account (or
     **Internal** only if this is a Google Workspace organization and the
     account belongs to it). If the app is in **Testing**, add
     `varma5dev@gmail.com` as a test user.
   - Under **Data Access**, add the scope
     `https://www.googleapis.com/auth/gmail.readonly`.
4. Under **Google Auth Platform → Clients**, choose **Create client** and
   select **Web application**.
   - Give it a recognizable name such as `Gmail S3 Agent Local`.
   - Add this exact **Authorized redirect URI**:
     `https://developers.google.com/oauthplayground`
   - Create the client. Copy its client ID and client secret into the matching
     local `.env` variables in step 3 below. Treat the client secret as
     sensitive.

## 2. Create a Gmail refresh token

1. Open [Google OAuth Playground](https://developers.google.com/oauthplayground).
2. Click the settings gear:
   - Enable **Use your own OAuth credentials**.
   - Enter the client ID and client secret from the previous section.
   - Close settings.
3. In the scope input, enter
   `https://www.googleapis.com/auth/gmail.readonly`, then click **Authorize
   APIs**.
4. Sign in as **`varma5dev@gmail.com`** and review/allow the requested
   read-only Gmail access. Google may display an unverified-app warning while
   the app is in Testing; proceed only if the project and scope are the ones
   you configured.
5. Click **Exchange authorization code for tokens**. Copy the **refresh
   token** from the response directly into `GOOGLE_REFRESH_TOKEN` in your
   local `.env`. Do not paste it into chat, a ticket, or a source file.

For a personal Gmail account, an External app left in **Testing** can issue
refresh tokens that expire after seven days when using Gmail scopes. For
ongoing use, review the consent-screen publishing and Google verification
requirements for sensitive scopes. Do not publish or request verification
without approval from the project owner/manager.

## 3. Configure the local application

From the project folder, create the ignored local environment file:

```powershell
Copy-Item .env.example .env
```

Open `.env` locally and set:

- `GMAIL_USER_EMAIL=varma5dev@gmail.com`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`
- `CRON_SECRET` to a long random value of your own
- `DATABASE_URL`, `S3_BUCKET`, and `AWS_REGION` for full archival

Keep `.env` private. It is excluded from Git. The app never needs your Gmail
password or a one-time verification code.

## 4. Test Gmail OAuth without starting archival

Start the app locally:

```powershell
npm install
npm run dev
```

In a second PowerShell window, run this script. It asks for `CRON_SECRET`
without echoing it, sends it only to your local server, and prints the response.
The Gmail-only check does not require PostgreSQL or S3 and never returns OAuth
credentials.

```powershell
$secureSecret = Read-Host "Enter your local CRON_SECRET" -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
  $cronSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  $result = Invoke-RestMethod `
    -Method Post `
    -Uri http://localhost:3000/api/cron/gmail-check `
    -Headers @{ Authorization = "Bearer $cronSecret" }
  $result | Format-List
}
catch {
  Write-Output "Gmail check failed. Check the HTTP status and the Next.js terminal for details."
  if ($_.Exception.Response) {
    Write-Output "HTTP status: $([int]$_.Exception.Response.StatusCode)"
  }
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  Remove-Variable cronSecret -ErrorAction SilentlyContinue
}
```

A successful response looks like:

```text
ok             : True
connectedEmail : varma5dev@gmail.com
message        : Gmail OAuth connection is working.
```

An HTTP `401` means the entered `CRON_SECRET` does not match the local `.env`.
An HTTP `409` means the refresh token authorized a different Google account.
A `500` means the server could not verify Gmail access; check the terminal
where `npm run dev` is running, then confirm the Gmail API is enabled, the
account is a test user if needed, and the OAuth values are correct. Never copy
the refresh token or client secret into the terminal output or chat.

The server logs only a safe diagnostic category and Google HTTP status, never
credential values. If the category is `oauth_client_not_authorized` with
Google HTTP 401 (`unauthorized_client`), Google rejected the refresh-token
grant before a Gmail API request was made. In Google OAuth Playground, enable
**Use your own OAuth credentials** and verify it uses the exact current Web
application client ID and secret configured in `.env`. Confirm the Gmail
account is a test user while the consent screen is in Testing, authorize the
`gmail.readonly` scope again, exchange the code for a new refresh token, and
replace `GOOGLE_REFRESH_TOKEN` locally. Restart `npm run dev` and retry the
Gmail check. If the client secret was exposed, rotate it in Google Cloud first,
then use the new secret consistently in `.env` and OAuth Playground when
issuing the replacement refresh token.

## 5. Configure AWS S3, the database, and polling

1. Configure local PostgreSQL using Docker. Ensure the ignored project `.env`
   has `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`, plus a matching
   `DATABASE_URL`. The repository's `compose.yaml` starts PostgreSQL 16 with a
   named persistent volume bound only to localhost on port `5433` (port
   `5432` is occupied by another local PostgreSQL container):

   ```powershell
   docker compose up -d postgres
   docker compose ps
   ```
2. In the [AWS S3 console](https://s3.console.aws.amazon.com/s3/buckets), create
   a bucket in **US East (Ohio) `us-east-2`**. Keep **Block all public access**
   enabled and leave the bucket private. Note its bucket name and set
   `S3_BUCKET` and `AWS_REGION=us-east-2` in `.env`. The application uploads
   objects under `emails/*`; it does not make objects public.
3. Give the app's AWS identity only permission to upload objects and read back
   archived attachments from this
   bucket. For a dedicated IAM policy, replace `<BUCKET_NAME>` below with your
   bucket name and attach the policy to the identity used by the app:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:GetObject"],
         "Resource": "arn:aws:s3:::<BUCKET_NAME>/emails/*"
       }
     ]
   }
   ```

   `s3:GetObject` is used only by the authenticated attachment-download
   endpoint; the bucket remains private.

   For local development, put that policy on a dedicated IAM identity and set
   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in your local `.env`. Never
   commit or share those keys. For deployment on AWS, prefer an attached IAM
   role/task role instead of long-lived access keys; the AWS SDK will use the
   role credentials automatically. Do not use root-account credentials.
4. Verify AWS separately before configuring Gmail polling or migrating the
   database. Start `npm run dev`, then run the secure PowerShell test script
   from section 4, changing only its `-Uri` value to
   `http://localhost:3000/api/cron/s3-check`.

   The S3 check uploads a small marker object to
   `emails/.gmail-s3-agent-connection-check`. It does not read or delete
   objects. A successful response confirms the configured AWS credentials can
   upload to the bucket. If it fails, verify the region, bucket name, access
   key, and IAM policy. Keep the bucket private.

5. Apply the Prisma schema to the running PostgreSQL database:

   ```powershell
   npx prisma migrate dev --name init
   ```

   For later deployments, use `npx prisma migrate deploy`.

6. Automatic polling starts with the Node.js Next.js server when
   `GMAIL_SYNC_ENABLED="true"` is set. It runs once at startup, then every one
   minute (`GMAIL_SYNC_INTERVAL_MS="60000"`). Keep the app process running.
   For a manual poll, send `POST /api/cron/poll` with
   `Authorization: Bearer <CRON_SECRET>`.

For a one-time bounded smoke test, send an authenticated `POST` to
`/api/cron/sync-sample`. It processes at most the five newest inbox messages,
uses the same PostgreSQL/S3 storage path, skips messages already stored, and
does not advance the regular polling checkpoint.

### Local PostgreSQL persistence

The PostgreSQL data persists in the Docker volume `gmail_s3_agent_postgres`
when the container is stopped or recreated. Do not run `docker compose down -v`
unless you intend to delete the local database volume.

The first automatic poll imports inbox messages from the last
`GMAIL_LOOKBACK_DAYS` (30 by default). Later polls use a persisted checkpoint
with a short overlap and deduplicate by Gmail message ID. A failed poll does
not advance the checkpoint. Attachments are stored under deterministic S3 keys;
the bucket should remain private. Already archived messages are skipped before
attachment upload, and concurrent sync requests in the same Node.js process
share one in-flight poll. `MAX_ATTACHMENT_MB` limits each attachment. Scheduler
logs include start/completion timestamps, new-message and duplicate counts,
durations, and safe error categories. A historical import processes one
paginated batch per request and uses the same PostgreSQL advisory lock, so it
can temporarily defer a scheduled poll but cannot run concurrently with it.

The in-process scheduler is intended for one continuously running Node.js
server. For serverless or multi-instance deployments, disable it with
`GMAIL_SYNC_ENABLED="false"` and use a single external scheduler to call the
authenticated polling endpoint instead. Scheduled polls also acquire a
PostgreSQL advisory lock, so only one app process can run a scheduler cycle at
a time even if multiple instances are accidentally started.

### Browse and backfill archived email

The dashboard uses PostgreSQL-backed pages of 25 messages, with server-side
search over sender, recipients, subject, snippet, and archived text content.
Inbox, Sent, Starred, and Archive filters use stored Gmail labels; the Files
filter lists messages with attachments. Selecting a message loads the full archived body;
attachment links use the authenticated `/api/attachments/:id` route and require
`s3:GetObject` for the private `emails/*` prefix.
PDF and raster-image attachments can be previewed inline; other attachment
types remain download-only. If the API returns HTTP 403 with an S3 access-denied
message, grant `s3:GetObject` only on
`arn:aws:s3:::<BUCKET_NAME>/emails/*`; never make the bucket public.

Choose **Archive history** to process one Gmail API page (up to 100 messages),
then **Continue history** to resume from the persisted Gmail page token.
Choose **Restart history** only if you intentionally want to restart the
backfill from the newest message; it does not delete any archived data.
Progress is saved after each complete page; retries safely skip existing
message records and use conditional S3 object writes to avoid re-uploading
objects. Existing messages have their labels refreshed during the history scan
without re-uploading attachments. The history status API does not expose the Gmail page token. The
historical scan includes accessible messages in Spam and Trash. The interface
is read-only: reply, forward, delete, and read-status actions are not offered
with Gmail's read-only OAuth scope.

The Node.js scheduler polls the inbox every minute by default when
`GMAIL_SYNC_ENABLED=true`. The dashboard checks the authenticated
`/api/sync-status` endpoint and refreshes its email list after a successful
poll, without a browser reload. It displays scheduler status, the last
successful sync time, and a safe actionable error when a poll fails. The
PostgreSQL advisory lock prevents overlapping poll cycles across app processes.
Email `receivedAt` values come from Gmail's `internalDate`, are stored as
PostgreSQL `TIMESTAMPTZ`, and are formatted in the browser's local timezone.
During the resumable history scan, existing records are corrected from Gmail's
original `internalDate` without re-uploading attachments or duplicating email
records.

## Bounded demo email sender

The optional demo sender sends fictional sample messages from a **separately
authorized sender account** to `varma5dev@gmail.com`. It does not use or modify
the application's read-only Gmail OAuth values. Set
`DEMO_SENDER_EMAIL`, `DEMO_GOOGLE_CLIENT_ID`,
`DEMO_GOOGLE_CLIENT_SECRET`, and `DEMO_GOOGLE_REFRESH_TOKEN` in the ignored
local `.env`; authorize that sender with the Gmail API
`https://www.googleapis.com/auth/gmail.send` scope. Never paste sender
credentials into chat or logs.

After configuring the separate sender account and approving the test, send
exactly one delivery test:

```powershell
npm run demo:test -- --confirm-send
```

After confirming that test arrives, separately approve and start the campaign:

```powershell
npm run demo:run -- --confirm-send
```

The campaign sends immediately and then every two minutes, stops within 30
minutes, and never attempts more than 15 messages. It uses an exclusive
process lock and persistent attempt state to refuse a second test or campaign.
It does not retry an ambiguous send failure. A few messages include small PDF
or CSV attachments containing fictional data only. Stop it from another
terminal with `npm run demo:stop`, or press Ctrl+C in its terminal. The stop
command requests a clean stop before the next message. Logs contain send counts
and safe error status/code only, never credentials or message bodies. This
script does not change or restart the one-minute inbox synchronization
scheduler.

## Render deployment preparation

The app includes a multi-stage `Dockerfile` that builds Next.js in standalone
mode, runs as a non-root user, excludes `.env` and local files from the image,
applies Prisma migrations at container startup, and serves the app on Render's
`PORT`. `/api/health` provides a minimal database-backed health check.

1. Push the project to a private or appropriately access-controlled Git
   repository. Confirm `.env` is ignored by Git; never commit it.
2. In Render, create a **PostgreSQL** database in the same region as the web
   service. Use its **Internal Database URL** for the app's `DATABASE_URL`.
3. Create a **Web Service** from the repository and choose **Docker**. Use the
   repository root as the Docker build context. Set health check path to
   `/api/health`; the container listens on the Render-provided `PORT`.
4. Add these environment variables in Render's service settings. Enter secrets
   directly in Render's encrypted environment editor, never in `render.yaml`,
   chat, Git, or image build arguments:
   - `DATABASE_URL` (Render PostgreSQL internal URL)
   - `GMAIL_USER_EMAIL`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REFRESH_TOKEN`
   - `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`,
     `AWS_SECRET_ACCESS_KEY`
   - `CRON_SECRET`
   - `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` (use a unique strong
     password; Render HTTPS protects Basic authentication in transit)
   - `GMAIL_SYNC_ENABLED=true`, `GMAIL_SYNC_INTERVAL_MS=60000`
   - `GMAIL_LOOKBACK_DAYS=30`, `MAX_ATTACHMENT_MB=25`
5. Review the planned service and database sizes/costs, then deploy when ready.
   The container runs `prisma migrate deploy` before starting Next.js. Startup
   logs report migration failures without printing environment values.
6. Visit the Render service URL. The browser prompts for dashboard Basic
   authentication. Check `/api/health`; confirm startup logs show
   `[gmail-sync] scheduler_started`, followed by safe cycle summary logs.

Keep the web service at one instance unless intentionally scaling. The database
advisory lock prevents overlapping scheduled cycles across instances, but
additional app instances still increase infrastructure cost. Use a Render
private database URL and do not expose PostgreSQL publicly. This preparation
does not create Render resources or deploy the application.

## Commands

```powershell
npm run dev
npm run lint
npm run build
npx prisma migrate dev
npx prisma migrate deploy
```
