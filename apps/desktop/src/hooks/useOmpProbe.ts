import { useCallback, useEffect, useRef, useState } from "react";

import {
  InvalidOperationPayloadError,
  isTerminalOperation,
  type OmpProbeOperationSnapshot,
  type OperationSnapshot,
} from "../domain/operation";
import { InvalidProbePayloadError, type ProbeMachineState } from "../domain/probe";
import {
  getOmpProbeOperation,
  resumeOrStartOmpProbe,
  startNewOmpProbe,
} from "../services/probe-client";

export interface OmpProbeController {
  readonly state: ProbeMachineState;
  readonly operation: OperationSnapshot | null;
  readonly operationRefreshFailure: "invoke_failed" | "invalid_payload" | null;
  readonly retry: () => void;
}

export function useOmpProbe(): OmpProbeController {
  const [state, setState] = useState<ProbeMachineState>({ phase: "loading" });
  const [operation, setOperation] = useState<OperationSnapshot | null>(null);
  const [operationRefreshFailure, setOperationRefreshFailure] = useState<
    "invoke_failed" | "invalid_payload" | null
  >(null);
  const [pollRevision, setPollRevision] = useState(0);
  const mounted = useRef(false);
  const requestSequence = useRef(0);

  const applySnapshot = useCallback((snapshot: OmpProbeOperationSnapshot) => {
    setOperation(snapshot.operation);
    setOperationRefreshFailure(null);
    switch (snapshot.operation.status) {
      case "queued":
      case "running":
      case "cancelling":
        setState({ phase: "loading" });
        break;
      case "succeeded":
        if (snapshot.result === null) {
          setState({
            phase: "failed",
            code: "invalid_payload",
            diagnostic: null,
          });
        } else {
          setState({ phase: "resolved", report: snapshot.result });
        }
        break;
      case "timed_out":
        setState({
          phase: "failed",
          code: "operation_timed_out",
          diagnostic: snapshot.diagnostic,
        });
        break;
      case "failed":
        setState({
          phase: "failed",
          code: "operation_failed",
          diagnostic: snapshot.diagnostic,
        });
        break;
      case "cancelled":
      case "needs_reconciliation":
        setState({
          phase: "failed",
          code: "operation_interrupted",
          diagnostic: snapshot.diagnostic,
        });
        break;
    }
  }, []);

  const run = useCallback(
    (forceNew: boolean) => {
      const requestId = ++requestSequence.current;
      setState({ phase: "loading" });
      setOperationRefreshFailure(null);
      if (forceNew) {
        setOperation(null);
      }
      const request = forceNew ? startNewOmpProbe() : resumeOrStartOmpProbe();

      void request.then(
        (snapshot) => {
          if (mounted.current && requestId === requestSequence.current) {
            applySnapshot(snapshot);
          }
        },
        (error: unknown) => {
          if (mounted.current && requestId === requestSequence.current) {
            setState({
              phase: "failed",
              code:
                error instanceof InvalidOperationPayloadError ||
                error instanceof InvalidProbePayloadError
                  ? "invalid_payload"
                  : "invoke_failed",
              diagnostic: null,
            });
          }
        },
      );
    },
    [applySnapshot],
  );

  useEffect(() => {
    mounted.current = true;
    run(false);
    return () => {
      mounted.current = false;
    };
  }, [run]);

  useEffect(() => {
    if (operation === null) {
      return;
    }
    const terminal = isTerminalOperation(operation.status);
    if (
      terminal &&
      (operation.history_persisted || operation.persistence_diagnostic?.retryable === false)
    ) {
      return;
    }

    const requestId = requestSequence.current;
    const operationId = operation.operation_id;
    const timeout = window.setTimeout(
      () => {
        void getOmpProbeOperation(operationId).then(
          (snapshot) => {
            if (
              mounted.current &&
              requestId === requestSequence.current &&
              snapshot.operation.operation_id === operationId
            ) {
              applySnapshot(snapshot);
            }
          },
          (error: unknown) => {
            if (!mounted.current || requestId !== requestSequence.current) {
              return;
            }
            const failure =
              error instanceof InvalidOperationPayloadError ||
              error instanceof InvalidProbePayloadError
                ? "invalid_payload"
                : "invoke_failed";
            if (terminal) {
              setOperationRefreshFailure(failure);
              setPollRevision((value) => value + 1);
            } else {
              setState({
                phase: "failed",
                code: failure,
                diagnostic: null,
              });
            }
          },
        );
      },
      terminal &&
        (operation.persistence_diagnostic?.retryable === true || operationRefreshFailure !== null)
        ? 1_100
        : terminal
          ? 250
          : 120,
    );
    return () => {
      window.clearTimeout(timeout);
    };
  }, [applySnapshot, operation, operationRefreshFailure, pollRevision]);

  const retry = useCallback(() => {
    run(true);
  }, [run]);

  return { state, operation, operationRefreshFailure, retry };
}
