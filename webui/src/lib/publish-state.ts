import type { components } from "@/api/schema";

type S = components["schemas"];
export type StagedUpload = S["StagedUpload"];
export type CommittedUpload = S["CommittedUpload"];

/**
 * The publish screen's state, as a reducer rather than a handful of booleans.
 *
 * Separated from the component so it can be tested without a DOM, and because
 * the states are the safety argument: nothing is stored before `staged`, and
 * `staged` is where a person decides. A pile of `isUploading`/`hasStaged` flags
 * can represent "staged and idle at once"; this cannot.
 *
 * There is deliberately NO transition that moves a channel. Publishing lands a
 * release on `beta`; reaching the fleet is a separate act by an admin on another
 * screen (Constitution II). If a future edit needs a `promote` event here, that
 * is the moment to stop and read the constitution rather than add one.
 */
export type PublishState =
  | { phase: "idle" }
  | { phase: "chosen"; file: File }
  | { phase: "hashing"; file: File }
  | { phase: "sending"; file: File; loaded: number; total: number }
  /** Refused because the bundle names no target platforms. Keeps the file so a
   *  retry does not ask the operator to choose it again. */
  | { phase: "needsPlatforms"; file: File; message: string }
  /** The server has read and described the bundle. NOTHING IS STORED. */
  | { phase: "staged"; file: File; staged: StagedUpload }
  | { phase: "published"; result: CommittedUpload };

export type PublishEvent =
  | { type: "choose"; file: File }
  | { type: "clear" }
  | { type: "hashing" }
  | { type: "progress"; loaded: number; total: number }
  | { type: "staged"; staged: StagedUpload }
  | { type: "needsPlatforms"; message: string }
  | { type: "failed" }
  | { type: "discard" }
  | { type: "published"; result: CommittedUpload };

/** Every event this screen can raise. Enumerated so a test can assert that none
 *  of them ships anything to the fleet. */
export const PUBLISH_EVENTS: ReadonlyArray<PublishEvent["type"]> = [
  "choose", "clear", "hashing", "progress", "staged", "needsPlatforms",
  "failed", "discard", "published",
];

const fileOf = (state: PublishState): File | null =>
  "file" in state ? state.file : null;

export function publishReducer(state: PublishState, event: PublishEvent): PublishState {
  switch (event.type) {
    case "choose":
      return { phase: "chosen", file: event.file };

    case "clear":
      return { phase: "idle" };

    case "hashing": {
      const file = fileOf(state);
      return file ? { phase: "hashing", file } : state;
    }

    case "progress": {
      const file = fileOf(state);
      if (!file) return state;
      return { phase: "sending", file, loaded: event.loaded, total: event.total };
    }

    case "needsPlatforms": {
      const file = fileOf(state);
      return file ? { phase: "needsPlatforms", file, message: event.message } : state;
    }

    case "staged": {
      const file = fileOf(state);
      return file ? { phase: "staged", file, staged: event.staged } : state;
    }

    case "failed":
      // Back to holding the file, not to idle: the operator's next move is
      // almost always to try again, and taking the file away makes them find it.
      return fileOf(state) ? { phase: "chosen", file: fileOf(state)! } : { phase: "idle" };

    case "discard":
      // Local only. There is no discard endpoint because nothing was stored.
      return { phase: "idle" };

    case "published":
      return { phase: "published", result: event.result };

    default:
      return state;
  }
}

/** Whether the screen is mid-flight and should not accept another file. */
export function isBusy(state: PublishState): boolean {
  return state.phase === "hashing" || state.phase === "sending";
}
