import { invoke } from "@tauri-apps/api/core";

import { decodeDatabaseStatusReport, type DatabaseStatusReport } from "../domain/database";

let currentStatusRequest: Promise<DatabaseStatusReport> | null = null;
let currentRetryRequest: Promise<DatabaseStatusReport> | null = null;

export function getDatabaseStatus(): Promise<DatabaseStatusReport> {
  if (currentStatusRequest !== null) {
    return currentStatusRequest;
  }

  currentStatusRequest = invoke<unknown>("database_status")
    .then(decodeDatabaseStatusReport)
    .finally(() => {
      currentStatusRequest = null;
    });
  return currentStatusRequest;
}

export function retryDatabaseInitialization(): Promise<DatabaseStatusReport> {
  if (currentRetryRequest !== null) {
    return currentRetryRequest;
  }

  currentRetryRequest = invoke<unknown>("retry_database_initialization")
    .then(decodeDatabaseStatusReport)
    .finally(() => {
      currentRetryRequest = null;
    });
  return currentRetryRequest;
}
