import { ActionResult, CompanionAction, CompanionState } from "../types";
import { isStuckFailure, StuckLearning } from "./learning";

export type StuckHandler = {
  onChat: (message: string) => Promise<void>;
  onActions: (actions: CompanionAction[]) => Promise<ActionResult[]>;
};

export async function handleStuckAfterAction(
  learning: StuckLearning,
  action: CompanionAction,
  result: ActionResult,
  state: CompanionState | null,
  handler: StuckHandler
): Promise<void> {
  if (!state || result.ok) {
    return;
  }
  if (action.type !== "move_to" && action.type !== "run_task") {
    return;
  }
  if (!isStuckFailure(result.reason)) {
    return;
  }

  learning.rememberAction(action);
  const { askHelp, tryFirst } = learning.enterStuck(state);

  if (tryFirst.length > 0) {
    const results = await handler.onActions(tryFirst);
    const stillStuck = results.some((r) => !r.ok);
    if (!stillStuck && action.type === "move_to") {
      const retry = learning.retryMoveAction();
      if (retry) {
        await handler.onActions([retry]);
      }
      return;
    }
    if (!stillStuck) {
      return;
    }
  }

  if (askHelp) {
    await handler.onChat(askHelp);
  }
}

export async function handleStuckObservation(
  learning: StuckLearning,
  state: CompanionState,
  handler: StuckHandler
): Promise<void> {
  const { freed } = learning.observe(state);
  if (!freed) {
    return;
  }
  console.log("[learn] path cleared — retrying movement");
  const retry = learning.retryMoveAction();
  if (retry) {
    await handler.onActions([retry]);
  }
}

export function handleOwnerHelpAck(
  learning: StuckLearning,
  message: string,
  state: CompanionState | null,
  handler: StuckHandler
): void {
  if (!state || !learning.isAwaitingHelp) {
    return;
  }
  if (!learning.onOwnerSaysDone(message)) {
    return;
  }
  void (async () => {
    learning.finalizeHelp(state);
    const retry = learning.retryMoveAction();
    if (retry) {
      await handler.onActions([retry]);
    }
  })();
}
