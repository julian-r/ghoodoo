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
| `ODOO_API_KEY` | Odoo API key for authentication |
| `ODOO_STAGE_DONE` | Stage for merged PRs with close keywords (ID or name, e.g., `Done` or `4`) |
| `ODOO_STAGE_IN_PROGRESS` | Optional: Stage when PR opened (e.g., `In Progress`) |
| `ODOO_STAGE_CANCELED` | Optional: Stage when PR closed without merge (e.g., `Canceled`) |
| `ODOO_USER_MAPPING` | Optional: JSON mapping GitHub email → Odoo email (see below) |
| `ODOO_DEFAULT_USER_ID` | Optional: Fallback Odoo user ID when no mapping found |

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
- The message author is set to the mapped Odoo user (see User Mapping below)
- If no Odoo user is found, messages are posted as the API user

### Stage Transitions

Tasks are moved to different stages based on PR actions (if configured):

| PR Action | Stage Used | Condition |
|-----------|------------|-----------|
| Opened/Reopened | `ODOO_STAGE_IN_PROGRESS` | If configured |
| Merged | `ODOO_STAGE_DONE` | If `Closes`/`Fixes`/`Resolves` keyword used |
| Closed (not merged) | `ODOO_STAGE_CANCELED` | If configured |

> **Note:** Stage transitions only work for tasks that belong to a project. Personal/private tasks cannot have project stages assigned.

### User Mapping

Comments can be posted as specific Odoo users based on the GitHub commit author's email.

**How it works:**
1. If `ODOO_USER_MAPPING` has an entry, use the mapped Odoo email
2. Search for Odoo user by email OR login (since Odoo login is typically an email)
3. Fall back to `ODOO_DEFAULT_USER_ID` if no user found
4. Otherwise post as the API user

**Example mapping** (GitHub email → Odoo email):
```json
{
  "dev@github.com": "dev@company.com",
  "contractor@personal.com": "contractor@company.com"
}
```

If the GitHub email already matches the Odoo user's email/login, no mapping is needed.

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
