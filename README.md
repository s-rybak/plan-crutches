# Plan Crutches

Plan Crutches is a mod for Claude Code. It shows Claude's plan in a review page in your browser before Claude writes any code. You see the task, a short summary, the change tree, the signatures of new and changed methods and a diff against the current files. You comment on folders, files, symbols or any text you select with the mouse, you draw the architecture, and you press Submit. With comments, Claude revises the plan and the page shows the next version. Without comments, Claude proceeds to implementation.

## How it works

1. You start plan mode and give Claude a task.
2. Claude writes the plan file as usual and ends it with a `plan-crutches` JSON block. The mod adds this instruction to the plan mode reminder.
3. When Claude calls `ExitPlanMode`, the mod reads the plan file, starts the review page server, opens the page and tells Claude to wait.
4. You review in the page. Every comment is saved in the session state and in a Markdown record under `docs/plans/`.
5. Submit sends your comments to Claude as the next message. Claude updates the plan file and calls `ExitPlanMode` again. The page shows version 2 and marks your comments as resolved.
6. Submit with no pending comments approves the plan. Claude Code then shows its own plan dialog once. Press Yes there to start the implementation.

## The review page

The page is plain HTML, CSS and JavaScript under `web/`, served by a small Node server under `server/` on `127.0.0.1`. The mod starts the server with `$.process.spawn`, pushes the review state to it after every change, and reads every action of the page from the server's standard output. The page gets the state over Server-Sent Events, so it follows the session live.

- Header: plan title, version, status, comment count, connection dot, theme toggle, language toggle (EN and UA) and the Submit button.
- Task: the raw task text, from the Jira issue Claude fetched or from your prompt.
- Summary: the plan summary as Markdown with images, cut at 9000 characters with a Show all button.
- Changes by folder: every folder and file the plan touches, marked `new`, `mod` or `del`, with the number of comments on each. Click a folder to fold it, click the speech bubble to comment on it, click a file to open it.
- File view: the description of the change, each symbol with its highlighted signature, a diff of the signatures against the current file, the full file on demand, and an Expand implementation button that asks the model for a body. In the diff and in the preview of a new file, every planned signature carries a Show implementation button: the generated code takes the place of the stub right there, and you can comment on its lines.
- Select any text with the mouse, in a code block, the summary, the task or an answer: a popup opens next to the selection. Type the comment and press Enter. A code comment keeps the line range and the selected text, and the lines stay marked.
- Diagram: boxes, arrows, free strokes and text labels on an SVG canvas. The drawing is saved with the review, described to Claude on Submit, and Save as SVG writes it next to the Markdown record.
- Ask: a question box that answers from the plan and the session without changing either. An answer can become a comment.
- Comments: every comment by state (pending, sent, resolved) and the review history.

The pane in Claude Code stays as a second view with the page link, so a terminal session still has a review surface.

## Colors and styles

The page reads its colors from CSS variables in `web/theme.css`, with light and dark values. Change them there, or put overrides in `web/custom.css`. That file is yours and is not part of the mod: the server serves it when it exists and the page ignores a missing one. The theme toggle in the header switches between auto, light and dark.

## Commands

| Command | What it does |
| --- | --- |
| `/plan-review` | Starts the page server if needed, opens the page and the pane. |
| `/plan-review demo` | Loads a demo plan so you can try the page without plan mode. |
| `/plan-review url` | Prints the page address with its token. |
| `/plan-review close` | Closes the pane. The page keeps running. |
| `/plan-review stop` | Stops the page server. |
| `/plan-review reset` | Clears the review state. |

## Options

Set them in `/config` or in `settings.json` under `pluginConfigs.plan-crutches.options`.

| Option | Default | Meaning |
| --- | --- | --- |
| `language` | `en` | Page and pane language, `en` or `uk`. |
| `model` | `sonnet` | Model for method bodies and for plan extraction when the block is missing. |
| `plansDir` | `docs/plans` | Folder, relative to the project, for the Markdown records and SVG files. |
| `summaryLimit` | `9000` | Characters of the summary shown before Show all. |
| `port` | `4817` | Port of the page server on 127.0.0.1. A taken port falls back to a free one. |
| `openIn` | `auto` | Where the page opens: `auto` tries the Claude desktop browser pane, then the system browser. `system` uses the system browser. `none` only shows the link. |
| `nodePath` | empty | Path of the node executable. Empty means node from PATH, then the usual install locations. Node 18 or newer. |

## Security of the page

The server binds to `127.0.0.1` only and answers only requests whose `Host` header names the local machine, so a web site that points its name at `127.0.0.1` gets a 403. Every API call carries a token that the mod makes once per session. The page gets the token from the link, keeps it in local storage and then removes it from the address bar. Project files are served under `/project/` with the same token, for images in the summary and for the Full file view, and never outside the project folder. The state the mod pushes holds the plan and the signature diffs, not the text of the project files.

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

The first two need Claude Code 2.1.275 or newer. The last one checks the page server end to end and the page modules that render Markdown, code, diffs and the tree.

## Limits

- The built-in plan dialog remains after approval: one Yes click.
- Claude must write the `plan-crutches` block for the structured view. Without it, the mod asks the model to extract the structure, and falls back to the Markdown alone.
- The page server runs only where the session runs, so a session in the cloud has the pane alone.
- The diagram editor is simple: no undo, no resize, no zoom.
