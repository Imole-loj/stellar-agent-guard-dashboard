"use client";

import type { RecoveryGuidance } from "../lib/guard/recoveryGuidance.ts";

/**
 * The recovery line under a recognised failure (issue #385).
 *
 * Unknown failures render nothing: the original error is still shown by the
 * surrounding ErrorBlock/toast, and inventing guidance for a failure the
 * dashboard does not understand is exactly what this component must avoid.
 */
export function RecoveryGuidanceBlock({ guidance }: { guidance: RecoveryGuidance }) {
  if (!guidance.recognized) return null;
  return (
    <div
      className="recovery-guidance"
      data-category={guidance.category}
      data-retry={guidance.retry}
    >
      <span className="tiny">{guidance.explanation}</span>
      <span className="tiny">
        <strong>Retry: </strong>
        {guidance.retryLabel}
      </span>
      {guidance.link && (
        <a
          className="tiny"
          href={guidance.link.href}
          target="_blank"
          rel="noreferrer"
          title={guidance.link.href}
        >
          {guidance.link.label} ↗
        </a>
      )}
    </div>
  );
}
