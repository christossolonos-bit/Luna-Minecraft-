import { CompanionAction, CompanionState, SafetyPolicy } from "./types";

const defaultPolicy: SafetyPolicy = {
  maxMoveDistance: 32,
  allowBreakBlocks: false,
  allowPlaceBlocks: true,
  allowChat: true,
  protectedRadiusAroundPlayer: 3
};

export class SafetyGuard {
  private readonly policy: SafetyPolicy;

  constructor(policy?: Partial<SafetyPolicy>) {
    this.policy = {
      ...defaultPolicy,
      ...policy
    };
  }

  validate(action: CompanionAction, state: CompanionState): string | null {
    if (action.type === "chat" && !this.policy.allowChat) {
      return "Chat is disabled by safety policy.";
    }

    if (action.type === "mine_block" && !this.policy.allowBreakBlocks) {
      return "Mining is disabled by safety policy.";
    }

    if (action.type === "place_block" && !this.policy.allowPlaceBlocks) {
      return "Block placement is disabled by safety policy.";
    }

    if (action.type === "run_task") {
      if (process.env.MC_AI_ALLOW_TASKS === "false") {
        return "Gathering/crafting tasks are disabled.";
      }
    }

    if (action.type === "move_to") {
      const distance = dist(action.target, state.player.position);
      if (distance > this.policy.maxMoveDistance) {
        return `Move rejected: ${distance.toFixed(1)} blocks exceeds max ${this.policy.maxMoveDistance}.`;
      }
    }

    if (action.type === "mine_block" || action.type === "place_block") {
      // Protect the human player — not Luna (she must be able to break blocks beside herself when stuck).
      const owner = state.owner?.position;
      if (owner) {
        const distanceToOwner = dist(action.target, owner);
        if (distanceToOwner < this.policy.protectedRadiusAroundPlayer) {
          return "Action rejected near owner (protected radius).";
        }
      }
    }

    return null;
  }
}

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}
