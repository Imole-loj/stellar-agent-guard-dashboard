import { scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  explainReason,
  isGuardReason,
  reasonNameFromCode,
  type GuardReason,
} from "stellar-agent-guard-sdk";

/** One contract invocation in a simulation trace, with its nested sub-calls. */
export interface TraceNode {
  contractId: string;
  functionName: string;
  arguments: unknown[];
  /** What the operator should read: the explanation's own `text`. */
  error?: string;
  /** The same rejection as a value, so a caller can act on the code rather than the prose. */
  errorExplanation?: GuardErrorExplanation;
  /** Return values and log lines emitted while this frame was on the stack. */
  events: string[];
  subCalls: TraceNode[];
}

export interface ParsedDiagnostic {
  tree: TraceNode[];
}

/**
 * One guard rejection, as far as this console can honestly say what it is.
 *
 * `raw` is the numeric or symbolic code exactly as the trace carried it, and it
 * is never dropped or rounded into a guess: contract and SDK vocabularies evolve
 * ahead of a pinned build, and an operator investigating a refusal needs the
 * code the chain actually emitted even when nothing here can name it.
 *
 * `recognized` is the honest half of that. A code outside this build's SDK
 * vocabulary reports `reason: null, recognized: false` rather than collapsing
 * into a name it does not have, because a wrong-looking-but-confident label is
 * worse than an admitted gap: it sends an operator to fix the wrong thing.
 */
export interface GuardErrorExplanation {
  /** The code as it arrived — number or symbol — or null when the trace carried none. */
  raw: number | string | null;
  /** The contract's reason symbol, when this build's SDK defines the code. */
  reason: GuardReason | null;
  /** False when nothing could be said about the code beyond quoting it back. */
  recognized: boolean;
  /** One line for the operator. Says plainly when the code is not recognized. */
  text: string;
}

/**
 * Explain a guard error code against the SDK's authoritative vocabulary.
 *
 * The SDK table (`GUARD_REASON_CODES`) mirrors the contract's `Error` enum and
 * is the only place this console should read names from. A local table would be
 * a second vocabulary to drift, and drift here is not cosmetic: it renames a
 * real refusal.
 *
 * Accepts the numeric enum value or the snake_case symbol, because a trace can
 * carry either — `sceContract(#n)` for a rolled-back call, a symbol for a
 * committed decision event.
 */
export function explainGuardCode(code: number | string): GuardErrorExplanation {
  if (typeof code === "number") {
    const reason = reasonNameFromCode(code);
    if (reason)
      return {
        raw: code,
        reason,
        recognized: true,
        text: `${reason} (code ${code}): ${explainReason(code)}`,
      };
    return {
      raw: code,
      reason: null,
      recognized: false,
      text:
        `Unrecognized guard error code ${code}: this build's SDK does not define it, ` +
        `so no reason is inferred.`,
    };
  }
  if (isGuardReason(code)) {
    return { raw: code, reason: code, recognized: true, text: `${code}: ${explainReason(code)}` };
  }
  return {
    raw: code,
    reason: null,
    recognized: false,
    text:
      `Unrecognized guard reason "${code}": it is not in this build's SDK vocabulary, ` +
      `so no reason is inferred.`,
  };
}

/** A host/system or auth error: quoted verbatim, never renamed into a guard reason. */
function explainOpaqueError(kind: "SystemError" | "AuthError", raw: string): GuardErrorExplanation {
  return {
    raw,
    reason: null,
    recognized: false,
    text: `${kind}(${raw})`,
  };
}

/**
 * Nothing decodable was there.
 *
 * This is the branch #312 exists for: a truncated or malformed diagnostic used
 * to come back as `UnknownError`, which reads like a classification of the
 * failure rather than an admission that the trace said nothing. A missing code
 * is reported as missing, and is never filled in from a neighbouring field.
 */
