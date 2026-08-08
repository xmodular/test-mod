import { randomInt } from 'node:crypto';

import {
  agent,
  defineMod,
  effect,
  slashCommand,
  tool,
  view,
} from '@modular/sdk';
import type {
  AiSessionHandle,
  AiTaskHandle,
  SlashCommandContext,
} from '@modular/sdk';

import {
  readTerminalTaskCommand,
  runTerminalTaskCommand,
} from './terminal-task';

interface RollDiceInput {
  readonly count: number;
  readonly sides: number;
}

const rollDice = tool<'rollDice', RollDiceInput>({
  name: 'rollDice',
  description: 'Roll a number of dice with the given number of sides.',
  run: async ({ count, sides }: RollDiceInput) => {
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new RangeError('count must be an integer from 1 to 100');
    }
    if (!Number.isInteger(sides) || sides < 2 || sides > 1_000) {
      throw new RangeError('sides must be an integer from 2 to 1000');
    }

    const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
    const total = rolls.reduce((sum, roll) => sum + roll, 0);
    return `Rolls: ${rolls.join(', ')}\nTotal: ${total}`;
  },
});

const diceRoller = agent({
  name: 'dice-roller',
  description: 'Rolls dice.',
  prompt:
    'You are a dice roller. For every roll, call the rollDice tool and report its result without inventing or changing any values. If the user does not specify dice, roll 1d6. Do nothing else.',
});

const ARTIFACT_FILE = 'tmp/test-mod-artifact.html';
const TEST_MOD_ARTIFACT = {
  kind: 'resource',
  label: 'Test Mod preview',
  role: 'document',
} as const;

function joinUri(folder: string, path: string): string {
  const base = folder.endsWith('/') ? folder : `${folder}/`;
  return new URL(path, base).toString();
}

interface ListArtifactsInput {}

const listArtifacts = tool<'listArtifacts', ListArtifactsInput>({
  name: 'listArtifacts',
  description:
    'List reusable artifact resources owned by Test Mod for the current session. Call this before creating or updating a Test Mod artifact.',
  run: async (_input: ListArtifactsInput, ctx) => {
    const [folder] = await ctx.workspace.getFolders();
    if (folder === undefined) {
      return 'No Test Mod artifacts are available because no workspace is open.';
    }

    return JSON.stringify({
      artifacts: [
        {
          ...TEST_MOD_ARTIFACT,
          uri: joinUri(folder.uri, ARTIFACT_FILE),
        },
      ],
    });
  },
});

const artifact = slashCommand({
  id: 'artifact',
  description: 'Publish an HTML artifact in this conversation',
  run: async (_argument, ctx) => {
    const [folder] = await ctx.workspace.getFolders();
    if (folder === undefined) {
      return 'Open a workspace before publishing an artifact.';
    }

    const directory = joinUri(folder.uri, 'tmp');
    const resource = joinUri(folder.uri, ARTIFACT_FILE);
    await ctx.workspace.fs.createDirectory(directory);
    await ctx.workspace.fs.writeFile(
      resource,
      new TextEncoder().encode(`<!doctype html>
<meta charset="utf-8">
<main>
<h1>Test Mod Artifact</h1>
<p>This HTML file is published from the <code>/artifact</code> command.</p>
<dl>
<dt>Session</dt>
<dd><code>${ctx.session.id}</code></dd>
<dt>Updated</dt>
<dd>${new Date().toLocaleString()}</dd>
</dl>
</main>`)
    );

    const result = await ctx.session.artifacts.replace([
      {
        ...TEST_MOD_ARTIFACT,
        uri: resource,
      },
    ]);
    if (result instanceof Error) {
      ctx.logger.error(`artifact publish failed: ${result.message}`);
      return `Artifact publish failed: ${result.message}`;
    }
    return `Published Test Mod preview from ${resource}.`;
  },
});

const SUMMARY_PROMPT = `Summarize what you just did, for someone who did not watch you work.

Lead with the outcome in one sentence. Then the concrete changes: files touched, commands run, results measured. Name anything you could not finish and why. No preamble, no restating the request.`;

async function notifyBranchPoint(session: AiSessionHandle): Promise<void> {
  await session.notify({
    attention: 'none',
    title: 'Branch point',
    body: 'This session is a fork. The inherited conversation ends here. Treat all later turns as work in this branch.',
  });
}

