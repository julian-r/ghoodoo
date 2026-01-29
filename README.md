# Ghoodoo

A Cloudflare Worker that bridges GitHub and Odoo - reference Odoo tasks in your commits and PRs, and Ghoodoo updates them automatically.

## How it works

Reference Odoo tasks in your commit messages or PR descriptions using `ODP-123` syntax:

```
git commit -m "Fix validation logic, refs ODP-456"
```

```
git commit -m "Closes ODP-789"
```

Ghoodoo receives the GitHub webhook and updates the corresponding Odoo task with comments, status changes, and links back to the PR/commit.

## Supported keywords

- `Closes ODP-123` / `Fixes ODP-123` - Resolve the task
- `Refs ODP-123` - Add a comment linking to the commit/PR

## GitHub Autolinks

For clickable `ODP-123` links in GitHub, configure Autolink References in your repo:

1. Go to **Settings → Autolink references**
2. Add a new autolink:
   - Prefix: `ODP-`
   - URL: `https://your-odoo.com/web#id=<num>&model=project.task&view_type=form`

## Setup

Coming soon.

## License

MIT
