import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import {
  launchModelRoles,
  thinkingLevels,
  type LaunchFailure,
  type LaunchModelRole,
  type LaunchOptions,
  type PtyOutputFrame,
  type PtyRunSnapshot,
  type ThinkingLevel,
} from "../domain/launch";
import type { OmpLaunchController } from "../hooks/useOmpLaunch";
import type { Translate } from "../i18n";
import type { Locale, TranslationKey } from "../i18n/resources";
import { readPtyOutput, resizePty, subscribeToPty, writePtyInput } from "../services/launch-client";

const roleKeys: Readonly<Record<LaunchModelRole, TranslationKey>> = {
  default: "launch.role.default",
  smol: "launch.role.smol",
  slow: "launch.role.slow",
  plan: "launch.role.plan",
};

function warningKey(warning: string): TranslationKey {
  switch (warning) {
    case "launch_models_unavailable":
      return "launch.warning.modelsUnavailable";
    case "launch_models_capability_unavailable":
      return "launch.warning.modelsCapabilityUnavailable";
    case "launch_models_empty":
      return "launch.warning.modelsEmpty";
    case "launch_models_busy":
      return "launch.warning.modelsBusy";
    case "launch_models_isolated_inventory":
      return "launch.warning.modelsIsolated";
    case "launch_external_terminal_detached":
      return "launch.warning.externalDetached";
    case "launch_roles_unsupported":
      return "launch.warning.rolesUnsupported";
    case "launch_thinking_unsupported":
      return "launch.warning.thinkingUnsupported";
    default:
      return "launch.warning.generic";
  }
}

function modelThinkingLevels(
  options: LaunchOptions,
  selector: string | undefined,
): readonly ThinkingLevel[] {
  if (selector === undefined) {
    return thinkingLevels;
  }
  const model = options.available_models.find((candidate) => candidate.selector === selector);
  if (model === undefined) {
    return thinkingLevels;
  }
  const advertised = new Set(model.thinking);
  return thinkingLevels.filter((level) => level === "off" || advertised.has(level));
}

function failureText(failure: LaunchFailure, t: Translate): string {
  if (failure.kind === "invalid_payload") {
    return t("launch.error.invalidPayload");
  }
  if (failure.kind === "invoke_failed") {
    return t("launch.error.invokeFailed");
  }
  return t("launch.error.backend");
}

function backendSuggestionKey(code: string): TranslationKey {
  if (code.startsWith("external_terminal_")) {
    return "launch.error.suggestion.externalTerminal";
  }
  if (code.startsWith("pty_")) {
    return "launch.error.suggestion.terminal";
  }
  if (code.startsWith("launch_plan_")) {
    return "launch.error.suggestion.plan";
  }
  return "launch.error.suggestion.refresh";
}

function formatTime(epochMs: number, locale: Locale, t: Translate): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(epochMs);
  } catch {
    return t("time.unknown");
  }
}

function ModelSelect({
  role,
  options,
  value,
  disabled,
  t,
  onChange,
}: {
  readonly role: LaunchModelRole;
  readonly options: LaunchOptions;
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly t: Translate;
  readonly onChange: (value: string | null) => void;
}) {
  const models = options.available_models;
  const inheritedMissing = value !== undefined && !models.some((model) => model.selector === value);
  return (
    <label>
      <span>{t(roleKeys[role])}</span>
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value || null)}
      >
        <option value="">{t("launch.model.useOmpDefault")}</option>
        {inheritedMissing ? <option value={value}>{value}</option> : null}
        {models.map((model) => (
          <option key={model.selector} value={model.selector}>
            {model.name} · {model.selector}
          </option>
        ))}
      </select>
    </label>
  );
}

