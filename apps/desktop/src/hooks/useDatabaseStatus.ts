import { useCallback, useEffect, useRef, useState } from "react";

import {
  InvalidDatabaseStatusPayloadError,
  type DatabaseStatusMachineState,
} from "../domain/database";
import { getDatabaseStatus, retryDatabaseInitialization } from "../services/database-client";

export interface DatabaseStatusController {
  readonly state: DatabaseStatusMachineState;
  readonly retry: () => void;
}

export function useDatabaseStatus(): DatabaseStatusController {
  const [state, setState] = useState<DatabaseStatusMachineState>({
    phase: "loading",
  });
  const mounted = useRef(false);
  const requestSequence = useRef(0);

  const run = useCallback((retryInitialization: boolean, showLoading = true) => {
    const requestId = ++requestSequence.current;
    if (showLoading) {
      setState({ phase: "loading" });
    }
    const request = retryInitialization ? retryDatabaseInitialization() : getDatabaseStatus();

    void request.then(
      (report) => {
        if (mounted.current && requestId === requestSequence.current) {
          setState({ phase: "resolved", report });
        }
      },
      (error: unknown) => {
        if (mounted.current && requestId === requestSequence.current) {
          setState({
            phase: "failed",
            code:
              error instanceof InvalidDatabaseStatusPayloadError
                ? "invalid_payload"
                : "invoke_failed",
          });
        }
      },
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    run(false);
    return () => {
      mounted.current = false;
    };
  }, [run]);

  useEffect(() => {
    if (state.phase !== "resolved" || state.report.availability !== "initializing") {
      return;
    }

    const timeout = window.setTimeout(() => {
      run(false, false);
    }, 250);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [run, state]);

  const retry = useCallback(() => {
    run(true);
  }, [run]);

  return { state, retry };
}
