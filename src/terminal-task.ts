import {
  TerminalError,
  command,
  type CommandContext,
  type TerminalAgent,
  type TerminalCommandResult,
  type TerminalDescriptor,
  type TerminalErrorCode,
  type TerminalId,
} from '@modular/sdk';

export const RunTerminalTaskCommandId =
  'xmodular.test-mod.run-terminal-task';
export const ReadTerminalTaskCommandId =
  'xmodular.test-mod.read-terminal-task';

export interface TerminalTaskRequest {
  readonly task: string;
  readonly verificationCommand: string;
}

export type TerminalTaskStage =
  | { readonly kind: 'agent' }
  | { readonly kind: 'waiting-for-command-execution' }
  | { readonly kind: 'verification' }
  | { readonly kind: 'repair' };

export type TerminalTaskVerification =
  | {
      readonly kind: 'passed';
      readonly command: string;
      readonly output: string;
    }
  | {
      readonly kind: 'failed';
      readonly command: string;
      readonly exit: string;
      readonly output: string;
    };

export type TerminalTaskRepair =
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'completed'; readonly response: string };

export interface TerminalTaskResult {
  readonly agentTerminalId: TerminalId;
  readonly response: string;
  readonly verification: TerminalTaskVerification;
  readonly repair: TerminalTaskRepair;
  readonly transcriptMessageCount: number;
}

export interface TerminalTaskFailure {
  readonly code: TerminalErrorCode;
  readonly message: string;
}

export type TerminalTaskState =
  | { readonly kind: 'ready' }
  | { readonly kind: 'requested'; readonly request: TerminalTaskRequest }
  | {
      readonly kind: 'running';
      readonly request: TerminalTaskRequest;
      readonly stage: TerminalTaskStage;
    }
  | {
      readonly kind: 'completed';
      readonly request: TerminalTaskRequest;
      readonly result: TerminalTaskResult;
    }
  | {
      readonly kind: 'failed';
      readonly request: TerminalTaskRequest;
      readonly failure: TerminalTaskFailure;
    };

let currentTerminalTask: TerminalTaskState = { kind: 'ready' };

export const runTerminalTaskCommand = command({
  id: RunTerminalTaskCommandId,
  title: 'Test Mod: Run Terminal Task',
  run: async context => {
    const request = parseRequest(context.command.args);
    if (request instanceof TerminalError) {
      return request;
    }
    if (!canStart(currentTerminalTask)) {
      return currentTerminalTask;
    }
    await executeTerminalTask(request, context);
    return currentTerminalTask;
  },
});

export const readTerminalTaskCommand = command({
  id: ReadTerminalTaskCommandId,
  title: 'Test Mod: Read Terminal Task',
  run: () => currentTerminalTask,
});

function parseRequest(
  args: readonly unknown[]
): TerminalTaskRequest | TerminalError {
  if (args.length !== 2) {
    return invalidRequest('The terminal task requires a task and a command.');
  }
  const [task, verificationCommand] = args;
  if (typeof task !== 'string' || typeof verificationCommand !== 'string') {
    return invalidRequest('The terminal task and command must be text.');
  }
  return createTerminalTaskRequest(task, verificationCommand);
}

export function createTerminalTaskRequest(
  task: string,
  verificationCommand: string
): TerminalTaskRequest | TerminalError {
  const taskPrompt = task.trim();
  if (taskPrompt.length === 0) {
    return invalidRequest('Enter a task.');
  }
  const command = verificationCommand.trim();
  return command.length === 0
    ? invalidRequest('Enter a verification command.')
    : { task: taskPrompt, verificationCommand: command };
}

function canStart(state: TerminalTaskState): boolean {
  switch (state.kind) {
    case 'ready':
    case 'completed':
    case 'failed':
      return true;
    case 'requested':
    case 'running':
      return false;
  }
}