async function runTask(prompt: string, ctx: SlashCommandContext): Promise<void> {
  let task: AiTaskHandle | null = null;
  try {
    const child = await ctx.session.fork({
      metadata: {
        label: 'Task',
        icon: 'CodiconChecklist',
      },
    });
    await notifyBranchPoint(child);
    task = await ctx.session.tasks.start({
      label: prompt,
      detail: `Session ${child.id} is working on: ${prompt}\n\nIts report will arrive here when it finishes.`,
    });
    await child.run(prompt);
    const summary = await child.run(SUMMARY_PROMPT);
    await task.complete({
      attention: 'respond',
      title: `Task finished: ${prompt}`,
      body: `${summary.text}\n\nSession ${child.id}`,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`task "${prompt}" failed: ${reason}`);
    try {
      if (task === null) {
        await ctx.session.notify({
          attention: 'respond',
          title: `Task failed: ${prompt}`,
          body: reason,
        });
      } else {
        await task.fail(reason);
      }
    } catch (notifyError) {
      ctx.logger.error(
        `task "${prompt}" could not report its failure: ${
          notifyError instanceof Error
            ? notifyError.message
            : String(notifyError)
        }`
      );
    }
  }
}

const BRANCH_SUMMARY_PROMPT = `Report back to the conversation this branch came from.

Lead with the outcome in one sentence. Then the concrete result: what you decided, what you changed, what you measured. Name anything unresolved. No preamble, no restating the request.`;

async function reportToParent(
  parent: AiSessionHandle,
  branch: AiSessionHandle,
  body: string
): Promise<void> {
  const branchTitle = (await branch.metadata()).title;
  await parent.notify({
    attention: 'respond',
    title:
      branchTitle === null ? 'Branch ended' : `Branch ended: ${branchTitle}`,
    body: `${body}\n\nSession ${branch.id}`,
  });
}

const branch = slashCommand({
  id: 'branch',
  description: 'Branch this conversation from where it stands and open it',
  argumentHint: '<prompt>',
  run: async (argument, ctx) => {
    const prompt = argument?.trim();
    const hasPrompt = prompt !== undefined && prompt.length > 0;
    const child = await ctx.session.fork({
      foreground: true,
      metadata: { label: 'Branch', icon: 'CodiconGitBranch' },
    });
    await notifyBranchPoint(child);
    if (hasPrompt) {
      await child.send({ type: 'prompt', text: prompt });
    }
    const what = hasPrompt ? ` It is working on: ${prompt}` : '';
    await ctx.session.notify({
      attention: 'read',
      title: 'Branch created',
      body: `Branched this conversation into session ${child.id} and opened it.${what} /end there reports back here.`,
    });
  },
});

const end = slashCommand({
  id: 'end',
  description: 'End this branch and report back to the conversation it came from',
  argumentHint: '[report]',
  run: async (argument, ctx) => {
    const parent = await ctx.session.parent();
    if (parent === null) {
      return 'This conversation is not a branch, so there is nothing to report back to.';
    }
    const note = argument?.trim();
    if (note !== undefined && note.length > 0) {
      await reportToParent(parent, ctx.session, note);
      return `Reported back to ${parent.id}.`;
    }
    void endWithSummary(parent, ctx);
    return `Summarizing this branch for ${parent.id}; the report will arrive there as a system notification.`;
  },
});

async function endWithSummary(
  parent: AiSessionHandle,
  ctx: SlashCommandContext
): Promise<void> {
  try {
    const summary = await ctx.session.run(BRANCH_SUMMARY_PROMPT);
    await reportToParent(parent, ctx.session, summary.text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`branch ${ctx.session.id} could not report back: ${reason}`);
    try {
      await reportToParent(
        parent,
        ctx.session,
        `The branch could not summarize itself: ${reason}`
      );
    } catch (notifyError) {
      ctx.logger.error(
        `branch ${ctx.session.id} could not report its failure: ${
          notifyError instanceof Error
            ? notifyError.message
            : String(notifyError)
        }`
      );
    }
  }
}

const task = slashCommand({
  id: 'task',
  description: 'Fork this conversation and run a task in the background',
  argumentHint: '<prompt>',
  run: async (argument, ctx) => {
    const prompt = argument?.trim();
    if (prompt === undefined || prompt.length === 0) {
      return 'Usage: /task <prompt> — forks this conversation and runs the prompt in a child session.';
    }
    void runTask(prompt, ctx);
  },
});

const activation = effect({ id: 'xmodular.test-mod.activation' }, ctx => {
  ctx.logger.info(
    'test-mod active; /task, /branch, /end and Terminal Agents registered'
  );
});

const terminalAgents = view({
  id: 'xmodular.test-mod.terminal-agents',
  title: 'Terminal Agents',
  container: 'left',
  icon: '$(terminal)',
  component: {
    module: './views/terminal-agents',
    exportName: 'TerminalAgentsView',
  },
});

export default defineMod({
  metadata: {
    displayName: 'Test Mod',
    description:
      "A shareable test mod: agent-facing tools that compose Modular's AI session primitives.",
  },
  ai: {
    agents: [diceRoller],
    tools: [rollDice, listArtifacts],
  },
  effects: [activation],
  commands: [
    task,
    branch,
    end,
    artifact,
    runTerminalTaskCommand,
    readTerminalTaskCommand,
  ],
  views: [terminalAgents],
});