function explainAbsent(): GuardErrorExplanation {
  return {
    raw: null,
    reason: null,
    recognized: false,
    text: "No guard error code was present in this diagnostic, so no reason is inferred.",
  };
}

type Normalized =
  | { kind: "call"; contractId: string; functionName: string; args: unknown[] }
  | { kind: "return"; value: unknown }
  | {
      kind: "error";
      explanation: GuardErrorExplanation;
      contractId?: string;
      functionName?: string;
    }
  | { kind: "log"; message: string; contractId?: string; functionName?: string };

/** `scValToNative` on a non-ScVal is a programming error, not a trace failure. */
function native(value: unknown): unknown {
  try {
    return scValToNative(value as xdr.ScVal);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function render(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

/** Decode a `Error(Contract, #N)` / `Error(Auth, …)` topic, falling back to text. */
function describeError(errorScVal: unknown, message: unknown): GuardErrorExplanation {
  const decoded = native(errorScVal) as
    { type?: string; code?: number; value?: string } | undefined;
  if (decoded && typeof decoded === "object") {
    if (decoded.type === "contract" && typeof decoded.code === "number") {
      return explainGuardCode(decoded.code);
    }
    if (decoded.type === "system") {
      // Quoted, not explained: a host error is the Soroban VM speaking, and the
      // guard's reason vocabulary does not cover it.
      const raw = decoded.value ?? decoded.code;
      if (raw === undefined) return explainAbsent();
      return explainOpaqueError("SystemError", String(raw));
    }
  }

  const text = typeof message === "string" ? message : message === undefined ? "" : String(message);
  const contract = /Error\(Contract,\s*#(\d+)\)/.exec(text);
  if (contract?.[1]) return explainGuardCode(Number(contract[1]));
  const auth = /Error\(Auth,\s*(\w+)\)/.exec(text);
  if (auth?.[1]) return explainOpaqueError("AuthError", auth[1]);
  return explainAbsent();
}

/** Turn a decoded `ContractEvent` into a normalized trace step. */
function normalizeContractEvent(event: unknown): Normalized | null {
  const candidate = asRecord(event);
  if (!candidate) return null;
  const body = asRecord(candidate.body);
  if (!body) return null;

  let topics: unknown[] | undefined;
  let data: unknown;
  if (body.type === "v0") {
    const v0 = asRecord(body.v0);
    if (!v0) return null;
    topics = Array.isArray(v0.topics) ? v0.topics : [];
    data = v0.data;
  } else if (Array.isArray(candidate.topics)) {
    // Already-decoded event object rather than a wrapped XDR union.
    topics = candidate.topics;
    data = candidate.data;
  } else {
    return null;
  }

  const head = topics[0] === undefined ? undefined : native(topics[0]);
  if (head === "fn_call") {
    const contractId = topics[1] === undefined ? "C_UNKNOWN" : String(native(topics[1]));
    const functionName = topics[2] === undefined ? "unknown" : String(native(topics[2]));
    const argsVal = native(data);
    const args = Array.isArray(argsVal) ? argsVal : argsVal === undefined ? [] : [argsVal];
    return { kind: "call", contractId, functionName, args };
  }
  if (head === "fn_return") {
    return { kind: "return", value: native(data) };
  }
  if (head === "error") {
    return { kind: "error", explanation: describeError(topics[1], native(data)) };
  }
  if (head === "log") {
    return { kind: "log", message: String(native(data) ?? "") };
  }
  return null;
}

/** Try hard to make sense of one raw event, whatever shape it arrives in. */
function normalize(event: unknown): Normalized | null {
  if (typeof event === "string") {
    try {
      return normalizeContractEvent(xdr.DiagnosticEvent.fromXdr(event, "base64").event);
    } catch {
      // Not XDR: the host renders errors as plain text in some responses.
      const contract = /Error\(Contract,\s*#(\d+)\)/.exec(event);
      if (contract?.[1]) {
        return { kind: "error", explanation: explainGuardCode(Number(contract[1])) };
      }
      const auth = /Error\(Auth,\s*(\w+)\)/.exec(event);
      if (auth?.[1]) {
        return { kind: "error", explanation: explainOpaqueError("AuthError", auth[1]) };
      }
      return { kind: "log", message: event };
    }
  }

  const record = asRecord(event);
  if (!record) return null;

  // A wrapped DiagnosticEvent: dig into `.event`.
  if (record.event !== undefined) {
    const inner = normalizeContractEvent(record.event);
    if (inner) return inner;
  }

  const kind = record.type ?? record.kind;
  const contractId = typeof record.contractId === "string" ? record.contractId : undefined;
  const functionName = typeof record.functionName === "string" ? record.functionName : undefined;

  if (kind === "fn_call" || kind === "call") {
    return {
      kind: "call",
      contractId: contractId ?? "C_UNKNOWN",
      functionName: functionName ?? "unknown",
      args: Array.isArray(record.arguments)
        ? record.arguments
        : Array.isArray(record.args)
          ? record.args
          : [],
    };
  }
  if (kind === "fn_return") {
    return { kind: "return", value: record.value };
  }
  if (kind === "error" || kind === "diagnostic") {
    const context = {
      ...(contractId !== undefined && { contractId }),
      ...(functionName !== undefined && { functionName }),
    };
    const code = record.error;
    if (typeof code === "number") {
      return { kind: "error", explanation: explainGuardCode(code), ...context };
    }
    if (typeof code === "string") {
      // A symbolic code is checked against the vocabulary rather than trusted:
      // an unrecognized symbol is quoted, and `explainGuardCode` says so.
      return { kind: "error", explanation: explainGuardCode(code), ...context };
    }
    return {
      kind: "error",
      explanation: describeError(record.errorScVal, record.message ?? record.data),
      ...context,
    };
  }
  if (kind === "log") {
    return {
      kind: "log",
      message: String(record.message ?? record.data ?? ""),
      ...(contractId !== undefined && { contractId }),
      ...(functionName !== undefined && { functionName }),
    };
  }

  return normalizeContractEvent(event);
}

/**
 * Parse a simulation's diagnostic events into the contract call hierarchy they
 * describe: `fn_call` opens a frame, `fn_return` closes it, and an `error`/`log`
 * attaches to whatever frame is currently on the stack. This is what lets an
 * operator see *where* in a nested call a guard refusal happened, not just that
 * the transaction failed.
 */
export function parseDiagnosticLogs(events: unknown[]): ParsedDiagnostic {
  if (!events || events.length === 0) return { tree: [] };

  const tree: TraceNode[] = [];
  const stack: TraceNode[] = [];

  const syntheticNode = (input: { contractId?: string; functionName?: string }): TraceNode => {
    const node: TraceNode = {
      contractId: input.contractId ?? "C_UNKNOWN",
      functionName: input.functionName ?? "unknown",
      arguments: [],
      events: [],
      subCalls: [],
    };
    tree.push(node);
    return node;
  };

  for (const raw of events) {
    const step = normalize(raw);
    if (!step) continue;

    if (step.kind === "call") {
      const node: TraceNode = {
        contractId: step.contractId,
        functionName: step.functionName,
        arguments: step.args,
        events: [],
        subCalls: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.subCalls.push(node);
      else tree.push(node);
      stack.push(node);
    } else if (step.kind === "return") {
      const frame = stack.pop();
      if (frame) {
        frame.events.push(`return: ${render(step.value)}`);
      } else {
        syntheticNode({}).events.push(`return: ${render(step.value)}`);
      }
    } else if (step.kind === "error") {
      const frame = stack[stack.length - 1] ?? syntheticNode(step);
      frame.error = step.explanation.text;
      frame.errorExplanation = step.explanation;
    } else {
      const frame = stack[stack.length - 1] ?? syntheticNode(step);
      frame.events.push(step.message);
    }
  }

  return { tree };
}
