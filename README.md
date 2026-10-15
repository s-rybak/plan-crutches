# Plan Crutches

Plan Crutches is a mod for Claude Code. It shows Claude's plan in a review page in your browser before Claude writes any code. You see the task, a short summary, the change tree, the signatures of new and changed methods and a diff against the current files. You comment on folders, files, symbols or any text you select with the mouse. A 3D diagram shows the files and the calls the plan changes. Then you press Submit. With comments, Claude revises the plan and the page shows the next version. Without comments, Claude proceeds to implementation.

## How it works

1. You start plan mode and give Claude a task.
2. Claude writes the plan file as usual and ends it with a `plan-crutches` JSON block. The mod adds this instruction to the plan mode reminder.
3. When Claude calls `ExitPlanMode`, the mod reads the plan file, starts the review page server, opens the page and tells Claude to wait.
4. You review in the page. Every comment is saved in the session state and in a Markdown record under `docs/plans/`. The mod also keeps the review in its own store, per project folder. If Claude Code restarts and you resume the session, the review comes back on its own. If you start a new session in the same folder, `/plan-review restore` brings it back.
5. Submit sends your comments to Claude as the next message. Claude updates the plan file and calls `ExitPlanMode` again. The page shows version 2 and marks your comments as resolved.
6. Submit with no pending comments approves the plan. Claude Code then shows its own plan dialog once. Press Yes there to start the implementation.

A plan can also come from a file. `/plan-review open <path>` reads a Markdown plan file and starts the same review. The page, the pane, the record under `docs/plans/` and the store all work as for a plan from plan mode. The path is absolute or relative to the project folder, and `~` stands for your home folder. Use it for a plan from an earlier session under `~/.claude/plans/`, or for a plan you wrote by hand. If the file is already under review, the command opens it as the next version, and your comments stay. If another plan is under review, the command resets that review first. If you give no path, the mod finds the plan itself. It takes the plan file of this session: the file plan mode names, or the file the review already holds. If there is none, it takes the newest `.md` file under `~/.claude/plans/`. The reply names the file it chose and why.

## The review page

The page is plain HTML, CSS and JavaScript under `web/`, served by a small Node server under `server/` on `127.0.0.1`. The mod starts the server with `$.process.spawn`. After every change, the mod pushes the review state to the server. The mod reads every action of the page from the server's standard output. The page gets the state over Server-Sent Events, so it follows the session live.

- Header: plan title, version, status, comment count, connection dot, theme toggle, language toggle (EN and UA) and the Submit button. The header and the tabs float: they stay at the top while you scroll.
- Task: the raw task text, from the Jira issue Claude fetched or from your prompt.
- Summary: the plan summary as Markdown with images, cut at 9000 characters with a Show all button.
- Changes by folder: every folder and file the plan touches, marked `new`, `mod` or `del`, with the number of comments on each. Click a folder to fold it, click the speech bubble to comment on it, click a file to open it.
- File view: the description of the change and each symbol with its highlighted signature. Below them, a diff of the signatures against the current file and the full file on demand. An Expand implementation button asks the model for a body. In the diff and in the preview of a new file, every planned signature carries a Show implementation button. The generated code takes the place of the stub right there, and you can comment on its lines.
- Select any text with the mouse, in a code block, the summary, the task or an answer: a popup opens next to the selection with two tabs. Comment: type the comment and press Enter. A code comment keeps the line range and the selected text, and the lines stay marked. Ask: type a question about the selected text and press Enter. Claude answers in the same window, with the selection and its place as context, and you continue the conversation there. The thread is kept in the Ask tab, and "Add the conversation to a comment" turns it into a comment on the same lines.
- Diagram: a 3D board with one block per planned file, colored by its status: new, modified or deleted. Each block lists the symbols the plan changes. Lines between symbols are the calls and uses the plan creates. Calls inside one file are drawn inside its block. Press Generate change diagram to build it: a clean session with read-only tools gets the plan and reads the project. Click a symbol to see every place in the project that calls it, in existing code too. The callers arrive as new rows and blocks, up to 20. More callers than that become one block marked others. Click the symbol again to hide them. The plan's own blocks are always drawn whole. Drag rotates the board, Shift and drag pans it, the wheel zooms, and 2D flattens it. Save as SVG writes the flat diagram next to the Markdown record.
- Ask: a question box that answers from the plan and the session without changing either. Every question is a thread: Reply continues the conversation under it, with the earlier turns as context. A thread shows where it came from and the selected text, and can become a comment. Answered threads go into the Markdown record.
- Comments: every comment by state (pending, sent, resolved) and the review history.

The pane in Claude Code stays as a second view with the page link, so a terminal session still has a review surface.

## Colors and styles

The page reads its colors from CSS variables in `web/theme.css`, with light and dark values. Change them there, or put overrides in `web/custom.css`. That file is yours and is not part of the mod. If the file exists, the server serves it. If the file is missing, the page ignores it. The theme toggle in the header switches between auto, light and dark.

## Commands

