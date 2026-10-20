# Plan Crutches

Plan Crutches is a mod for Claude Code. It shows Claude's plan in a review page in your browser before Claude writes any code. You see the task, a short summary, the change tree, the signatures of new and changed methods and a diff against the current files. A changed or deleted method shows as a git-style diff: its current code as removed lines, the planned code as added lines. You comment on folders, files, symbols or any text you select with the mouse. When a file needs no comments, you tick it as OK. You ask the page to explain any place of the plan. A 3D diagram shows the files and the calls the plan changes. Then you press Submit. With comments, Claude revises the plan and the page shows the next version. Without comments, Claude proceeds to implementation.

The landing page with screenshots is at https://s-rybak.github.io/plan-crutches/.

## How it works

1. You start plan mode and give Claude a task.
2. Claude writes the plan file as usual and ends it with a `plan-crutches` JSON block. The block marks every symbol as new, modified or deleted. The mod adds this instruction to the plan mode reminder.
3. When Claude calls `ExitPlanMode`, the mod reads the plan file, starts the review page server, opens the page and tells Claude to wait.
4. You review in the page. Every comment is saved in the session state and in a Markdown record. The record, the live review and every version of the plan are files under `~/.claude/plan-crutches/<project>/`, outside the project. If Claude Code restarts and you resume the session, the review comes back on its own. If you start a new session in the same folder, `/plan-review restore` brings it back.
5. Submit sends your comments to Claude as the next message. Claude updates the plan file and calls `ExitPlanMode` again. The page shows version 2 and marks your comments as resolved. Highlight changes shows what version 2 changed against version 1.
6. Submit with no pending comments approves the plan. Claude Code then shows its own plan dialog once. Press Yes there to start the implementation.

A plan can also come from a file. `/plan-review open <path>` reads a Markdown plan file and starts the same review. The page, the pane, the record and the saved review all work as for a plan from plan mode. The path is absolute or relative to the project folder, and `~` stands for your home folder. Use it for a plan from an earlier session under `~/.claude/plans/`, or for a plan you wrote by hand. If the file is already under review, the command opens it as the next version, and your comments stay. If another plan is under review, the command resets that review first. If you give no path, the mod finds the plan itself. It takes the plan file of this session: the file plan mode names, or the file the review already holds. If there is none, it takes the newest `.md` file under `~/.claude/plans/`. The reply names the file it chose and why.

## The review page

The page is plain HTML, CSS and JavaScript under `web/`, served by a small Node server under `server/` on `127.0.0.1`. The mod starts the server with `$.process.spawn`. After every change, the mod pushes the review state to the server. The mod reads every action of the page from the server's standard output. The page gets the state over Server-Sent Events, so it follows the session live.

- Header: plan title, version, status, comment count, the count of files marked OK, connection dot, theme toggle, language toggle (EN and UA) and the Submit button. When the plan has more than one version, the version becomes a list. Pick an earlier version to look at it. The path of the Markdown record has a line of its own under the badges. The header and the tabs float: they stay at the top while you scroll.
- Task: the raw task text, from the Jira issue Claude fetched or from your prompt.
- Summary: the plan summary as Markdown with images, cut at 9000 characters with a Show all button. Press Edit to change the text. Save to the plan writes it into the plan file, and the next revision prompt tells Claude to keep your wording. When the plan has an earlier version, Highlight changes shows the summary as a text diff against that version. The list next to the button picks the version to compare with.
- Changes by folder: every folder and file the plan touches, marked `new`, `mod` or `del`, with the number of comments on each. Click a folder to fold it, click the speech bubble to comment on it, click a file to open it. Every row has an OK box. When the file needs no comments, tick it. The box of a folder ticks every file under it. When a new version changes a file, the mod clears its OK mark. With Highlight changes on, each row carries a chip: added, changed or removed since the compared version. A removed file stays in the tree as a crossed-out row.
- File view: the description of the change and each symbol with its highlighted signature. Each symbol says what the plan does to it: new, modified or deleted. Below them, a diff against the current file. The Full file button shows the whole file with the same changes woven in at their place. A modified symbol appears in the diff as git shows it: its current code as removed lines, the planned signature as added lines. A deleted symbol appears as removed lines only. An Expand implementation button asks the model for a body. For a modified symbol, the body appears next to the code it replaces. In the diff and in the preview of a new file, every planned signature carries a Show implementation button. The generated code takes the place of the stub right there, under the removed lines, and you can comment on its lines.
- Select any text with the mouse, in a code block, the summary, the task or an answer: a popup opens next to the selection with three tabs. Drag its title bar to move the window. Comment: type the comment and press Enter. A code comment keeps the line range and the selected text, and the lines stay marked. Ask: type a question about the selected text and press Enter. Claude answers in the same window, with the selection and its place as context, and you continue the conversation there. The thread is kept in the Ask tab, and "Add the conversation to a comment" turns it into a comment on the same lines. Explain: Claude says what this place is, where it sits in the project and why the plan changes it. The answer comes in the language you write in. When you open the tab, the page sends the request, and not before. The same place is explained once per version.
- Diagram: a 3D board with one block per planned file, colored by its status: new, modified or deleted. Each block lists the symbols the plan changes. Lines between symbols are the calls and uses the plan creates. Calls inside one file are drawn inside its block. Press Generate change diagram to build it: a clean session with read-only tools gets the plan and reads the project. Click a symbol to see every place in the project that calls it, in existing code too. The callers arrive as new rows and blocks, up to 20. More callers than that become one block marked others. Click the symbol again to hide them. The plan's own blocks are always drawn whole, with no cap on files or symbols. Test files and test folders stay out of the diagram. Each block shows the file name as its title and the folder path below it. Drag on the board rotates it, Shift and drag pans it, the wheel zooms, and 2D flattens it. Drag a block to move it. Auto layout puts the moved blocks back. Save as SVG writes the flat diagram next to the Markdown record.
- Ask: a question box that answers from the plan and the session without changing either. Every question is a thread: Reply continues the conversation under it, with the earlier turns as context. A thread shows where it came from and the selected text, and can become a comment. Answered threads go into the Markdown record.
- Versions: every version of the plan is saved, as the plan file and as the plan read from it. The version list in the header opens an earlier version. The page then shows that version read-only, with a banner. Bring this version back writes it into the plan file and makes it the next version. The history keeps the order: version 4 can be version 2 brought back.
- Comments: every comment by state (pending, sent, resolved), the version list with Open, Highlight changes and Bring this version back, and the review history. A pending comment has a pencil button to change its text and a cross to delete it. After Submit, the comment stays as Claude saw it.

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
| `plansDir` | `~/.claude/plan-crutches` | Folder for the Markdown records and SVG files. A path under `~` or an absolute path is shared, with one subfolder per project. A relative path is a folder inside the project. |
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