async function executeTerminalTask(
  request: TerminalTaskRequest,
  context: CommandContext
): Promise<void> {
  context.logger.info('[test-mod-task-runner] task started', request);
  currentTerminalTask = {
    kind: 'running',
    request,
    stage: { kind: 'agent' },
  };
  const started = await context.terminal.agents.getOrStart(
    'task-runner-agent',
    {
      provider: 'codex',
      model: 'gpt-5.6-luna',
      sandbox: 'workspace-write',
      approval: 'never',
      projectTrust: 'untrusted',
      prompt: request.task,
      terminal: {
        name: 'Codex: Task Runner',
        location: 'editor',
        reveal: 'none',
      },
    },
    { signal: AbortSignal.timeout(15_000) }
  );
  if (started instanceof TerminalError) {
    failTask(request, 'agent launch', started, context);
    return;
  }

  const verifier = await context.terminal.getOrCreate('task-runner-verifier', {
    name: 'Task verification',
    location: 'editor',
    reveal: 'none',
  });
  if (verifier instanceof TerminalError) {
    failTask(request, 'verification terminal', verifier, context);
    return;
  }
  const terminalState = verifier.state.value;
  if (terminalState.kind === 'closed') {
    failTask(
      request,
      'verification terminal',
      terminalClosed(verifier.id),
      context
    );
    return;
  }
  setVerificationStage(request, terminalState.descriptor);
  const unsubscribe = verifier.state.subscribe(next => {
    switch (next.kind) {
      case 'open':
        setVerificationStage(request, next.descriptor);
        return;
      case 'closed':
        return;
    }
  });
  const commandResult = await verifier.execute(request.verificationCommand);
  unsubscribe();
  if (commandResult instanceof TerminalError) {
    failTask(request, 'verification command', commandResult, context);
    return;
  }
  const verification = normalizeVerification(commandResult);

  const repair = await runRepair(started.agent, verification, request);
  if (repair instanceof TerminalError) {
    failTask(request, 'repair turn', repair, context);
    return;
  }
  const transcript = await started.agent.transcript();
  if (transcript instanceof TerminalError) {
    failTask(request, 'transcript read', transcript, context);
    return;
  }

  const result: TerminalTaskResult = {
    agentTerminalId: started.agent.terminal.id,
    response: started.response,
    verification,
    repair,
    transcriptMessageCount: transcript.messages.length,
  };
  context.logger.info('[test-mod-task-runner] task completed', result);
  currentTerminalTask = { kind: 'completed', request, result };
}

function setVerificationStage(
  request: TerminalTaskRequest,
  descriptor: TerminalDescriptor
): void {
  currentTerminalTask = {
    kind: 'running',
    request,
    stage: verificationStage(descriptor),
  };
}

function verificationStage(descriptor: TerminalDescriptor): TerminalTaskStage {
  switch (descriptor.commandExecution.kind) {
    case 'not-ready':
      return { kind: 'waiting-for-command-execution' };
    case 'ready':
      return { kind: 'verification' };
  }
}

async function runRepair(
  agent: TerminalAgent,
  verification: TerminalTaskVerification,
  request: TerminalTaskRequest
): Promise<TerminalTaskRepair | TerminalError> {
  switch (verification.kind) {
    case 'passed':
      return { kind: 'not-needed' };
    case 'failed': {
      currentTerminalTask = {
        kind: 'running',
        request,
        stage: { kind: 'repair' },
      };
      const repaired = await agent.run(repairPrompt(verification), {
        signal: AbortSignal.timeout(15_000),
      });
      return repaired instanceof TerminalError
        ? repaired
        : { kind: 'completed', response: repaired.response };
    }
  }
}

function normalizeVerification(
  result: TerminalCommandResult
): TerminalTaskVerification {
  const output = commandOutput(result);
  switch (result.exit.kind) {
    case 'unknown':
      return {
        kind: 'failed',
        command: result.command,
        exit: 'The shell did not report an exit code.',
        output,
      };
    case 'exited':
      return result.exit.code === 0
        ? { kind: 'passed', command: result.command, output }
        : {
            kind: 'failed',
            command: result.command,
            exit: `Exit code ${result.exit.code}`,
            output,
          };
  }
}

function commandOutput(result: TerminalCommandResult): string {
  switch (result.output.kind) {
    case 'captured':
      return result.output.value;
    case 'unavailable':
      return 'The terminal did not retain command output.';
  }
}

function repairPrompt(
  verification: Extract<TerminalTaskVerification, { kind: 'failed' }>
): string {
  return `The verification command failed. Fix the task, then report what changed.\n\nCommand: ${verification.command}\n${verification.exit}\nOutput:\n${verification.output}`;
}

function terminalClosed(terminalId: TerminalId): TerminalError {
  return new TerminalError({
    code: 'terminal-closed',
    message: `Terminal "${terminalId}" is closed.`,
    scope: { kind: 'terminal', terminalId },
  });
}

function invalidRequest(message: string): TerminalError {
  return new TerminalError({
    code: 'invalid-request',
    message,
    scope: { kind: 'global' },
  });
}

function failTask(
  request: TerminalTaskRequest,
  stage: string,
  error: TerminalError,
  context: CommandContext
): void {
  context.logger.error(
    `[test-mod-task-runner] ${stage} failed`,
    error.code,
    error.message,
    error.scope
  );
  currentTerminalTask = {
    kind: 'failed',
    request,
    failure: { code: error.code, message: error.message },
  };
}
