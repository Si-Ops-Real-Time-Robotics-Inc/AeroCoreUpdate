import { ApiError } from "@/lib/api";
import type { components } from "@/api/schema";

type S = components["schemas"];
export type Finding = S["Finding"];

/**
 * Promoting a release: the one action in this system that reaches an aircraft.
 *
 * A state machine rather than a pair of booleans, because the property that matters is
 * structural: there is no state from which the channel moves without a person having read a
 * sentence naming both versions. Two confirmations, and they answer different questions —
 * one before sending (this release sits on another channel and promoting clears it), one
 * after a refusal (this is a backward move).
 *
 * NOTHING HERE COMPARES TWO VERSIONS. `confirmingRollback` is reachable only from the
 * server's refusal. A second opinion in the browser about which of two versions is newer is
 * exactly the kind of agreement that silently stops being one, and this is not the feature to
 * hold it in two places.
 */

export interface Target {
  system: string;
  channel: string;
  version: string;
  /** Other channels currently serving this version, which promoting would clear. */
  losing: string[];
}

export type PromoteState =
  | { phase: "idle" }
  | { phase: "confirming"; target: Target }
  | { phase: "sending"; target: Target; override: boolean }
  | { phase: "confirmingRollback"; target: Target; from: string; to: string }
  | { phase: "done"; target: Target; released: string[] }
  | { phase: "cancelled" };

export type PromoteAction =
  | { type: "choose"; target: Target }
  | { type: "confirm" }
  | { type: "refused"; finding: Finding }
  | { type: "failed" }
  | { type: "succeeded"; released: string[] }
  | { type: "decline" }
  | { type: "reset" };

export function promoteReducer(state: PromoteState, action: PromoteAction): PromoteState {
  switch (action.type) {
    case "choose":
      return { phase: "confirming", target: action.target };

    case "confirm":
      // The only two states a request may leave from, and each carries whether the override
      // rides with it. An override cannot be sent from `confirming`: it is only ever the
      // answer to a refusal that has already happened.
      if (state.phase === "confirming") {
        return { phase: "sending", target: state.target, override: false };
      }
      if (state.phase === "confirmingRollback") {
        return { phase: "sending", target: state.target, override: true };
      }
      return state;

    case "refused":
      // Only from `sending`, and only carrying what the server said. `from` and `to` are the
      // server's, not this screen's reading of the two version strings.
      if (state.phase !== "sending") return state;
      if (!action.finding.from || !action.finding.to) return state;
      return {
        phase: "confirmingRollback",
        target: state.target,
        from: action.finding.from,
        to: action.finding.to,
      };

    case "failed":
      // Any other refusal: back to where the operator can read it and decide, not forward.
      return state.phase === "sending" ? { phase: "confirming", target: state.target } : state;

    case "succeeded":
      return state.phase === "sending"
        ? { phase: "done", target: state.target, released: action.released }
        : state;

    case "decline":
      // From either question. `cancelled` sends nothing further by construction: no action
      // leads out of it except `reset`, which starts over from idle.
      return state.phase === "confirming" || state.phase === "confirmingRollback"
        ? { phase: "cancelled" }
        : state;

    case "reset":
      return { phase: "idle" };

    default:
      return state;
  }
}

/** Whether a request is in flight — the screen disables its controls on this. */
export function isSending(state: PromoteState): boolean {
  return state.phase === "sending";
}

export const CHANNEL_ROLLBACK = "channel_rollback";

/**
 * The backward-move finding from a refusal, or null.
 *
 * Keyed on `rule`, never on the message: the message is prose for a person and may be
 * reworded at any time, while the rule is part of the contract.
 */
export function rollbackFinding(error: unknown): Finding | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.problem.details;
  if (!Array.isArray(details)) return null;
  return (details as Finding[]).find((f) => f.rule === CHANNEL_ROLLBACK) ?? null;
}
