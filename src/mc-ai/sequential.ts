import { CompanionAction, ActionResult } from "../types";

/** Serializes async work so only one runs at a time (promise chain). */
export class ActionRunner {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

export type UserCommandJob = {
  message: string;
  kind: "chat" | "voice" | "build";
  isBuild: boolean;
};

export type UserCommandProcessor = (job: UserCommandJob) => Promise<void>;

/**
 * Owner voice/chat commands — one full turn at a time, in order.
 */
export class UserCommandQueue {
  private readonly jobs: UserCommandJob[] = [];
  private draining = false;

  constructor(private readonly maxSize: number) {}

  get pending(): number {
    return this.jobs.length;
  }

  enqueue(job: UserCommandJob, onQueued?: (pending: number) => void): void {
    if (this.jobs.length >= this.maxSize) {
      const dropped = this.jobs.shift();
      if (dropped) {
        console.log(`[queue] dropped (full): ${dropped.message.slice(0, 48)}…`);
      }
    }
    this.jobs.push(job);
    onQueued?.(this.jobs.length);
    void this.drain();
  }

  private processor: UserCommandProcessor | null = null;

  setProcessor(fn: UserCommandProcessor): void {
    this.processor = fn;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.processor) {
      return;
    }
    this.draining = true;
    const gapMs = Number(process.env.MC_AI_COMMAND_GAP_MS ?? "500") || 500;

    while (this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      if (this.jobs.length > 0) {
        console.log(`[queue] next (${this.jobs.length} waiting): ${job.message.slice(0, 56)}`);
      }
      await this.processor(job);
      if (this.jobs.length > 0 && gapMs > 0) {
        await sleep(gapMs);
      }
    }
    this.draining = false;
  }
}

export function createQueuedSender(
  runner: ActionRunner,
  send: (action: CompanionAction) => Promise<ActionResult>
): (action: CompanionAction) => Promise<ActionResult> {
  return (action) => runner.run(() => send(action));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
