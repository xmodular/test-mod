import { useEffect, useState } from 'react';
import { TerminalError } from '@modular/sdk';
import { Button, Container, Input, Tag, Text } from '@modular/sdk/ui';
import { useViewContext } from '@modular/sdk/view';

import {
  ReadTerminalTaskCommandId,
  RunTerminalTaskCommandId,
  createTerminalTaskRequest,
  type TerminalTaskRepair,
  type TerminalTaskRequest,
  type TerminalTaskStage,
  type TerminalTaskState,
  type TerminalTaskVerification,
} from '../terminal-task';

const DefaultRequest: TerminalTaskRequest = {
  task: 'Reply with exactly hi and nothing else.',
  verificationCommand: "printf 'verification-ok\\n'",
};

export function TerminalAgentsView() {
  const context = useViewContext();
  const [state, setState] = useState<TerminalTaskState>({ kind: 'ready' });
  const [task, setTask] = useState(DefaultRequest.task);
  const [verificationCommand, setVerificationCommand] = useState(
    DefaultRequest.verificationCommand
  );

  useEffect(() => {
    void context.commands
      .execute<TerminalTaskState>(ReadTerminalTaskCommandId)
      .then(snapshot => {
        const request = requestFor(snapshot);
        setState(snapshot);
        setTask(request.task);
        setVerificationCommand(request.verificationCommand);
      })
      .catch(error => {
        context.logger.error(
          '[test-mod-task-runner] status read failed',
          error instanceof Error ? error.message : String(error)
        );
      });
  }, [context.commands, context.logger]);

  const run = async (): Promise<void> => {
    if (!canStart(state)) {
      return;
    }
    const request = createTerminalTaskRequest(task, verificationCommand);
    if (request instanceof TerminalError) {
      context.logger.error(
        '[test-mod-task-runner] invalid request',
        request.message
      );
      return;
    }
    setState({ kind: 'requested', request });
    void context.commands
      .execute<TerminalTaskState | TerminalError>(
        RunTerminalTaskCommandId,
        request.task,
        request.verificationCommand
      )
      .then(result => {
        if (result instanceof TerminalError) {
          context.logger.error(
            '[test-mod-task-runner] command failed',
            result.code,
            result.message,
            result.scope
          );
          setState({
            kind: 'failed',
            request,
            failure: { code: result.code, message: result.message },
          });
          return;
        }
        setState(result);
      })
      .catch(error => {
        context.logger.error(
          '[test-mod-task-runner] command dispatch failed',
          error instanceof Error ? error.message : String(error)
        );
      });
  };

  const revealAgent = async (): Promise<void> => {
    if (state.kind !== 'completed') {
      return;
    }
    const terminal = await context.terminal.borrow(
      state.result.agentTerminalId,
      { authority: 'control' }
    );
    if (terminal instanceof TerminalError) {
      logRevealFailure(context.logger, terminal);
      return;
    }
    const revealed = await terminal.reveal('focus');
    if (revealed instanceof TerminalError) {
      logRevealFailure(context.logger, revealed);
    }
  };

  const disabled =
    !canStart(state) ||
    task.trim().length === 0 ||
    verificationCommand.trim().length === 0;

  return (
    <main
      data-testid="terminal-agents-view"
      style={{ display: 'grid', gap: 12, padding: 12 }}
    >
      <header style={{ display: 'grid', gap: 4 }}>
        <Text as="small" font="overline" color="tertiary">
          UPDATED FROM GIT · REVISION 4
        </Text>
        <Text as="h2" font="h3" weight="semibold">
          Task Runner (fourth revision)
        </Text>
        <Text as="p" color="secondary">
          Revision 4. Each update bumps this number, so the screen tells you
          which commit the running view was built from.
        </Text>
      </header>

      <Container
        density="compact"
        scrollable={false}
        title="Task"
        variant="subtle"
      >
        <Text as="label" font="footnote" weight="medium">
          Codex task
        </Text>
        <Input
          data-testid="terminal-task-runner-task"
          value={task}
          onChange={setTask}
          disabled={!canStart(state)}
        />
        <Text as="label" font="footnote" weight="medium">
          Verification command
        </Text>
        <Input
          data-testid="terminal-task-runner-command"
          value={verificationCommand}
          onChange={setVerificationCommand}
          onEnter={() => void run()}
          disabled={!canStart(state)}
        />
        <Button
          data-testid="terminal-task-runner-run"
          disabled={disabled}
          size="sm"
          variant="primary"
          onClick={() => void run()}
        >
          Run task
        </Button>
      </Container>

      <Container
        density="compact"
        scrollable={false}
        title="Run"
        variant="subtle"
      >
        <RunResult state={state} revealAgent={revealAgent} />
      </Container>
    </main>
  );
}

