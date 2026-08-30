import { useCallback, useEffect, useRef, useState } from "react";

import {
  classifyLaunchFailure,
  type ExternalTerminalLaunch,
  type LaunchFailure,
  type LaunchModelRole,
  type LaunchOptions,
  type LaunchScope,
  type PrepareLaunchInput,
  type PreparedLaunchPlan,
  type PtyRunSnapshot,
  type ThinkingLevel,
} from "../domain/launch";
import {
  closePtyRun,
  executeLaunch,
  getLaunchOptions,
  listPtyRuns,
  prepareLaunch,
  subscribeToPtyStatus,
  terminatePty,
} from "../services/launch-client";

type EditableLaunch = {
  readonly scope: LaunchScope;
  readonly options: LaunchOptions;
  readonly modelRoles: Readonly<Partial<Record<LaunchModelRole, string>>>;
  readonly thinkingLevel: ThinkingLevel | null;
};

export type LaunchDialogState =
  | { readonly phase: "idle" }
  | { readonly phase: "loading"; readonly scope: LaunchScope }
  | ({ readonly phase: "configuring" | "preparing" } & EditableLaunch)
  | {
      readonly phase: "preview" | "executing";
      readonly scope: LaunchScope;
      readonly plan: PreparedLaunchPlan;
      readonly editable: EditableLaunch;
    }
  | {
      readonly phase: "failed";
      readonly stage: "options" | "prepare" | "execute";
      readonly scope: LaunchScope;
      readonly failure: LaunchFailure;
      readonly editable: EditableLaunch | null;
      readonly plan: PreparedLaunchPlan | null;
    }
  | {
      readonly phase: "external_launched";
      readonly scope: LaunchScope;
      readonly launch: ExternalTerminalLaunch;
    };

export interface OmpLaunchController {
  readonly dialog: LaunchDialogState;
  readonly runs: readonly PtyRunSnapshot[];
  readonly activeRunId: string | null;
  readonly runLoadFailure: LaunchFailure | null;
  readonly open: (scope: LaunchScope) => void;
  readonly close: () => void;
  readonly setModelRole: (role: LaunchModelRole, selector: string | null) => void;
  readonly setThinkingLevel: (level: ThinkingLevel | null) => void;
  readonly prepare: () => void;
  readonly execute: () => void;
  readonly recover: () => void;
  readonly selectRun: (runId: string) => void;
  readonly updateRun: (run: PtyRunSnapshot) => void;
  readonly closeRun: (runId: string) => void;
  readonly terminateRun: (runId: string, force: boolean) => void;
  readonly refreshRuns: () => void;
}

function mergeRun(existing: PtyRunSnapshot | undefined, incoming: PtyRunSnapshot): PtyRunSnapshot {
  const run =
    existing !== undefined && existing.status !== "running" && incoming.status === "running"
      ? {
          ...incoming,
          status: existing.status,
          finished_at_epoch_ms: existing.finished_at_epoch_ms,
          exit_code: existing.exit_code,
          signal: existing.signal,
        }
      : incoming;
  return existing === undefined
    ? run
    : {
        ...run,
        first_available_sequence: Math.max(
          existing.first_available_sequence,
          run.first_available_sequence,
        ),
        last_sequence: Math.max(existing.last_sequence, run.last_sequence),
        output_truncated: existing.output_truncated || run.output_truncated,
      };
}

function upsertRun(
  runs: readonly PtyRunSnapshot[],
  incoming: PtyRunSnapshot,
): readonly PtyRunSnapshot[] {
  const merged = mergeRun(
    runs.find((run) => run.run_id === incoming.run_id),
    incoming,
  );
  const next = runs.filter((run) => run.run_id !== incoming.run_id);
  return [merged, ...next].sort(
    (left, right) => right.started_at_epoch_ms - left.started_at_epoch_ms,
  );
}