| Command | What it does |
| --- | --- |
| `/plan-review` | If the page server is not running, starts it. Opens the page and the pane. |
| `/plan-review demo` | Loads a demo plan so you can try the page without plan mode. |
| `/plan-review open [path]` | Opens a plan file for review without plan mode. With no path, it opens the plan file of this session, or else the newest file under `~/.claude/plans/`. The same file under review gets the next version and keeps the comments. The command resets any other live review first. |
| `/plan-review url` | Prints the page address with its token. |
| `/plan-review restore` | Brings back the stored review of this folder: the plan, the comments, the questions and the diagram. |
| `/plan-review close` | Closes the pane. The page keeps running. |
| `/plan-review stop` | Stops the page server. |
| `/plan-review reset` | Clears the review state. |

## Options

Set them in `/config` or in `settings.json` under `pluginConfigs.plan-crutches.options`.

| Option | Default | Meaning |
| --- | --- | --- |
| `language` | `en` | Page and pane language, `en` or `uk`. |
| `model` | `sonnet` | Model for the light calls: plan structure extraction, the pick of project files for an implementation, the change diagram and its callers, and answers without a session fork. |
| `bodyModel` | `opus` | Model that writes method bodies. Empty means the `model` option. |
| `plansDir` | `docs/plans` | Folder, relative to the project, for the Markdown records and SVG files. |
| `summaryLimit` | `9000` | Characters of the summary shown before Show all. |
| `port` | `4817` | Port of the page server on 127.0.0.1. A taken port falls back to a free one. |
| `openIn` | `auto` | Where the page opens: `auto` tries the Claude desktop browser pane, then the system browser. `system` uses the system browser. `none` only shows the link. |
| `nodePath` | empty | Path of the node executable. Empty means node from PATH, then the usual install locations. Node 18 or newer. |

## How an implementation is generated

Expand implementation and Show implementation ask `bodyModel` for one symbol's body. The prompt carries, in this order:

1. The whole plan: the summary and every planned file with every symbol's full signature and description. This block is the same for every symbol of a plan version and is marked for the prompt cache.
2. The implementations already generated for the other symbols, the current file's own first, so names, signatures and behavior stay consistent across the plan.
3. Real project files. These are the other planned files as they are on disk and the files the current file imports. The `model` option also picks up to 8 files from the project's file list (`git ls-files`): the types, helpers and callers the symbol needs.
4. The current content of the file and the symbol to implement.

## How the diagram is generated

Generate change diagram starts a subagent of the mod's own type. The subagent runs in a clean session: no history, no CLAUDE.md, and only the read-only tools Read, Grep and Glob. Its prompt holds the whole plan and the current text of the planned files. It answers with a JSON graph: every planned file with its symbols, and the calls between them. The page draws the graph and never drops a planned block.

A click on a symbol starts a second request. The mod first runs `git grep` for the symbol name and names the function that holds each hit. The clean session gets those candidates, drops false positives, adds the callers the search missed, and answers up to 20 callers. The rest becomes one block marked others. If no subagent can start, a model call without tools answers from the plan and the file texts. If that call fails too, the page shows the text search result alone and says so.

## Security of the page

The server binds to `127.0.0.1` only. It answers only requests whose `Host` header names the local machine. A web site that points its name at `127.0.0.1` gets a 403. Every API call carries a token that the mod makes once per session. The page gets the token from the link, keeps it in local storage and then removes it from the address bar. Project files are served under `/project/` with the same token, for images in the summary and for the Full file view. The server never serves a file outside the project folder. The state the mod pushes holds the plan and the signature diffs, not the text of the project files.

## Run it from this folder

The mod loads from a folder that Claude Code watches. In a terminal session:

```bash
claude --plugin-dir /path/to/plan-crutches
```

In the desktop app, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, then start a new session.

## Try the page alone

The page can run without the mod, with the demo plan and canned answers:

```bash
node scripts/demo-server.mjs
```

Then open `http://127.0.0.1:4818/?t=demo`.

## Check it

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
node --test tests/server.node.mjs tests/page.node.mjs
```

The first two need Claude Code 2.1.275 or newer. The last one checks the page server end to end and the page modules that render Markdown, code, diffs, the tree and the diagram layout.

## Limits

- The built-in plan dialog remains after approval: one Yes click.
- Claude must write the `plan-crutches` block for the structured view. Without it, the mod asks the model to extract the structure, and falls back to the Markdown alone.
- The page server runs only where the session runs, so a session in the cloud has the pane alone.
- A session keeps the mod it loaded at its start. After an update of the mod, start a new session. If the page is newer than the mod of its session, the page shows a warning.
- A stored review needs its plan file. If the plan file under `~/.claude/plans/` is gone, the review cannot come back. The store keeps the reviews of the last 8 folders. When you approve the plan, reset the review or leave plan mode, the mod drops the stored review of the folder.
- A plan opened from a file has no plan mode session behind it. After Submit with comments, the revision request asks Claude to update the plan file and call `ExitPlanMode`. If the new version does not appear, run `/plan-review open` again.
- The diagram shows calls as the clean session read them. It is a reading of the code, not a compiler's analysis.