function RunResult({
  state,
  revealAgent,
}: {
  readonly state: TerminalTaskState;
  readonly revealAgent: () => Promise<void>;
}) {
  switch (state.kind) {
    case 'ready':
      return <Tag label="Ready" size="sm" />;
    case 'requested':
      return (
        <Tag
          data-testid="terminal-task-runner-status"
          label="Starting task…"
          size="sm"
          variant="info"
        />
      );
    case 'running':
      return (
        <Tag
          data-testid="terminal-task-runner-status"
          label={stageLabel(state.stage)}
          size="sm"
          variant="info"
        />
      );
    case 'failed':
      return (
        <Tag
          data-testid="terminal-task-runner-status"
          label={`${state.failure.code}: ${state.failure.message}`}
          size="sm"
          variant="error"
        />
      );
    case 'completed':
      return (
        <div style={{ display: 'grid', gap: 8 }}>
          <Tag
            data-testid="terminal-task-runner-status"
            label={verificationLabel(state.result.verification)}
            size="sm"
            variant={
              state.result.verification.kind === 'passed' ? 'success' : 'error'
            }
          />
          <Text as="p">{state.result.response}</Text>
          <Text as="p" color="secondary">
            {state.result.verification.output}
          </Text>
          <RepairResultView repair={state.result.repair} />
          <Text as="small" color="tertiary">
            {state.result.transcriptMessageCount} durable transcript messages
          </Text>
          <Button
            data-testid="terminal-task-runner-reveal"
            size="sm"
            variant="secondary"
            onClick={() => void revealAgent()}
          >
            Reveal Codex terminal
          </Button>
        </div>
      );
  }
}

function RepairResultView({ repair }: { readonly repair: TerminalTaskRepair }) {
  switch (repair.kind) {
    case 'not-needed':
      return <Text as="small">No repair turn was needed.</Text>;
    case 'completed':
      return <Text as="p">{repair.response}</Text>;
  }
}

function requestFor(state: TerminalTaskState): TerminalTaskRequest {
  switch (state.kind) {
    case 'ready':
      return DefaultRequest;
    case 'requested':
    case 'running':
    case 'completed':
    case 'failed':
      return state.request;
  }
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

function verificationLabel(verification: TerminalTaskVerification): string {
  switch (verification.kind) {
    case 'passed':
      return 'Verification passed';
    case 'failed':
      return `Verification failed · ${verification.exit}`;
  }
}

function stageLabel(stage: TerminalTaskStage): string {
  switch (stage.kind) {
    case 'agent':
      return 'Running Codex task…';
    case 'waiting-for-command-execution':
      return 'Waiting for shell command support…';
    case 'verification':
      return 'Running verification…';
    case 'repair':
      return 'Returning failure to Codex…';
  }
}

function logRevealFailure(
  logger: ReturnType<typeof useViewContext>['logger'],
  error: TerminalError
): void {
  logger.error(
    '[test-mod-task-runner] agent terminal reveal failed',
    error.code,
    error.message,
    error.scope
  );
}
