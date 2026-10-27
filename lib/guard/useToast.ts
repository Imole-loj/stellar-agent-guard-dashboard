/**
 * useToast — centralized toast notification queue (issue #105).
 *
 * Async operations (transaction submissions, read-polling failures) used to
 * surface feedback in fragmented ways. This module owns one framework-free
 * queue; `ToastContainer` renders it and `useToast` binds React to it.
 *
 * Design notes:
 * - The store is plain TypeScript (no DOM) so the queue semantics are unit
 *   testable under node:test; the component is a thin view.
 * - Auto-dismiss is per-toast and timer-based. Success/info/warning dismiss
 *   on their own; errors persist until acknowledged (an RPC exception the
 *   user never saw is worse than a toast they must close). Every duration
 *   is overridable per dispatch.
 * - At most MAX_VISIBLE toasts are kept; the oldest non-error toast is
 *   dropped first so a persistent error is never evicted by noise.
 */
import { useSyncExternalStore } from "react";

export type ToastKind = "success" | "warning" | "error" | "info";

export interface ToastErrorDetails {
  /** Raw error message (e.g. RPC exception text). */
  message: string;
  /** Optional status/code (HTTP status, Soroban error code). */
  status?: string | number;
  /** Optional stack trace for the inspector. */
  stack?: string;
  /** Write stage, when known, so recovery guidance can name it (issue #385). */
  stage?: "discovery" | "enforcement" | "submission";
  /** Whether the failed operation was a read or a write. */
  context?: "read" | "write";
}

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  error?: ToastErrorDetails;
  /** Epoch ms when created. */
  createdAt: number;
}

export interface DispatchToast {
  kind: ToastKind;
  title: string;
  detail?: string;
  error?: ToastErrorDetails;
  /** Override the kind's default auto-dismiss. `null` = persist. */
  durationMs?: number | null;
}

const DEFAULT_DURATION_MS: Record<ToastKind, number | null> = {
  success: 5_000,
  info: 5_000,
  warning: 8_000,
  error: null,
};

const MAX_VISIBLE = 5;

export class ToastStore {
  private toasts: Toast[] = [];
  private listeners = new Set<() => void>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextId = 1;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): Toast[] => this.toasts;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  dispatch(input: DispatchToast): number {
    const id = this.nextId++;
    const duration =
      input.durationMs !== undefined ? input.durationMs : DEFAULT_DURATION_MS[input.kind];
    this.toasts = [
      ...this.toasts,
      {
        id,
        kind: input.kind,
        title: input.title,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        createdAt: Date.now(),
      },
    ];
    if (duration !== null) {
      this.timers.set(
        id,
        setTimeout(() => this.dismiss(id), duration),
      );
    }
    this.enforceCap();
    this.emit();
    return id;
  }

  private enforceCap(): void {
    while (this.toasts.length > MAX_VISIBLE) {
      const victim = this.toasts.find((t) => t.kind !== "error") ?? this.toasts[0];
      if (victim === undefined) break;
      this.dismiss(victim.id);
    }
  }

  dismiss(id: number): void {
    if (!this.toasts.some((t) => t.id === id)) return;
    this.clearTimer(id);
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }

  clear(): void {
    for (const id of this.timers.keys()) this.clearTimer(id);
    this.toasts = [];
    this.emit();
  }
}

export const toastStore = new ToastStore();

export interface UseToast {
  toasts: Toast[];
  toast: (input: DispatchToast) => number;
  success: (title: string, detail?: string) => number;
  warning: (title: string, detail?: string) => number;
  info: (title: string, detail?: string) => number;
  error: (title: string, error: ToastErrorDetails, detail?: string) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

export function useToast(store: ToastStore = toastStore): UseToast {
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    toasts,
    toast: (input) => store.dispatch(input),
    success: (title, detail) =>
      store.dispatch({ kind: "success", title, ...(detail !== undefined ? { detail } : {}) }),
    warning: (title, detail) =>
      store.dispatch({ kind: "warning", title, ...(detail !== undefined ? { detail } : {}) }),
    info: (title, detail) =>
      store.dispatch({ kind: "info", title, ...(detail !== undefined ? { detail } : {}) }),
    error: (title, error, detail) =>
      store.dispatch({ kind: "error", title, error, ...(detail !== undefined ? { detail } : {}) }),
    dismiss: (id) => store.dismiss(id),
    clear: () => store.clear(),
  };
}
