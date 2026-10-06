import type { components } from "@/api/schema";
import { ApiError } from "./api";
import { accessToken, dropSession } from "./auth";

type S = components["schemas"];
export type StagedUpload = S["StagedUpload"];
export type Finding = S["Finding"];

/**
 * Staging a bundle, over XMLHttpRequest rather than fetch.
 *
 * `fetch` reports no upload progress — there is no event for bytes sent — and a
 * 300 MB bundle over a slow link with no feedback is indistinguishable from a
 * hang. That is the whole reason this file exists beside the fetch client; the
 * previous admin UI reached the same conclusion for the same reason.
 *
 * The body is the raw file, so neither side needs a multipart parser.
 */

const ENDPOINT = "/admin/api/uploads";

export interface StageOptions {
  /** Target platforms, sent only when the operator had to supply them. */
  platforms?: readonly string[] | null;
  expectedSha256: string;
  onProgress?: (loaded: number, total: number) => void;
}

/** Percentage for display. Derived on every render, never stored — a stored
 *  percentage is how a bar and its own caption end up disagreeing. */
export function progressPercent(loaded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
}

/** The findings attached to a refusal, or an empty list when it carried none. */
export function findings(error: unknown): Finding[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.problem.details;
  return Array.isArray(details) ? (details as Finding[]) : [];
}

/**
 * Whether this refusal is the one the bundle cannot answer for itself.
 *
 * Keyed on `rule`, never on the message: the message is prose for a person and
 * may be reworded at any time, while the rule is part of the contract.
 */
export const CONFIG_NEEDS_PLATFORMS = "config_only_needs_platforms";

export function needsPlatforms(error: unknown): boolean {
  return findings(error).some((f) => f.rule === CONFIG_NEEDS_PLATFORMS);
}

/**
 * The refusal that says this commit would point the channel at an older release.
 *
 * The comparison belongs to the server and stays there: this reads the finding it
 * sent back rather than deciding for itself which of two versions is newer. A
 * second opinion in the browser about the one action that reaches an aircraft is
 * exactly the kind of agreement that stops being one.
 */
export const CHANNEL_ROLLBACK = "channel_rollback";

export function rollback(error: unknown): Finding | null {
  return findings(error).find((f) => f.rule === CHANNEL_ROLLBACK) ?? null;
}

export function stageBundle(file: File, options: StageOptions): Promise<StagedUpload> {
  const query = options.platforms?.length
    ? `?platforms=${encodeURIComponent(options.platforms.join(","))}`
    : "";

  return new Promise<StagedUpload>((resolve, reject) => {
    void (async () => {
      const token = await accessToken();
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${ENDPOINT}${query}`);
      xhr.setRequestHeader("Content-Type", "application/gzip");
      // Same CSRF defence as the fetch client: a plain HTML form cannot set it.
      xhr.setRequestHeader("X-Requested-With", "fetch");
      xhr.setRequestHeader("X-Expected-SHA256", options.expectedSha256);
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

      if (options.onProgress) {
        xhr.upload.addEventListener("progress", (event) => {
          // `lengthComputable` is false on some proxies; reporting a total of 0
          // is better than reporting a percentage computed from nothing.
          options.onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
        });
      }

      xhr.addEventListener("load", () => {
        const body = parseBody(xhr.responseText);

        if (xhr.status === 401 && token) {
          // Same reasoning as the fetch client: we sent a token the server would
          // not have, so it is stale rather than merely expired.
          void dropSession().finally(() => window.location.replace("/admin/"));
          reject(new ApiError({ status: 401, code: "unauthorized", message: "Session expired" }));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new ApiError({
            status: xhr.status,
            // The envelope names the code `error`, not `code`.
            code: body?.error ?? "server_error",
            message: body?.message ?? xhr.statusText,
            details: body?.details,
          }));
          return;
        }
        resolve(body as StagedUpload);
      });

      // A transport failure has no body and no status. Surfacing it as an
      // ApiError keeps every caller on one error type; swallowing it would leave
      // the screen sitting on a progress bar that stopped for no stated reason.
      xhr.addEventListener("error", () => reject(new ApiError({
        status: 0, code: "server_error", message: "The upload could not reach the server",
      })));
      xhr.addEventListener("abort", () => reject(new ApiError({
        status: 0, code: "server_error", message: "Upload cancelled",
      })));

      xhr.send(file);
    })();
  });
}

function parseBody(text: string): { error?: string; message?: string; details?: unknown } | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // An HTML error page from something in front of the server, most likely.
    return null;
  }
}