function LaunchFailureNotice({
  failure,
  t,
}: {
  readonly failure: LaunchFailure;
  readonly t: Translate;
}) {
  const diagnostic = failure.kind === "backend" ? failure.diagnostic : null;
  return (
    <div className="launch-failure" role="alert">
      <strong>{t("launch.error.title")}</strong>
      <p>{failureText(failure, t)}</p>
      {diagnostic === null ? null : (
        <div>
          <code>{diagnostic.code}</code>
          <p>{t(backendSuggestionKey(diagnostic.code))}</p>
          {diagnostic.technical_detail_redacted.length === 0 ? null : (
            <details>
              <summary>{t("diagnostics.technicalDetail")}</summary>
              <code>{diagnostic.technical_detail_redacted}</code>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function LaunchDialog({
  controller,
  locale,
  t,
}: {
  readonly controller: OmpLaunchController;
  readonly locale: Locale;
  readonly t: Translate;
}) {
  const titleId = useId();
  const state = controller.dialog;
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(controller.close);
  const executingRef = useRef(state.phase === "executing");
  closeRef.current = controller.close;
  executingRef.current = state.phase === "executing";
  const isOpen = state.phase !== "idle";

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      [...dialog.querySelectorAll<HTMLElement>("button, select, input, [tabindex]")].filter(
        (element) => !element.hasAttribute("disabled") && element.tabIndex >= 0,
      );
    (focusable()[0] ?? dialog).focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !executingRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, [isOpen]);

  if (state.phase === "idle") {
    return null;
  }

  const handlePrepare = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    controller.prepare();
  };

  return (
    <div className="launch-dialog-backdrop">
      <section
        ref={dialogRef}
        className="surface launch-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={
          state.phase === "loading" || state.phase === "preparing" || state.phase === "executing"
        }
      >
        <div className="launch-dialog-header">
          <div>
            <p className="eyebrow">{t("launch.kicker")}</p>
            <h2 id={titleId}>
              {t(state.scope.action === "new" ? "launch.title.new" : "launch.title.resume")}
            </h2>
          </div>
          <button
            className="text-button"
            type="button"
            disabled={state.phase === "executing"}
            onClick={controller.close}
          >
            {t(state.phase === "external_launched" ? "launch.close" : "launch.cancel")}
          </button>
        </div>

        {state.phase === "loading" ? (
          <div className="launch-dialog-loading" role="status">
            <span className="button-spinner" aria-hidden="true" />
            <p>{t("launch.loadingOptions")}</p>
          </div>
        ) : null}

        {state.phase === "configuring" || state.phase === "preparing" ? (
          <form className="launch-form" onSubmit={handlePrepare}>
            <dl className="launch-scope">
              <div>
                <dt>{t("project.binding.profile")}</dt>
                <dd>{state.options.profile}</dd>
              </div>
              <div>
                <dt>{t("project.sessions.cwd")}</dt>
                <dd>
                  <code>{state.options.cwd_display}</code>
                </dd>
              </div>
              {state.options.session_id === null ? null : (
                <div>
                  <dt>{t("launch.session")}</dt>
                  <dd>
                    <code>{state.options.session_id}</code>
                  </dd>
                </div>
              )}
            </dl>

            <ModelSelect
              role="default"
              options={state.options}
              value={state.modelRoles.default}
              disabled={state.phase === "preparing"}
              t={t}
              onChange={(value) => controller.setModelRole("default", value)}
            />

            <label>
              <span>{t("launch.thinking")}</span>
              {state.thinkingLevel !== null &&
              !modelThinkingLevels(state.options, state.modelRoles.default).includes(
                state.thinkingLevel,
              ) ? (
                <small className="launch-field-warning" role="alert">
                  {t("launch.thinking.unsupported")}
                </small>
              ) : null}
              <select
                value={state.thinkingLevel ?? ""}
                disabled={state.phase === "preparing"}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  controller.setThinkingLevel(
                    value === "" ? null : (value as (typeof thinkingLevels)[number]),
                  );
                }}
              >
                <option value="">{t("launch.thinking.inherit")}</option>
                {modelThinkingLevels(state.options, state.modelRoles.default).map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>

            <details className="launch-advanced">
              <summary>{t("launch.advanced")}</summary>
              <div className="launch-role-grid">
                {launchModelRoles.slice(1).map((role) => (
                  <ModelSelect
                    key={role}
                    role={role}
                    options={state.options}
                    value={state.modelRoles[role]}
                    disabled={state.phase === "preparing"}
                    t={t}
                    onChange={(value) => controller.setModelRole(role, value)}
                  />
                ))}
              </div>
            </details>

            {state.options.warnings.length === 0 ? null : (
              <ul className="launch-warnings">
                {state.options.warnings.map((warning) => (
                  <li key={warning}>{t(warningKey(warning))}</li>
                ))}
              </ul>
            )}

            <div className="launch-dialog-actions">
              <button
                className="primary-button"
                type="submit"
                disabled={
                  state.phase === "preparing" ||
                  (state.thinkingLevel !== null &&
                    !modelThinkingLevels(state.options, state.modelRoles.default).includes(
                      state.thinkingLevel,
                    ))
                }
              >
                {state.phase === "preparing" ? (
                  <span className="button-spinner" aria-hidden="true" />
                ) : null}
                {t(state.phase === "preparing" ? "launch.preparing" : "launch.preview")}
              </button>
            </div>
          </form>
        ) : null}

        {state.phase === "preview" || state.phase === "executing" ? (
          <div className="launch-plan-preview">
            <p>{t("launch.preview.description")}</p>
            <pre>
              <code>{state.plan.display_preview_redacted}</code>
            </pre>
            <dl className="launch-scope">
              <div>
                <dt>{t("launch.planId")}</dt>
                <dd>
                  <code>{state.plan.plan_id}</code>
                </dd>
              </div>
              <div>
                <dt>{t("launch.expires")}</dt>
                <dd>{formatTime(state.plan.expires_at_epoch_ms, locale, t)}</dd>
              </div>
              <div>
                <dt>{t("launch.fingerprint")}</dt>
                <dd>
                  <code>{state.plan.input_fingerprint}</code>
                </dd>
              </div>
              <div>
                <dt>{t("project.binding.accountPolicy")}</dt>
                <dd>
                  {t(
                    state.plan.credential_policy === "automatic"
                      ? "project.accountPolicy.automatic"
                      : "project.accountPolicy.profile",
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("project.binding.terminalMode")}</dt>
                <dd>
                  {t(
                    state.plan.terminal_mode === "external"
                      ? "project.terminalMode.external"
                      : "project.terminalMode.embedded",
                  )}
                </dd>
              </div>
            </dl>
            <details className="launch-environment-summary">
              <summary>{t("launch.environment.heading")}</summary>
              <p>{t("launch.environment.description")}</p>
              <ul>
                {state.plan.environment.map((entry) => (
                  <li key={entry.name}>
                    <code>{entry.name}</code>
                    <span>
                      {t(
                        entry.present ? "launch.environment.present" : "launch.environment.absent",
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
            <p className="launch-security-note">{t("launch.preview.security")}</p>
            <div className="launch-dialog-actions">
              <button
                className="primary-button"
                type="button"
                disabled={state.phase === "executing"}
                onClick={controller.execute}
              >
                {state.phase === "executing" ? (
                  <span className="button-spinner" aria-hidden="true" />
                ) : null}
                {t(
                  state.phase === "executing"
                    ? "launch.executing"
                    : state.plan.terminal_mode === "external"
                      ? "launch.executeExternal"
                      : "launch.executeEmbedded",
                )}
              </button>
            </div>
          </div>
        ) : null}

        {state.phase === "external_launched" ? (
          <div className="launch-external-success" role="status">
            <strong>{t("launch.external.started")}</strong>
            <p>{t("launch.external.detached")}</p>
            <dl className="launch-scope">
              <div>
                <dt>{t("launch.external.terminal")}</dt>
                <dd>
                  <code>{state.launch.terminal_id}</code>
                </dd>
              </div>
              <div>
                <dt>{t("launch.external.processId")}</dt>
                <dd>{state.launch.process_id ?? t("launch.external.processIdUnavailable")}</dd>
              </div>
              <div>
                <dt>{t("launch.external.launchedAt")}</dt>
                <dd>{formatTime(state.launch.launched_at_epoch_ms, locale, t)}</dd>
              </div>
            </dl>
            <div className="launch-dialog-actions">
              <button className="primary-button" type="button" onClick={controller.close}>
                {t("launch.close")}
              </button>
            </div>
          </div>
        ) : null}

        {state.phase === "failed" ? (
          <>
            <LaunchFailureNotice failure={state.failure} t={t} />
            <div className="launch-dialog-actions">
              <button className="secondary-button" type="button" onClick={controller.recover}>
                {t(state.stage === "options" ? "launch.close" : "launch.back")}
              </button>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

function TerminalSurface({
  run,
  onRunUpdate,
  t,
}: {
  readonly run: PtyRunSnapshot;
  readonly onRunUpdate: (run: PtyRunSnapshot) => void;
  readonly t: Translate;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const onRunUpdateRef = useRef(onRunUpdate);
  const runStatusRef = useRef(run.status);
  onRunUpdateRef.current = onRunUpdate;
  runStatusRef.current = run.status;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      screenReaderMode: true,
      scrollback: 5_000,
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Noto Sans Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#07101f",
        foreground: "#e5edf8",
        cursor: "#ffb703",
        selectionBackground: "#31506f",
      },
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.focus();

    let disposed = false;
    let hydrating = true;
    let unlisten: (() => void) | null = null;
    let poll: number | null = null;
    let lastSequence = 0;
    const pending = new Map<number, PtyOutputFrame>();
    let writeQueue = Promise.resolve();
    let inputFailureShown = false;
    let inputEnabled = runStatusRef.current === "running";

    const stopStreaming = () => {
      if (poll !== null) {
        window.clearInterval(poll);
        poll = null;
      }
      unlisten?.();
      unlisten = null;
    };

    const maybeStopStreaming = (snapshot: PtyRunSnapshot) => {
      if (snapshot.status === "running") {
        return;
      }
      inputEnabled = false;
      if (lastSequence >= snapshot.last_sequence && pending.size === 0) {
        stopStreaming();
      }
    };

    const applyFrame = (frame: PtyOutputFrame) => {
      if (disposed || frame.sequence <= lastSequence) {
        return;
      }
      if (frame.sequence > lastSequence + 1) {
        terminal.writeln(`\r\n[${t("terminal.outputGap")}]\r\n`);
      }
      terminal.write(frame.bytes);
      lastSequence = frame.sequence;
    };

    const drainPending = () => {
      for (const sequence of pending.keys()) {
        if (sequence <= lastSequence) {
          pending.delete(sequence);
        }
      }
      let next = pending.get(lastSequence + 1);
      while (next !== undefined) {
        pending.delete(next.sequence);
        applyFrame(next);
        next = pending.get(lastSequence + 1);
      }
    };

    const onFrame = (frame: PtyOutputFrame) => {
      if (disposed) {
        return;
      }
      if (hydrating || frame.sequence > lastSequence + 1) {
        pending.set(frame.sequence, frame);
        while (pending.size > 256) {
          const oldest = pending.keys().next();
          if (oldest.done) {
            break;
          }
          pending.delete(oldest.value);
        }
      } else {
        applyFrame(frame);
      }
    };

    const hydrate = async () => {
      try {
        const disposeListener = await subscribeToPty(run.run_id, {
          onOutput: onFrame,
          onStatus: (snapshot) => {
            if (!disposed) {
              onRunUpdateRef.current(snapshot);
              maybeStopStreaming(snapshot);
            }
          },
          onInvalidPayload: () => {
            if (!disposed) {
              terminal.writeln(`\r\n[${t("terminal.invalidEvent")}]\r\n`);
            }
          },
        });
        if (disposed) {
          disposeListener();
          return;
        }
        unlisten = disposeListener;
      } catch {
        if (!disposed) {
          terminal.writeln(`\r\n[${t("terminal.eventsUnavailable")}]\r\n`);
        }
      }
      if (disposed) {
        return;
      }
      try {
        let hydrationHighWater: number | null = null;
        for (let page = 0; page < 16; page += 1) {
          const batch = await readPtyOutput(run.run_id, lastSequence);
          if (disposed) {
            return;
          }
          hydrationHighWater ??= batch.run.last_sequence;
          if (batch.gap_before_first_frame) {
            terminal.writeln(`[${t("terminal.outputGap")}]\r\n`);
            lastSequence = Math.max(lastSequence, batch.run.first_available_sequence - 1);
          }
          for (const frame of batch.frames) {
            applyFrame(frame);
          }
          drainPending();
          onRunUpdateRef.current(batch.run);
          maybeStopStreaming(batch.run);
          if (
            batch.frames.length === 0 ||
            (hydrationHighWater !== null && lastSequence >= hydrationHighWater)
          ) {
            break;
          }
        }
      } catch {
        if (!disposed) {
          terminal.writeln(`\r\n[${t("terminal.replayUnavailable")}]\r\n`);
        }
      } finally {
        if (disposed) {
          pending.clear();
        } else {
          hydrating = false;
          drainPending();
        }
      }
    };
    void hydrate();

    const input = terminal.onData((data) => {
      if (disposed) {
        return;
      }
      const bytes = new TextEncoder().encode(data);
      if (!inputEnabled) {
        return;
      }
      for (let offset = 0; offset < bytes.length; offset += 64 * 1_024) {
        const chunk = bytes.slice(offset, offset + 64 * 1_024);
        writeQueue = writeQueue
          .then(() => writePtyInput(run.run_id, chunk))
          .catch(() => {
            if (!disposed && !inputFailureShown) {
              inputFailureShown = true;
              terminal.writeln(`\r\n[${t("terminal.inputFailed")}]\r\n`);
            }
          });
      }
    });

    type ResizeRequest = {
      readonly rows: number;
      readonly cols: number;
      readonly pixelWidth: number;
      readonly pixelHeight: number;
    };
    let acknowledgedResize: ResizeRequest | null = null;
    let desiredResize: ResizeRequest | null = null;
    let resizeInFlight = false;
    let resizeRetry: number | null = null;
    const flushResize = () => {
      if (disposed || !inputEnabled || resizeInFlight || desiredResize === null) {
        return;
      }
      const requested = desiredResize;
      desiredResize = null;
      resizeInFlight = true;
      void resizePty(
        run.run_id,
        requested.rows,
        requested.cols,
        requested.pixelWidth,
        requested.pixelHeight,
      )
        .then(
          (snapshot) => {
            if (!disposed) {
              acknowledgedResize = requested;
              onRunUpdateRef.current(snapshot);
            }
          },
          () => {
            if (!disposed && inputEnabled) {
              desiredResize ??= requested;
              if (resizeRetry === null) {
                resizeRetry = window.setTimeout(() => {
                  resizeRetry = null;
                  flushResize();
                }, 500);
              }
            }
          },
        )
        .finally(() => {
          resizeInFlight = false;
          if (desiredResize !== null && resizeRetry === null) {
            flushResize();
          }
        });
    };
    const fitAndResize = () => {
      if (
        disposed ||
        !inputEnabled ||
        container.clientWidth === 0 ||
        container.clientHeight === 0
      ) {
        return;
      }
      try {
        fit.fit();
        const nextResize = {
          rows: terminal.rows,
          cols: terminal.cols,
          pixelWidth: container.clientWidth,
          pixelHeight: container.clientHeight,
        };
        if (
          acknowledgedResize !== null &&
          nextResize.rows === acknowledgedResize.rows &&
          nextResize.cols === acknowledgedResize.cols &&
          nextResize.pixelWidth === acknowledgedResize.pixelWidth &&
          nextResize.pixelHeight === acknowledgedResize.pixelHeight
        ) {
          return;
        }
        desiredResize = nextResize;
        flushResize();
      } catch {
        // A hidden terminal tab is fitted after it becomes active.
      }
    };
    const observer = new ResizeObserver(fitAndResize);
    observer.observe(container);
    const initialFit = window.setTimeout(fitAndResize, 0);

    let polling = false;
    poll = window.setInterval(() => {
      if (disposed || hydrating || polling) {
        return;
      }
      polling = true;
      void readPtyOutput(run.run_id, lastSequence)
        .then(
          (batch) => {
            if (disposed) {
              return;
            }
            if (batch.gap_before_first_frame) {
              terminal.writeln(`\r\n[${t("terminal.outputGap")}]\r\n`);
              lastSequence = Math.max(lastSequence, batch.run.first_available_sequence - 1);
            }
            for (const frame of batch.frames) {
              applyFrame(frame);
            }
            drainPending();
            onRunUpdateRef.current(batch.run);
            maybeStopStreaming(batch.run);
          },
          () => undefined,
        )
        .finally(() => {
          polling = false;
        });
    }, 750);

    return () => {
      disposed = true;
      window.clearTimeout(initialFit);
      stopStreaming();
      if (resizeRetry !== null) {
        window.clearTimeout(resizeRetry);
      }
      observer.disconnect();
      input.dispose();
      if (terminalRef.current === terminal) {
        terminalRef.current = null;
      }
      terminal.dispose();
    };
  }, [run.run_id, t]);

  return (
    <div className="terminal-surface-frame">
      <div className="terminal-surface-actions">
        <button className="text-button" type="button" onClick={() => terminalRef.current?.clear()}>
          {t("terminal.clear")}
        </button>
      </div>
      <div
        className="terminal-surface"
        ref={containerRef}
        role="application"
        aria-label={t("terminal.ariaLabel")}
      />
    </div>
  );
}

function TerminalWorkspace({
  controller,
  locale,
  t,
}: {
  readonly controller: OmpLaunchController;
  readonly locale: Locale;
  readonly t: Translate;
}) {
  const [interruptedRuns, setInterruptedRuns] = useState<ReadonlySet<string>>(() => new Set());
  const [forceConfirmationRunId, setForceConfirmationRunId] = useState<string | null>(null);
  const activeRun = useMemo(
    () => controller.runs.find((run) => run.run_id === controller.activeRunId) ?? null,
    [controller.activeRunId, controller.runs],
  );
  const activeModels =
    activeRun === null
      ? []
      : launchModelRoles.flatMap((role) => {
          const selector = activeRun.model_roles[role];
          return selector === undefined ? [] : [`${t(roleKeys[role])}: ${selector}`];
        });
  const moveTabFocus = (runId: string, key: string) => {
    const index = controller.runs.findIndex((run) => run.run_id === runId);
    if (index < 0) {
      return;
    }
    let nextIndex: number | null = null;
    if (key === "ArrowRight" || key === "ArrowDown") {
      nextIndex = (index + 1) % controller.runs.length;
    } else if (key === "ArrowLeft" || key === "ArrowUp") {
      nextIndex = (index - 1 + controller.runs.length) % controller.runs.length;
    } else if (key === "Home") {
      nextIndex = 0;
    } else if (key === "End") {
      nextIndex = controller.runs.length - 1;
    }
    if (nextIndex === null) {
      return;
    }
    const nextRun = controller.runs[nextIndex];
    if (nextRun === undefined) {
      return;
    }
    controller.selectRun(nextRun.run_id);
    document.getElementById(`terminal-tab-${nextRun.run_id}`)?.focus();
  };
  if (controller.runs.length === 0 && controller.runLoadFailure === null) {
    return null;
  }
  return (
    <section className="surface terminal-workspace" aria-labelledby="terminal-workspace-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t("terminal.kicker")}</p>
          <h2 id="terminal-workspace-heading">{t("terminal.heading")}</h2>
        </div>
        <button className="text-button" type="button" onClick={controller.refreshRuns}>
          {t("terminal.refresh")}
        </button>
      </div>

      {controller.runLoadFailure === null ? null : (
        <LaunchFailureNotice failure={controller.runLoadFailure} t={t} />
      )}

      <div className="terminal-tabs" role="tablist" aria-label={t("terminal.tabs")}>
        {controller.runs.map((run) => (
          <button
            key={run.run_id}
            id={`terminal-tab-${run.run_id}`}
            type="button"
            role="tab"
            aria-selected={run.run_id === controller.activeRunId}
            aria-controls={`terminal-panel-${run.run_id}`}
            tabIndex={run.run_id === controller.activeRunId ? 0 : -1}
            className={run.run_id === controller.activeRunId ? "is-active" : undefined}
            onClick={() => controller.selectRun(run.run_id)}
            onKeyDown={(event) => {
              if (
                ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(
                  event.key,
                )
              ) {
                event.preventDefault();
                moveTabFocus(run.run_id, event.key);
              }
            }}
          >
            <span>{run.title}</span>
            <small>
              {t(
                run.status === "running"
                  ? "terminal.status.running"
                  : run.status === "failed"
                    ? "terminal.status.failed"
                    : "terminal.status.exited",
              )}
            </small>
          </button>
        ))}
      </div>

      {activeRun === null ? null : (
        <div
          id={`terminal-panel-${activeRun.run_id}`}
          className="terminal-active-run"
          role="tabpanel"
          aria-labelledby={`terminal-tab-${activeRun.run_id}`}
        >
          <div className="terminal-run-toolbar">
            <div>
              <strong>{activeRun.title}</strong>
              <span>
                {formatTime(activeRun.started_at_epoch_ms, locale, t)}
                {activeRun.process_id === null ? "" : ` · PID ${activeRun.process_id}`}
              </span>
              <span>
                {t("project.binding.profile")}: {activeRun.profile}
              </span>
              <span>
                {t("terminal.models")}:{" "}
                {activeModels.length === 0
                  ? t("launch.model.useOmpDefault")
                  : activeModels.join(" · ")}
                {activeRun.thinking_level === null
                  ? ""
                  : ` · ${t("launch.thinking")}: ${activeRun.thinking_level}`}
              </span>
            </div>
            <div>
              {activeRun.status === "running" ? (
                <>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      setInterruptedRuns((current) => new Set(current).add(activeRun.run_id));
                      controller.terminateRun(activeRun.run_id, false);
                    }}
                  >
                    {t("terminal.interrupt")}
                  </button>
                  {interruptedRuns.has(activeRun.run_id) ? (
                    forceConfirmationRunId === activeRun.run_id ? (
                      <>
                        <span className="terminal-force-confirmation" role="alert">
                          {t("terminal.forceConfirm")}
                        </span>
                        <button
                          className="danger-button"
                          type="button"
                          onClick={() => {
                            setForceConfirmationRunId(null);
                            controller.terminateRun(activeRun.run_id, true);
                          }}
                        >
                          {t("terminal.confirmForce")}
                        </button>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setForceConfirmationRunId(null)}
                        >
                          {t("launch.cancel")}
                        </button>
                      </>
                    ) : (
                      <button
                        className="danger-button"
                        type="button"
                        onClick={() => setForceConfirmationRunId(activeRun.run_id)}
                      >
                        {t("terminal.forceStop")}
                      </button>
                    )
                  ) : null}
                </>
              ) : (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => controller.closeRun(activeRun.run_id)}
                >
                  {t("terminal.closeTab")}
                </button>
              )}
            </div>
          </div>
          <TerminalSurface run={activeRun} onRunUpdate={controller.updateRun} t={t} />
          {activeRun.status === "running" ? null : (
            <p className="terminal-exit-status" role="status">
              {activeRun.status === "failed" ? (
                t("terminal.failed")
              ) : (
                <>
                  {t("terminal.exited")}{" "}
                  {activeRun.exit_code === null ? t("time.unknown") : activeRun.exit_code}
                  {activeRun.signal === null ? "" : ` · ${activeRun.signal}`}
                </>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function OmpLaunchWorkspace({
  controller,
  locale,
  t,
}: {
  readonly controller: OmpLaunchController;
  readonly locale: Locale;
  readonly t: Translate;
}) {
  return (
    <>
      <LaunchDialog controller={controller} locale={locale} t={t} />
      <TerminalWorkspace controller={controller} locale={locale} t={t} />
    </>
  );
}
