# GitHub Sources

Copies selected GitHub repos into read-only Mounts for the chat agent. It checks once a day. Unchanged repos cost only a head check. Changed repos get a full new copy.

The plugin has no pages and adds nothing to the Files sidebar. With the default settings, the agent sees a repo at `/.mounts/github/<volumeKey>/`.

## Setup

Install the plugin, accept its Mount, schedule and plugin KV permissions, and choose a run user. That user must grant `volumes:write`, `secrets:read`, `outbound:fetch`, `plugin_data:read` and `plugin_data:write`. Their current plugin management permission must still allow the run. KV reads and writes also need their current workspace content read and write permissions. The KV record holds the next repo to try and up to 32 empty commit revisions. It holds no token or copied file text.

Set `GITHUB_TOKEN` for private repos. A token is also recommended for public repos. Use a fine-grained token with **Contents: read** for only the chosen repos. Do not use a token with write access. GitHub's archive API needs this read permission. [GitHub archive API](https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-zip)

Any plugin manager can add a repo that this token can read. Workspace readers can then read its copied files. Limit the token to repos that may be shared with this workspace.

Edit the settings YAML:

```yaml
mount:
  name: github
schedule:
  everyMinutes: 1440
repositories:
  - owner: example
    repo: docs
    ref: main
    volumeKey: docs
```

Use at most 32 repos. `volumeKey` is optional and defaults to the lowercased repo name. Keys must be unique. They start with a lowercase letter or number, use letters, numbers, `.`, `_` or `-`, and have at most 63 characters. `tmp` is reserved.

The platform allows an interval from 15 minutes to 7 days. The default is one day. Use Run now in the plugin settings to start sooner.

## Copy rules

The plugin pins one commit for a whole copy. A branch moving during the copy does not mix old and new files. The head check uses GitHub's SHA response format. [GitHub commit API](https://docs.github.com/en/rest/commits/commits#get-a-commit)

Private ZIP downloads use the GitHub API token for the first request. Only a redirect to `https://codeload.github.com` is accepted. The token is never sent to codeload. Redirects are followed by hand because a Worker can otherwise forward headers to another host. [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)

The ZIP is read with fflate streaming. It must finish with a valid directory and matching sizes and checksums before publication. [fflate](https://github.com/101arrowz/fflate)

- Keep text files up to 900,000 UTF-8 bytes. Empty files are allowed.
- Skip binary extensions, invalid UTF-8, NUL text, Git LFS pointers and lockfiles.
- Skip `node_modules`, `dist`, `build`, `out`, `.next`, `.turbo`, `vendor`, `.git` and `coverage` folders.
- Skip paths with traversal, hidden control characters, backslashes or invalid segments.
- Require one top-level ZIP folder. Duplicate ZIP paths are refused.
- Refuse a copy over 5,000 kept files or 30 MB of kept text.
- Refuse ZIPs over 12 MiB compressed, 64 MiB decoded, 20,000 entries or a 2 MiB directory. Keep decoded buffers below 4 MiB.

Writes use absolute paths and batches of up to 100 files or 7.5 MB of encoded JSON. Each run uses at most 20 calls and 25 subrequests, including secret reads. More work uses an explicit follow-up run.

Schedule input stays below 64 KB. Host JSON replies stay below 512 KiB so long valid file paths fit in write receipts.

## Stops and retries

A partial copy is never published. The previous copy stays readable until a complete replacement is published.

If a fully checked ZIP has no kept files, the plugin deletes the old volume and saves its empty commit revision. The old files become hidden. It skips that revision on later runs. A broken ZIP or refused delete keeps the old files.

Daily limits, storage errors, credit refusal or call limits pause the chain. Use Run now, or wait for the next daily run. It gets the existing staging ID from the live list and resumes that copy. Replacing an already saved path in the same copy costs no new stored-file charge. The platform keeps open staging copies for 26 hours after their last write.

A repo over its copy or installation cap is skipped so later repos can finish. Its partial copy stays unpublished and later expires. Invalid path, content and path conflict errors skip only that item; the run reports the count.

Published revisions keep progress across root runs. If 32 changed repos need more than one chain, the next root skips the copies already done. The KV cursor moves the starting repo by one before each root begins work. Every repo gets first place once within 32 roots, even when heads change daily or an early copy always fails. Many large, changing repos may need several daily runs. Run now also advances the turn. A lost KV reply stops that run; the next root reads the saved cursor. Changing settings resets the cursor and empty revisions. Removed repo keys are deleted in groups of at most five per run.

The organization owner pays for new stored files. The selected run user controls permissions. Scheduled runs stop if their grant or current access is removed.

## Local development

Use Node through Vite Plus and pnpm:

```powershell
vp env exec pnpm install
vp env exec pnpm run check
vp env exec pnpm run test
vp env exec pnpm run build
```

`src/worker.ts` owns the schedule and host calls. `src/archive.ts` owns ZIP validation and filters. The build bundles both with fflate and Zod into one Worker. The root `bonobo.plugin.json` owns the version and file hash. The build copies it byte for byte to `dist/bonobo.plugin.json`.

The SDK 0.21.0 dependency is pinned to reviewed mirror commit `973457877210fec8908f26fe17c8d727572aa54d`. `checks/`, `logs/`, `.runtime/`, `HANDOFF.md` and `SOURCE-PIN.json` are local review files and should not enter the plugin repository.