Generate change diagram starts a subagent of the mod's own type. The subagent runs in a clean session: no history, no CLAUDE.md, and only the read-only tools Read, Grep and Glob. Its prompt holds the whole plan and the current text of the planned files. It answers with a JSON graph: every planned file with its symbols, and the calls between them. The page draws the graph and never drops a planned block. Test files stay out of the graph and of the callers.

A click on a symbol starts a second request. The mod first runs `git grep` for the symbol name and names the function that holds each hit. The clean session gets those candidates, drops false positives, adds the callers the search missed, and answers up to 20 callers. The rest becomes one block marked others. If no subagent can start, a model call without tools answers from the plan and the file texts. If that call fails too, the page shows the text search result alone and says so.

## Security of the page

The server binds to `127.0.0.1` only. It answers only requests whose `Host` header names the local machine. A web site that points its name at `127.0.0.1` gets a 403. Every API call carries a token that the mod makes once per session. The page gets the token from the link, keeps it in local storage and then removes it from the address bar. Project files are served under `/project/` with the same token, for images in the summary and for the Full file view. The server never serves a file outside the project folder. The state the mod pushes holds the plan and the signature diffs, not the text of the project files.

## Install

This repository is a plugin marketplace. In a terminal session of Claude Code, type:

```
/plugin install plan-crutches --marketplace s-rybak/plan-crutches
```

Claude Code asks to add the marketplace. Answer `y`, then pick a scope. The user scope loads the mod in every project.

From a shell:

```bash
claude plugin install plan-crutches --marketplace s-rybak/plan-crutches
```

In the desktop app, `/plugin` does not run. Click + next to the prompt box, then Plugins, then Add marketplace with `s-rybak/plan-crutches`, then Add plugin.

The mod needs Claude Code 2.1.275 or newer. The review page needs Node 18 or newer on the same machine. To get a new version, run `claude plugin update plan-crutches`, then `/reload-plugins` in a session.

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

## Landing page

The landing page is `docs/index.html`, with its screenshots under `docs/assets/`. The live site is https://s-rybak.github.io/plan-crutches/ and GitHub Pages serves it from the `docs/` folder of the `main` branch. To look at it on your machine, start the small static server and open http://127.0.0.1:4819/ in the browser. The command is:

```bash
node scripts/landing-server.mjs
```

The screenshots show the demo plan in light and dark themes. `node scripts/landing-shots.mjs` takes them again with the installed Google Chrome. It starts the demo server, drives the page and writes the WebP files under `docs/assets/`. It needs `cwebp` on the PATH.

## Limits

- The built-in plan dialog remains after approval: one Yes click.
- Claude must write the `plan-crutches` block for the structured view. Without it, the mod asks the model to extract the structure, and falls back to the Markdown alone.
- The page server runs only where the session runs, so a session in the cloud has the pane alone.
- A session keeps the mod it loaded at its start. After an update of the mod, start a new session. If the page is newer than the mod of its session, the page shows a warning.
- A stored review needs its plan file. If the plan file under `~/.claude/plans/` is gone, the review cannot come back. The live review, the generated bodies and the plan versions are files under `~/.claude/plan-crutches/<project>/`. One file holds at most 4 MB. When the record grows past that, the explanations and the questions are left out first, and the comments always stay. When you approve the plan, reset the review or leave plan mode, the mod marks the stored review of the folder as closed. The version files stay.
- A plan opened from a file has no plan mode session behind it. After Submit with comments, the revision request asks Claude to update the plan file and call `ExitPlanMode`. If the new version does not appear, run `/plan-review open` again.
- The diagram shows calls as the clean session read them. It is a reading of the code, not a compiler's analysis.
