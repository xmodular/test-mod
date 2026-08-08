# Test Mod

A Modular mod that runs agent tasks. It is a copy of a local mod, renamed so it
can be installed from this repository.

Extension id: `xmodular.test-mod`

## What it adds

| Surface | What it does |
| --- | --- |
| `/test-task <prompt>` | Forks the conversation, runs the prompt in a child session, and reports the result back as a task notification. |
| `/test-branch [prompt]` | Branches the conversation from where it stands and opens the branch. |
| `/test-end [report]` | Ends a branch and reports back to the conversation it came from. |
| `/test-artifact` | Writes an HTML file into the workspace and publishes it as a session artifact. |
| Test Task Runner view | Gives Codex a task, runs one shell command to check it, and returns a failure to the same agent session. |
| `rollDice` tool + `dice-roller` agent | A small tool and agent pair. |
| `listArtifacts` tool | Lists the artifact resources this mod owns for the session. |

## Install

```
modular mod install https://github.com/xmodular/test-mod
```

Add `#branch`, `#tag`, or `#commit` to pin a revision.

## Command ids are global

Slash command ids share one namespace across every installed mod, so this mod
prefixes all four with `test-`. A mod that reuses an id another mod already
claimed fails to conclude its generation with `command '<id>' already exists`.
Extension-scoped ids such as `xmodular.test-mod.run-terminal-task` do not
collide; bare slash command ids do.

## Source layout

```
package.json          identity: publisher, name, version
package-lock.json     required by the installer; this mod has no dependencies
src/mod.tsx           the entry point the host reads
src/terminal-task.ts  the terminal task runner and its two commands
src/views/            the Test Task Runner view
```

`@modular/sdk`, React, and Lexical are provided by the host. This mod does not
depend on them, and must not vendor them.

`tsconfig.json` and `eslint.config.mjs` are generated per machine and point at a
local Modular checkout, so they are not committed.