export function useOmpLaunch(enabled: boolean): OmpLaunchController {
  const [dialog, setDialog] = useState<LaunchDialogState>({ phase: "idle" });
  const [runs, setRuns] = useState<readonly PtyRunSnapshot[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runLoadFailure, setRunLoadFailure] = useState<LaunchFailure | null>(null);
  const mounted = useRef(false);
  const dialogSequence = useRef(0);
  const runSequence = useRef(0);
  const closingRuns = useRef(new Set<string>());
  const closedRuns = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshRuns = useCallback(() => {
    if (!enabled) {
      return;
    }
    const requestId = ++runSequence.current;
    void listPtyRuns().then(
      (nextRuns) => {
        if (!mounted.current || requestId !== runSequence.current) {
          return;
        }
        const visibleRuns = nextRuns.filter(
          (run) => !closingRuns.current.has(run.run_id) && !closedRuns.current.has(run.run_id),
        );
        setRuns((current) =>
          visibleRuns
            .map((run) =>
              mergeRun(
                current.find((candidate) => candidate.run_id === run.run_id),
                run,
              ),
            )
            .sort((left, right) => right.started_at_epoch_ms - left.started_at_epoch_ms),
        );
        setRunLoadFailure(null);
        setActiveRunId((current) => {
          if (current !== null && visibleRuns.some((run) => run.run_id === current)) {
            return current;
          }
          return (
            visibleRuns.find((run) => run.status === "running")?.run_id ??
            visibleRuns[0]?.run_id ??
            null
          );
        });
      },
      (error: unknown) => {
        if (mounted.current && requestId === runSequence.current) {
          setRunLoadFailure(classifyLaunchFailure(error));
        }
      },
    );
  }, [enabled]);

  useEffect(() => {
    if (enabled) {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      let reconciliationAttempts = 0;
      const reconciliationTimer = window.setInterval(() => {
        reconciliationAttempts += 1;
        refreshRuns();
        if (reconciliationAttempts >= 15) {
          window.clearInterval(reconciliationTimer);
        }
      }, 1_000);
      void subscribeToPtyStatus({
        onStatus: (run) => {
          if (
            disposed ||
            !mounted.current ||
            closingRuns.current.has(run.run_id) ||
            closedRuns.current.has(run.run_id)
          ) {
            return;
          }
          setRuns((current) => upsertRun(current, run));
          setActiveRunId((current) => current ?? run.run_id);
          setRunLoadFailure(null);
          refreshRuns();
        },
        onInvalidPayload: () => {
          if (!disposed && mounted.current) {
            setRunLoadFailure({ kind: "invalid_payload" });
          }
        },
      }).then(
        (stop) => {
          if (disposed) {
            stop();
            return;
          }
          unlisten = stop;
          refreshRuns();
        },
        () => {
          if (!disposed) {
            refreshRuns();
          }
        },
      );
      return () => {
        disposed = true;
        window.clearInterval(reconciliationTimer);
        unlisten?.();
      };
    }
    dialogSequence.current += 1;
    runSequence.current += 1;
    closingRuns.current.clear();
    closedRuns.current.clear();
    setDialog({ phase: "idle" });
    setRuns([]);
    setActiveRunId(null);
    setRunLoadFailure(null);
  }, [enabled, refreshRuns]);

  const open = useCallback(
    (scope: LaunchScope) => {
      if (!enabled) {
        return;
      }
      const requestId = ++dialogSequence.current;
      setDialog({ phase: "loading", scope });
      void getLaunchOptions(scope, true).then(
        (options) => {
          if (!mounted.current || requestId !== dialogSequence.current) {
            return;
          }
          setDialog({
            phase: "configuring",
            scope,
            options,
            modelRoles: options.model_roles,
            thinkingLevel: options.thinking_level,
          });
        },
        (error: unknown) => {
          if (mounted.current && requestId === dialogSequence.current) {
            setDialog({
              phase: "failed",
              stage: "options",
              scope,
              failure: classifyLaunchFailure(error),
              editable: null,
              plan: null,
            });
          }
        },
      );
    },
    [enabled],
  );

  const close = useCallback(() => {
    if (dialog.phase === "executing") {
      return;
    }
    dialogSequence.current += 1;
    setDialog({ phase: "idle" });
  }, [dialog.phase]);

  const setModelRole = useCallback((role: LaunchModelRole, selector: string | null) => {
    setDialog((current) => {
      if (current.phase !== "configuring") {
        return current;
      }
      const modelRoles = { ...current.modelRoles };
      if (selector === null || selector.length === 0) {
        delete modelRoles[role];
      } else {
        modelRoles[role] = selector;
      }
      return { ...current, modelRoles };
    });
  }, []);

  const setThinkingLevel = useCallback((thinkingLevel: ThinkingLevel | null) => {
    setDialog((current) =>
      current.phase === "configuring" ? { ...current, thinkingLevel } : current,
    );
  }, []);

  const prepare = useCallback(() => {
    if (dialog.phase !== "configuring") {
      return;
    }
    const editable: EditableLaunch = dialog;
    const input: PrepareLaunchInput = {
      ...dialog.scope,
      modelRoles: dialog.modelRoles,
      thinkingLevel: dialog.thinkingLevel,
    };
    const requestId = ++dialogSequence.current;
    setDialog({ ...dialog, phase: "preparing" });
    void prepareLaunch(input).then(
      (plan) => {
        if (mounted.current && requestId === dialogSequence.current) {
          setDialog({ phase: "preview", scope: dialog.scope, plan, editable });
        }
      },
      (error: unknown) => {
        if (mounted.current && requestId === dialogSequence.current) {
          setDialog({
            phase: "failed",
            stage: "prepare",
            scope: dialog.scope,
            failure: classifyLaunchFailure(error),
            editable,
            plan: null,
          });
        }
      },
    );
  }, [dialog]);

  const execute = useCallback(() => {
    if (dialog.phase !== "preview") {
      return;
    }
    const requestId = ++dialogSequence.current;
    setDialog({ ...dialog, phase: "executing" });
    void executeLaunch(dialog.plan).then(
      (result) => {
        if (!mounted.current || requestId !== dialogSequence.current) {
          return;
        }
        if (result.kind === "external") {
          setDialog({
            phase: "external_launched",
            scope: dialog.scope,
            launch: result.launch,
          });
          return;
        }
        const run = result.run;
        runSequence.current += 1;
        setRuns((current) => upsertRun(current, run));
        setActiveRunId(run.run_id);
        setDialog({ phase: "idle" });
      },
      (error: unknown) => {
        if (mounted.current && requestId === dialogSequence.current) {
          setDialog({
            phase: "failed",
            stage: "execute",
            scope: dialog.scope,
            failure: classifyLaunchFailure(error),
            editable: dialog.editable,
            plan: dialog.plan,
          });
        }
      },
    );
  }, [dialog]);

  const recover = useCallback(() => {
    setDialog((current) => {
      if (current.phase !== "failed") {
        return current;
      }
      if (current.editable !== null) {
        return { ...current.editable, phase: "configuring" };
      }
      return { phase: "idle" };
    });
  }, []);

  const selectRun = useCallback((runId: string) => {
    setActiveRunId(runId);
  }, []);

  const updateRun = useCallback((run: PtyRunSnapshot) => {
    setRuns((current) => upsertRun(current, run));
  }, []);

  const closeRun = useCallback((runId: string) => {
    if (closingRuns.current.has(runId)) {
      return;
    }
    closingRuns.current.add(runId);
    runSequence.current += 1;
    void closePtyRun(runId)
      .then(
        () => {
          if (!mounted.current) {
            return;
          }
          runSequence.current += 1;
          closedRuns.current.add(runId);
          setRunLoadFailure(null);
          setRuns((current) => {
            const next = current.filter((run) => run.run_id !== runId);
            setActiveRunId((active) =>
              active === runId
                ? (next.find((run) => run.status === "running")?.run_id ?? next[0]?.run_id ?? null)
                : active,
            );
            return next;
          });
        },
        (error: unknown) => {
          if (mounted.current) {
            setRunLoadFailure(classifyLaunchFailure(error));
          }
        },
      )
      .finally(() => {
        closingRuns.current.delete(runId);
      });
  }, []);

  const terminateRun = useCallback((runId: string, force: boolean) => {
    void terminatePty(runId, force).then(
      (run) => {
        if (mounted.current) {
          setRuns((current) => upsertRun(current, run));
        }
      },
      (error: unknown) => {
        if (mounted.current) {
          setRunLoadFailure(classifyLaunchFailure(error));
        }
      },
    );
  }, []);

  return {
    dialog,
    runs,
    activeRunId,
    runLoadFailure,
    open,
    close,
    setModelRole,
    setThinkingLevel,
    prepare,
    execute,
    recover,
    selectRun,
    updateRun,
    closeRun,
    terminateRun,
    refreshRuns,
  };
}
