import { useReducer, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Page, PageHeader } from "@/components/ui/page";
import { ChannelTable } from "@/components/systems/ChannelTable";
import { DeleteSystemPanel } from "@/components/systems/DeleteSystemPanel";
import { PromotePanel } from "@/components/systems/PromotePanel";
import { StrayBanner } from "@/components/systems/StrayBanner";
import { api, ApiError } from "@/lib/api";
import { channelsFor, channelsLosing, type Channel } from "@/lib/channels";
import { promoteReducer, rollbackFinding, type PromoteState, type Target } from "@/lib/promote";
import { canEditSystems, canPromote, canRead } from "@/lib/scopes";

/**
 * Systems and their channels: what each one is serving, and how a release reaches the fleet.
 *
 * Three different rights meet on this screen and each states its own reason when withheld —
 * reading needs `catalog:read`, creating or removing a system needs `system:write`, and
 * moving a channel needs `channel:write`, which only an admin holds. Showing a control whose
 * only outcome is a refusal reads as a broken page rather than as a permission nobody granted.
 */
export function Systems() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  // One request carries systems, channels and stray channels together.
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });

  const [state, dispatch] = useReducer(promoteReducer, { phase: "idle" } as PromoteState);
  const [error, setError] = useState<string | null>(null);
  const [newSystem, setNewSystem] = useState("");
  // Which system the operator has asked to remove, held so the question can state what
  // removing it would take with it before it is answered.
  const [removing, setRemoving] = useState<string | null>(null);

  const promote = useMutation({
    mutationFn: ({ target, override }: { target: Target; override: boolean }) =>
      api.setChannel(target.system, target.channel, target.version, { allowRollback: override }),
    onSuccess: (moved) => {
      // `released` names the channels that were serving this version and now serve nothing.
      dispatch({ type: "succeeded", released: moved?.released ?? [] });
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
    },
    onError: (err) => {
      // The server owns the comparison. This reads its refusal; it does not predict one.
      const finding = rollbackFinding(err);
      if (finding) {
        dispatch({ type: "refused", finding });
        return;
      }
      setError(err instanceof ApiError ? err.message : String(err));
      dispatch({ type: "failed" });
    },
  });

  const createSystem = useMutation({
    mutationFn: (name: string) => api.createSystem({ name }),
    onSuccess: () => {
      setNewSystem("");
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const removeSystem = useMutation({
    mutationFn: (name: string) => api.deleteSystem(name),
    onSuccess: () => {
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
    },
    onError: (err) => {
      setRemoving(null);
      setError(err instanceof ApiError ? err.message : String(err));
    },
  });

  if (catalog.isPending || me.isPending) return <Page>Loading…</Page>;

  if (!canRead(me.data)) {
    return (
      <Page>
        <PageHeader title="Systems" />
        <Alert variant="warning">
          This account cannot read the catalog. That needs the
          <span className="font-mono"> catalog:read </span>
          permission, which comes from a realm role an administrator grants.
        </Alert>
      </Page>
    );
  }

  if (catalog.error) {
    return (
      <Page>
        <Alert variant="danger">{(catalog.error as Error).message}</Alert>
      </Page>
    );
  }

  const systems = catalog.data.systems ?? [];
  const releases = catalog.data.releases ?? [];

  /**
   * Ask the first question. Which release to promote is chosen from what the catalog already
   * holds for this system — a channel serves a version of its own system and nothing else.
   */
  function choose(channel: Channel, version: string) {
    if (!version) return;
    setError(null);
    const target: Target = {
      system: channel.system ?? "",
      channel: channel.name ?? "",
      version,
      // A lookup, not a comparison: which other channels are serving this exact version and
      // would therefore be left serving nothing.
      losing: channelsLosing(catalog.data, version, {
        system: channel.system ?? "",
        channel: channel.name ?? "",
      }),
    };
    dispatch({ type: "choose", target });
  }

  return (
    <Page>
      <PageHeader
        title="Systems"
        lede="What each channel is serving, and the one action here that reaches an aircraft."
      />

      {error ? (
        <Alert variant="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}

      <StrayBanner catalog={catalog.data} />

      {!canPromote(me.data) ? (
        <Alert variant="info" className="mb-6">
          This account can see what every channel is serving but cannot move one. Promoting
          needs the
          <span className="font-mono"> channel:write </span>
          permission — uploading to the catalog and publishing to the fleet are deliberately
          different rights, and only an admin holds both.
        </Alert>
      ) : null}

      <PromotePanel
        state={state}
        onConfirm={() => {
          if (state.phase !== "confirming" && state.phase !== "confirmingRollback") return;
          const override = state.phase === "confirmingRollback";
          dispatch({ type: "confirm" });
          promote.mutate({ target: state.target, override });
        }}
        onDecline={() => {
          // Nothing further is sent, at either question.
          dispatch({ type: "decline" });
          dispatch({ type: "reset" });
        }}
      />

      {systems.map((system) => {
        const name = system.name ?? "";
        const channels = channelsFor(catalog.data, name);
        const forSystem = releases.filter((r) => r.system === name);

        return (
          <section key={name} className="mt-8">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold text-ink">{name}</h2>
              {canEditSystems(me.data) ? (
                <Button
                  variant="ghost"
                  disabled={removeSystem.isPending}
                  onClick={() => { setError(null); setRemoving(name); }}
                >
                  Remove
                </Button>
              ) : null}
            </div>

            {removing === name ? (
              <DeleteSystemPanel
                system={name}
                channels={channels}
                releaseCount={forSystem.length}
                busy={removeSystem.isPending}
                onConfirm={() => removeSystem.mutate(name)}
                onCancel={() => setRemoving(null)}
              />
            ) : null}

            <div className="mt-3">
              <ChannelTable
                channels={channels}
                canPromote={canPromote(me.data)}
                onPromote={(channel) => {
                  // The releases this system has, newest first as the catalog returns them.
                  const version = forSystem[0]?.version;
                  if (version) choose(channel, String(version));
                }}
              />
            </div>

            {canPromote(me.data) && forSystem.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-caption text-muted">Promote a specific release:</span>
                {forSystem.slice(0, 8).map((release) => (
                  <span key={String(release.version)} className="flex gap-1">
                    {channels.map((channel) => (
                      <Button
                        key={`${channel.name}-${release.version}`}
                        variant="ghost"
                        onClick={() => choose(channel, String(release.version))}
                      >
                        {String(release.version)} → {channel.name}
                      </Button>
                    ))}
                  </span>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}

      {canEditSystems(me.data) ? (
        <section className="mt-10 rounded-lg border border-line p-4">
          <h3 className="font-semibold text-ink">Add a system</h3>
          <p className="mt-1 text-sm text-muted">
            A system is a version line, not a pointer — unlike a channel, which the first
            upload creates on its own. Adding one is deliberate.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Input
              value={newSystem}
              onChange={(e) => setNewSystem(e.target.value)}
              placeholder="name"
              aria-label="System name"
            />
            <Button
              disabled={!newSystem.trim() || createSystem.isPending}
              onClick={() => createSystem.mutate(newSystem.trim())}
            >
              {createSystem.isPending ? "Adding…" : "Add"}
            </Button>
          </div>
        </section>
      ) : (
        <Alert variant="info" className="mt-10">
          Adding or removing a system needs the
          <span className="font-mono"> system:write </span>
          permission.
        </Alert>
      )}
    </Page>
  );
}
