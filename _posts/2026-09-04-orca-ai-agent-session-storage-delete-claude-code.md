---
layout: post
title: "16 AI Agents, 16 Ways to Store a Session — What I Learned Deleting Them"
date: 2026-09-04 09:00:00 +0900
categories: [블로그]
tags: [open-source, ai-agents, claude-code, electron, ipc, typescript, code-review]
---

# I put code into the tool I use every day

Not many people run just one AI coding agent anymore. I mostly use Claude Code, with Codex, Gemini, and Copilot mixed in depending on the task. That habit is how I ended up on an editor built around running several agents at once: [Orca](https://github.com/stablyai/orca).

Using it, something kept bothering me. But it was the kind of problem you can only fix by touching someone else's codebase. Until then, "contributing to open source" meant fixing typos or improving docs to me. This meant building a whole feature and getting it in.

I opened an issue first. A few weeks later it was merged. **[PR #10249](https://github.com/stablyai/orca/pull/10249) — the first code of mine to land in someone else's project.**

![Orca's default layout — agent sessions and worktrees managed in one window](https://media.vlpt.us/images/5hseok/post/f93444a2-4a92-41cf-aba4-356597fd3aaa/orca-layout-default.png)

This is a record of what I did in that repo afterwards, and more importantly, **what I learned handling the data agents leave behind on your machine**.

---

# What I worked on

Five PRs and six issues so far.

![Table: PRs and issues so far](https://media.vlpt.us/images/5hseok/post/ad5d842b-072c-4f88-89cb-89e4cd0beb4e/table1_9ctut3j5.png)


Lining them up, they had something in common. **Most only happen once you run more than one agent.**

- Agent session history piles up with no way to retire any of it (#10249)
- A worktree an agent created temporarily disappears from the list with no way to get it back (#11275)
- Code written by an agent and code written by me are formatted differently, so diffs get noisy (#13757)

None of these come up when you have a single editor open and no agents. They appeared when agents started creating, editing, and deleting files on my behalf — which also means the tooling hasn't caught up yet.

The rest of this post is about the first one, which took the longest.

---

# Agent session history never goes away

Orca has a panel called **AI Vault**. It sweeps every local agent session on your machine — Claude, Gemini, Copilot, Cursor, Codex, **16 providers** in total — into one list. You can jump to an old conversation, resume it, or open its log file.

![The Agent Session History panel with its Workspace / Project / All tabs](https://media.vlpt.us/images/5hseok/post/7d27d520-8519-47d3-b046-7cddddcdeab9/ai-vault-session-list.png)

*The AI Vault panel. The `⋯` on the right of a row is the session menu. (Screenshot from [PR #11419](https://github.com/stablyai/orca/pull/11419))*

The problem was that **once a session exists, it never leaves the list**. A session from a worktree merged weeks ago, one from a feature that already shipped, one attached to a branch that no longer exists. They sat right next to the two or three I actually work in today. Scrolling past them was the normal state of using the panel.

This wasn't about disk space. It was that **there was no way to say "this one is done, stop showing it to me."** The row menu offered Jump, Resume, Continue in New Session, Copy, Open/Reveal Log — nothing that retires a session. The filters (scope, agent, hide-empty, search) narrow the view by category; they can't express "this specific session belongs to work that is finished." The only workaround was to quit the app and delete the files from a terminal.

I wrote exactly that up as an issue ([#9876](https://github.com/stablyai/orca/issues/9876)). Opening an issue before writing code was deliberate: if a maintainer is already on it, the work collides, and if the direction is unwanted, I'd have built the whole thing only to throw it away.

A few days later:

> good idea. would be useful to clean up that session history

Instead of jumping straight into the implementation, I posted how I planned to build it first — which providers I'd support, how the unsupported ones would be shown, how a renderer-supplied path would be validated. Then I asked:

> Would you be open to assigning this to me and reviewing a PR? Happy to defer if you're already on it — just didn't want the work to collide.

The issue was assigned to me. From that point it stopped being "code nobody asked for" and became work I'd been handed.

> 💡 Later, another user commented on the same issue that their Pi agent sessions were piling up. Pi is one of the single-file providers, so it was already in the first supported group and I could say so directly. File the issue early and the people with the same problem come to you.

---

# 16 agents store a session 16 different ways

Read the feature description and it sounds like adding a Delete item to a menu and calling `fs.unlink`. That's what I thought too, at first.

I got stuck on the very first question. **Does deleting one agent session mean deleting one file?**

What the scanner surfaces for each session is **a single path**. Whether that path is the whole session depends on the agent. So I set one rule:

> **Only delete what can be deleted completely.** An app that says "deleted" while the conversation is still on disk — or while the row comes back on the next scan — is worse than one with no delete at all.

Applying that rule meant checking how all 16 agents physically store a session. They fell into three groups.

![How each agent stores a session](https://media.vlpt.us/images/5hseok/post/76fc4afb-e524-4528-b976-d9a33ae28f4e/agent-session-shapes.png)

The third group was the problem. **Four agents couldn't be deleted at all.**

![Agents that cannot be deleted](https://media.vlpt.us/images/5hseok/post/da02b053-70da-4b76-8edd-9e7c366e0b57/agent-undeletable.png)

Doing that survey taught me something. **"Session" means a different physical thing to every agent.** For some it's a file, for some a directory, for some a database row, for some a file plus a separate index. On screen they're all just "conversation history" — but deleting one safely means knowing each storage layout.

That led to a UI decision. For the four unsupported agents, the Delete item is **disabled rather than hidden**. When a menu item is simply absent, users read it as a bug. "You can't delete it here" has to be on screen.

The tooltip, though, doesn't say **why**. Hardlink aliases and SQLite rows are Orca's problem, not something the reader should have to absorb. I left that reasoning in a code comment instead:

```ts
/**
 * Why Delete is unavailable for this session, as the tooltip text to show — or
 * null when it is offered. Each message says which sessions are affected, never
 * why: a provider's storage layout is Orca's problem, not the reader's.
 */
```

---

# An agent leaves behind more than the conversation

Digging into Claude sessions turned up something else. A single session doesn't leave one conversation file on disk.

![What a Claude session leaves on disk](https://media.vlpt.us/images/5hseok/post/7e3fbfac-af07-4d05-b272-f1c2cda5d0fe/claude-session-layout.png)

The row already showed **how many subagents a session had**.

![A session row showing a 4 subagents badge](https://media.vlpt.us/images/5hseok/post/fd16ea69-cf46-4b49-b225-d90fad46fb03/ai-vault-row-subagents.png)

Expand the row and each of those subagents appears as its own conversation.

![The SUBAGENTS list revealed by expanding a session](https://media.vlpt.us/images/5hseok/post/8ecd3d41-2209-4ff4-b12d-f08345dd8eee/ai-vault-subagents-expanded.png)

*(Both screenshots from [PR #7423](https://github.com/stablyai/orca/pull/7423) — another contributor's PR that added subagent display to AI Vault)*

**Subagent transcripts accumulate in a sibling directory.** Run a Task in Claude Code and that subagent's conversation is stored separately from its parent, inside a directory named after the parent transcript. Delete the conversation file alone and the row disappears from the list while a large share of the actual conversation stays on disk. The more subagents a session ran, the more is left behind.

**`file-history` was the one thing not to delete.** The name makes it sound like session debris, but what's inside is **my own source code as it was before the agent edited it**. It's the rewind buffer. Delete it along with the session and the user hits "I deleted a conversation and my file rewind is gone."

That judgement went into the code as a comment:

```ts
// `session-env/<uuid>/` is a companion — it holds that session's generated
// shell exports and nothing else. Its sibling `file-history/<uuid>/` is
// deliberately NOT: that is the rewind buffer holding earlier versions of the
// user's own files, and retiring a session is no reason to destroy the only
// copy that can restore them.
```

> 💡 When you write code that deletes data an agent produced, the dangerous moment is passing over "what is this directory?" without checking. Agents don't only leave conversations — they leave copies of your files, environment variables, caches, indexes. Don't guess from the name; open it.

For the same reason, deletion goes through **`shell.trashItem`**, not `fs.rm`. It moves to the trash. Deleting data another app created has to be reversible. And a file that's already gone (`ENOENT`) is treated as success — if the user deleted it outside the app, the outcome should be the same.

---

# Never trust a path from the renderer

This is the part I spent the longest on.

An Electron app splits the **renderer process** that draws the screen from the **main process** that touches the filesystem, and the two talk over IPC. A delete request starts in the renderer.

![Electron process boundary](https://media.vlpt.us/images/5hseok/post/f6c1a200-9d1d-458b-9df3-b8acd672a048/electron-process-boundary.png)

Build it naively and this is what you get: the renderer sends `{ agent, filePath }`, and main deletes that `filePath`. **That IPC channel is now arbitrary file deletion wearing the name of a session delete.** If the renderer is compromised, if the scanner surfaces a strange path, if a symlink is in the way — it runs.

So the main process treats what the renderer sends as **a hint about the input, and decides from scratch whether it has the right to delete it**.

![Delete path validation pipeline](https://media.vlpt.us/images/5hseok/post/7fd48f7e-00b8-4c23-bf68-f59ede309046/delete-validation-pipeline.png)

A few of these I learned by getting burned.

**Why `resolve()` comes first.** Whether a path sits inside an allowed root is a string comparison. But `<root>/../../etc/x.jsonl` starts with `<root>` as far as a string is concerned. The comparison has to happen after `resolve()` collapses the `..`.

**Why `realpath` matters too.** Even when the path string is inside a root, an intermediate directory can be a symlink pointing the real file somewhere else. So right before removing anything, it checks on disk once more — `lstat` for whether it's a file or a directory, `realpath` for whether the real location is still inside the roots.

**Agents let you move their storage with an environment variable.** Several agents allow overriding where sessions are stored, and that opened a hole. `OMP_CODING_AGENT_DIR='/'` normalizes to an empty string, and resolving an empty string gives you **the process's current working directory**. One empty root silently allowlists the entire cwd.

```ts
const roots = source
  .rootDirs(args.rootOptions ?? {}, args.wslHomeDirs ?? [])
  // Why: OMP_CODING_AGENT_DIR='/' normalizes to '', which resolve()s to the
  // process cwd — an empty root would silently allowlist it.
  .filter((rootDir) => rootDir.trim().length > 0)
  .map((rootDir) => resolve(rootDir))
```

**The blast radius of a directory delete.** Since some agents are deleted directory-wise, a file sitting directly in the sessions root becoming a directory-delete target would **wipe every session that agent has**. A filename whose extension-stripped stem is empty can likewise resolve to the project root. Both are rejected explicitly, each with its own test.

The validation logic is a **pure function** that never touches the filesystem. It only judges paths, never throws, and returns malformed input as a rejection like any other. That's what lets the tests throw every hostile path at it without a real home directory.

---

# What about agents running on a remote host

Orca can run agents on a remote host over SSH. Then that session's history lives **on the remote machine's disk, not mine**. Electron's `shell.trashItem` only acts on this computer, so remote sessions can't be deleted.

WSL had a related problem. Deleting a WSL agent session from Windows means a UNC path, and a UNC path has no recycle bin. That had to be routed through the existing WSL-specific delete path.

And here's a design decision I enjoyed. **The renderer and main agree on *whether* something is deletable, but deliberately check in a different order.**

```ts
/**
 * NOT the security boundary — main re-validates the path on disk regardless.
 * The two sides agree on deletable-or-not but deliberately not on the order they
 * check, so an SSH session reads as "remote" rather than "unsupported agent".
 */
```

Main's job is security, so it asks "is this a supported agent?" first. The renderer's job is telling the user why, so it asks "is this session on this machine?" first. That way a Codex session running over SSH reads as *"Only sessions on this device can be deleted"* rather than *"Codex sessions can't be deleted from Orca."* Both are true, but only one tells the user what to do next.

---

# The order of removal has a reason too

When a session is made of several files, **which one you delete first** changes what happens on failure.

![Order of removal](https://media.vlpt.us/images/5hseok/post/863d5c9d-7710-4e2e-894d-455031c0594c/delete-sequence.png)

The rule: **companions first, the conversation that puts the row on screen last.**

What creates the row is the conversation file. Delete it first and then fail on the subagents directory, and **the row is gone while the data stays on disk**. The user has no way to know it's there and no way to retry.

Delete the companions first and a mid-way failure leaves the row. It looks like "the delete didn't work," but the user can press it again and the rest gets cleaned up. **If it's going to fail, it should fail in a state the user can retry from.**

Caching had the same shape of problem. AI Vault caches scan results, and a scan that started just before the delete but finishes after it **writes the deleted row back**. So the cache carries a generation counter, and results older than the invalidation are dropped.

---

# Review: bots first, then a human

In this repo, two review bots (CodeRabbit, Greptile) get to a PR first, and a human maintainer follows.

Bot reviews come with a lot of findings. At first I assumed I had to fix all of them; in practice, **the work is separating the real ones from the rest and showing your reasoning**. Two I did fix:

1. **An unhandled IPC rejection.** The main handler doesn't throw on failure — it resolves a `failed`/`rejected` result. But a rejection at the transport or serialization layer can still escape, and the caller was firing it with `void`. That meant no failure toast and an unhandled rejection.
2. **Dismissing the dialog mid-delete.** While a delete was in flight, Escape, an outside click, or the X button could still close the confirm dialog.

For both, I **confirmed a failing test before fixing** and left it as a regression test. When replying to the bot, I wrote what situation the bug shows up in and which commit fixed it, rather than "fixed."

Looking back, a lot of my time went into making the PR easy to review. The description carried a table of supported and unsupported agents, the reasoning behind design decisions, a security review, and — separately — **what I had not verified myself**:

> - **macOS:** exercised end to end by hand against an isolated disposable HOME
> - **Linux:** the new e2e spec runs on CI and proves the real on-disk removal
> - **Windows / WSL:** unit tests and code review only, not a live runtime — reviewers may want to give this path a closer look

That last line was the one I hesitated over. There's a pull toward writing "verified everywhere." And a WSL bug did turn up in review. **Saying plainly what I hadn't tested is exactly what drew review to that path.**

The maintainer left three rounds of comments and then approved. I opened the issue on July 22; it merged on August 7.

---

# What's left

Technically it all converges on one thing. **A value that crossed a boundary gets judged again.** The path from the renderer, the root the scanner surfaced, the storage location overridden by an environment variable — I don't know what any of them passed through on the way here. In code that deletes someone's data, that attitude is worth a lot.

There's an agent-shaped lesson too. **Agents leave more on your machine than you'd think.** Not just conversations, but subagent conversations, earlier versions of your files, generated environment variables, separate indexes. And the layout differs for every agent. Almost nothing exists to clean that up today, which feels like a gap that will matter more as running several agents becomes normal.

The rest of my PRs came from the same place. Recovering a temporary worktree an agent created ([#11275](https://github.com/stablyai/orca/pull/11275)), formatting drifting between an agent's edits and mine ([#13757](https://github.com/stablyai/orca/pull/13757)), running out of tabs and sidebar room with several agents open ([#10076](https://github.com/stablyai/orca/pull/10076), [#10152](https://github.com/stablyai/orca/pull/10152)). None of these existed when it was just me and one editor.

One of them, #11275, was closed. While I was building it, a maintainer solved the same problem in a different PR.

> Thanks for this work — per-worktree recovery from the visibility dialog landed in #13652, so this PR is now superseded.

1,827 lines summed up in one sentence. It stung, but the cause was clear. **#10249, which I built after filing an issue and getting it assigned, got merged; the one I built off an issue without coordinating got superseded.** Hold a large change alone for long enough in an active repo and things move underneath you.

So the lesson wasn't really about coding. File the issue first, say how you plan to build it, get it assigned, write down what you couldn't verify. That's closer to **making it possible for a reviewer to judge** — and in someone else's repo, that mattered as much as the code.

---

*P.S. These days I have git line blame wired into the editor. After building it I went looking through the issues and PRs and found it already well covered, so I'm just quietly using my own. Next time I'll search before I build.*
