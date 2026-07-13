# Local Git Sync Preflight

This runbook prepares the local-first MVP for real two-machine testing. It assumes Dave's Windows machine is the always-on seed and that each relationship has its own Git repo.

Use this before involving Lisa or Mike at their own Macs.

## Current Baseline

On Dave's Windows machine, from `C:\Users\Dave\dm_sum`:

```powershell
npm run dev:cli -- sync doctor --data-root C:\Users\Dave\DMSum
npm run dev:cli -- sync status --data-root C:\Users\Dave\DMSum
```

Expected result:

- `sync doctor` shows `OK` checks for `dave-lisa` and `dave-mike`.
- `sync status` says both relationships are `clean`.

If status is `pending`, run:

```powershell
npm run dev:cli -- sync once --data-root C:\Users\Dave\DMSum
```

If status is `conflict`, stop and have an agent resolve the markdown conflict before continuing.

## Dave Windows Seed

Dave's machine needs Git, Tailscale, and Windows OpenSSH Server.

Check Git and Tailscale:

```powershell
git --version
tailscale status
tailscale ip -4
```

Check Windows OpenSSH Server:

```powershell
Get-Service sshd -ErrorAction SilentlyContinue
Get-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue
```

If `sshd` is missing or stopped, install/start it from an elevated PowerShell:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
```

Make sure Git is available in SSH sessions. From Dave's machine, this local check should return a Git version:

```powershell
ssh $env:USERNAME@localhost "git --version"
```

If this fails, fix OpenSSH or Git PATH before involving another machine.

## Relationship Repos On Dave

The relationship repos should already exist:

```powershell
Get-ChildItem C:\Users\Dave\DMSum\git
```

Expected:

```text
dave-lisa.git
dave-mike.git
dm_sum-source.git
```

Each remote participant gets only their own relationship repo.

## Remote URL Smoke Test

Before Lisa or Mike initializes their local Mem·Sum directory, confirm the SSH remote URL works from the Mac.

Candidate URL shape:

```text
ssh://Dave@<dave-tailscale-host>/C:/Users/Dave/DMSum/git/dave-lisa.git
```

Some Windows OpenSSH/Git combinations prefer scp-style syntax:

```text
Dave@<dave-tailscale-host>:C:/Users/Dave/DMSum/git/dave-lisa.git
```

Use whichever form passes:

```bash
git ls-remote "<remote-url>"
```

Do this for `dave-lisa.git` on Lisa's Mac and `dave-mike.git` on Mike's Mac.

If the public GitHub repo is not available or the participant does not have GitHub auth configured, clone the Mem·Sum source over the same Tailscale path:

```text
ssh://dmsum_lisa@<dave-tailscale-host>/C:/Users/Dave/DMSum/git/dm_sum-source.git
```

Use the participant's restricted Windows account when testing this source remote.

## Lisa Mac Setup

On Lisa's Mac, install Git, Tailscale, Node.js 24+, and clone/build this Mem·Sum repo. Use GitHub if auth is already set up, or use Dave's Tailscale source repo:

```bash
git clone "<dm-sum-source-remote-url>" ~/dm_sum
cd ~/dm_sum
npm install
npm run build
```

Then initialize only the Dave-Lisa relationship workspace:

```bash
npm run dev:cli -- init-local --data-root ~/DMSum --owner Lisa --contacts Dave --relationship-ids dave-lisa --remotes "<dave-lisa-remote-url>"
npm run dev:cli -- sync doctor --data-root ~/DMSum
npm run dev:cli -- sync once --data-root ~/DMSum
```

Lisa's registry should have `@dave` pointing to `dave-lisa`. It should not contain the Dave-Mike workspace.

For Perplexity Personal Computer builds that accept URL-based MCP connectors but not local stdio commands, run the local HTTP transport:

```bash
node ~/dm_sum/dist/server.js --transport http --host 127.0.0.1 --port 3333 --registry ~/DMSum/.dmsum/registry.json --sync ~/DMSum/.dmsum/sync.json
```

Register this MCP URL in Perplexity:

```text
http://127.0.0.1:3333/mcp
```

If Perplexity asks for a transport type, choose Streamable HTTP.

The health check is `http://127.0.0.1:3333/health`. Keep this process visible for the first test; move it to launchd only after the connector works.

## Mike Mac Setup

On Mike's Mac, install Git, Tailscale, Node.js 24+, and clone/build this Mem·Sum repo. GitHub is fine if his agent workflow already has auth; otherwise Dave can expose a read-only source remote over Tailscale.

```bash
git clone https://github.com/docgotham/dm_sum.git ~/dm_sum
cd ~/dm_sum
npm install
npm run build
```

Then initialize only the Dave-Mike relationship workspace:

```bash
npm run dev:cli -- init-local --data-root ~/DMSum --owner Mike --contacts Dave --relationship-ids dave-mike --remotes "<dave-mike-remote-url>"
npm run dev:cli -- sync doctor --data-root ~/DMSum
npm run dev:cli -- sync once --data-root ~/DMSum
```

Mike's registry should have `@dave` pointing to `dave-mike`. It should not contain the Dave-Lisa workspace.

## Background Sync

After the one-shot sync test passes, start the daemon on each machine.

Dave:

```powershell
cd C:\Users\Dave\dm_sum
npm run dev:cli -- sync daemon --data-root C:\Users\Dave\DMSum --interval 60
```

Mac:

```bash
cd ~/dm_sum
npm run dev:cli -- sync daemon --data-root ~/DMSum --interval 60
```

For early tests, keep the daemon visible in a terminal. Move to background launch only after the manual flow is boring.

If the participant's agent can use MCP sync tools, the daemon is optional during early testing: the agent can call `sync_once` when a change should be shared.

## First Real Test

Start with one relationship.

1. Dave adds a small item to the relationship through his agent.
2. Dave runs `sync once`.
3. Lisa or Mike runs `sync once`.
4. The remote agent asks a simple retrieval question.
5. The remote participant adds a small reply.
6. The remote side runs `sync once`.
7. Dave runs `sync once`.
8. Dave's agent retrieves the reply.

Only after that passes should we test simultaneous edits and conflict resolution.
