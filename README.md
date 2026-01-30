# Ghoodoo

Cloudflare Worker that syncs GitHub commits and PRs with Odoo tasks via `ODP-XXX` references.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

Set the following secrets using `wrangler secret put`:

```bash
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_TOKEN
wrangler secret put ODOO_URL
wrangler secret put ODOO_DATABASE
wrangler secret put ODOO_USERNAME
wrangler secret put ODOO_API_KEY
wrangler secret put ODOO_STAGE_DONE
wrangler secret put ODOO_STAGE_IN_PROGRESS  # optional
wrangler secret put ODOO_STAGE_CANCELED     # optional
wrangler secret put ODOO_USER_MAPPING       # optional
wrangler secret put ODOO_DEFAULT_USER_ID    # optional
```

| Secret | Description |
|--------|-------------|
| `GITHUB_WEBHOOK_SECRET` | Secret for webhook signature verification |
| `GITHUB_TOKEN` | GitHub PAT for posting PR comments |
| `ODOO_URL` | Odoo instance URL (e.g., `https://mycompany.odoo.com`) |
| `ODOO_DATABASE` | Odoo database name |
| `ODOO_USERNAME` | Login email for the Odoo API user (e.g., `bot@company.com`) |
| `ODOO_API_KEY` | Odoo API key for authentication |
| `ODOO_STAGE_DONE` | Stage for merged PRs with close keywords (ID or name, e.g., `Done` or `4`) |
| `ODOO_STAGE_IN_PROGRESS` | Optional: Stage when PR opened (e.g., `In Progress`) |
| `ODOO_STAGE_CANCELED` | Optional: Stage when PR closed without merge (e.g., `Canceled`) |
| `ODOO_USER_MAPPING` | Optional: JSON mapping GitHub email → Odoo email (see below) |
| `ODOO_DEFAULT_USER_ID` | Optional: Fallback Odoo user ID when no mapping found |

### 2b. Create Odoo service account with Vodoo (recommended)

If you have the `vodoo` CLI (see https://github.com/julian/vodoo/blob/main/docs/SECURITY.md), use it to create a bot user and assign the API permission groups:

```bash
# Creates the Vodoo API groups (idempotent)
vodoo security create-groups

# Create a bot user and assign all Vodoo API groups
ODOO_USERNAME=admin@example.com ODOO_PASSWORD=... \
vodoo security create-user "Ghoodoo Bot" bot@company.com --assign-groups
```

Minimum required groups for Ghoodoo are **API Base** and **API Project** (task + chatter access). The `--assign-groups` flag assigns all Vodoo API groups; if you want least-privilege, remove extra groups in Odoo or adjust group membership manually.

Also add the bot user as a follower on any projects whose tasks should be updated.

### 3. Deploy

```bash
npm run deploy
```

### 4. Configure GitHub webhook

1. Go to your repository Settings → Webhooks → Add webhook
2. Set Payload URL to `https://ghoodoo.<your-subdomain>.workers.dev/webhook`
3. Set Content type to `application/json`
4. Set Secret to match `GITHUB_WEBHOOK_SECRET`
5. Select events: `Push` and `Pull requests`

## Usage

Reference Odoo tasks in commit messages or PR descriptions:

| Syntax | Effect |
|--------|--------|
| `ODP-123` | Adds comment to task |
| `Refs ODP-123` | Adds comment to task |
| `References ODP-123` | Adds comment to task |
| `Closes ODP-123` | Adds comment + moves to Done (on merge) |
| `Fixes ODP-123` | Adds comment + moves to Done (on merge) |
| `Resolves ODP-123` | Adds comment + moves to Done (on merge) |

### Message Format

When a commit or PR references an Odoo task, a message is posted to the task's chatter:

**Commit reference:**
```
🔗 Referenced in commit a2d8a46: Fix login validation
```

**PR reference:**
```
🔗 Referenced in PR #42 (opened)
🔗 Referenced in PR #42 (merged)
🔗 Referenced in PR #42 (closed)
```

- Messages include a clickable GitHub icon and links to the commit/PR
- Messages are posted as the API/bot user (see note below)

### Stage Transitions

Tasks are moved to different stages based on PR actions (if configured):

| PR Action | Stage Used | Condition |
|-----------|------------|-----------|
| Opened/Reopened | `ODOO_STAGE_IN_PROGRESS` | If configured |
| Merged | `ODOO_STAGE_DONE` | If `Closes`/`Fixes`/`Resolves` keyword used |
| Closed (not merged) | `ODOO_STAGE_CANCELED` | If configured |

> **Note:** Stage transitions only work for tasks that belong to a project. Personal/private tasks cannot have project stages assigned.

### Message Author

Messages are always posted as the API/bot user. While the code attempts to set the `author_id` field based on user mapping, Odoo's security model prevents share/portal users from impersonating other users when creating messages.

**To have messages appear as different users**, the API user must be an **internal user** (not a share/portal user) with appropriate permissions. This is typically not recommended for bot accounts due to licensing costs.

### User Mapping (Optional)

User mapping allows looking up Odoo users by GitHub username or email. This is used for `author_id` (which requires internal API user) and for generating @mentions in messages.

**Example mapping** (GitHub username/email → Odoo login):
```json
{
  "github-username": "user@company.com",
  "dev@github.com": "dev@company.com"
}
```

Set via: `wrangler secret put ODOO_USER_MAPPING`

## Development

```bash
# Run locally
npm run dev

# Run tests
npm test

# Lint
npm run lint

# Format
npm run format
```

### Local testing with GitHub webhooks

Use `gh webhook forward` to tunnel webhooks to your local dev server:

```bash
gh webhook forward --repo=owner/repo --events=push,pull_request --url=http://localhost:8787/webhook
```
