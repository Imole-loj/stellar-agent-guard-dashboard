/**
 * The policy diff must read without colour (issue #535).
 *
 * Two halves, because the behaviour spans two files:
 *
 * 1. the rendered rows, asserted through React in jsdom — every row says
 *    "added" / "removed" / "changed" in words, the glyph stays `aria-hidden` so
 *    it is a second cue rather than a duplicate announcement, and the table has
 *    the header scoping that makes those words travel with the row in a screen
 *    reader; and
 * 2. the stylesheet, asserted by measurement. jsdom performs no layout, so
 *    `getComputedStyle` cannot answer "is this readable" — but the WCAG ratio of
 *    the token the rule resolves to against the surface it sits on can be
 *    computed from `app/globals.css` alone, which is what makes a future
 *    `#1a7f37` (3.57:1 on this panel, the value this component shipped with)
 *    fail the build instead of the operator.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, before, afterEach } from "node:test";
import type { ReactElement } from "react";
import type { PolicyConfig } from "stellar-agent-guard-sdk";
import { installDom, loadReact, type Act } from "./domHarness.ts";
import { PolicyDiffModal } from "../../components/PolicyDiffModal.tsx";
import { computePolicyDiff, type PolicyDiff } from "../../lib/guard/policyDiff.ts";

installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    per_tx_cap: 1_000_000n,
    window_secs: 86_400n,
    window_cap: 5_000_000n,
    assets: [],
    protocols: [],
    recipients: [],
    allow_any_recipient: true,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 3_600n,
    ...overrides,
  };
}

const ADDED: PolicyDiff = {
  entries: [
    { field: "per_tx_cap", oldValue: undefined, newValue: 5_000n, status: "added" },
    { field: "assets", oldValue: undefined, newValue: [], status: "added" },
  ],
  warnings: [],
};

const REMOVED: PolicyDiff = {
  entries: [{ field: "recipients", oldValue: "GABC", newValue: undefined, status: "removed" }],
  warnings: [],
};

const CHANGED: PolicyDiff = {
  entries: [{ field: "paused", oldValue: false, newValue: true, status: "modified" }],
  warnings: [],
};

const ALL_UNCHANGED: PolicyDiff = {
  entries: [{ field: "per_tx_cap", oldValue: 1n, newValue: 1n, status: "unchanged" }],
  warnings: [],
};

/** Render the modal and hand back its dialog element. */
async function render(diff: PolicyDiff): Promise<{
  dialog: HTMLElement;
  unmount: () => Promise<void>;
  confirmations: () => number;
}> {
  let confirmations = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const element = react.createElement(
    PolicyDiffModal as unknown as (p: {
      diff: PolicyDiff;
      onConfirm: () => void;
      onCancel: () => void;
    }) => ReactElement,
    {
      diff,
      onConfirm: () => {
        confirmations += 1;
      },
      onCancel: () => {},
    },
  );
  await act(async () => {
    root.render(element);
  });
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "the modal must render a dialog");
  return {
    dialog: dialog as HTMLElement,
    confirmations: () => confirmations,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function rows(dialog: HTMLElement): HTMLTableRowElement[] {
  return Array.from(dialog.querySelectorAll<HTMLTableRowElement>("tbody tr"));
}

/** The words a screen reader speaks for a row, in the order it speaks them. */
function rowText(row: HTMLTableRowElement): string {
  return (row.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ─ 1. Every status is a word, not only a colour ─────────────────────────────

test("an added row states 'added' in text next to its glyph", async () => {
  const rendered = await render(ADDED);
  try {
    const row = rows(rendered.dialog)[0]!;
    assert.equal(row.dataset.status, "added");
    assert.match(rowText(row), /\badded\b/);
    assert.equal(row.querySelector(".diff-glyph")?.textContent, "+");
  } finally {
    await rendered.unmount();
  }
});

test("a removed row states 'removed' and a changed row states 'changed'", async () => {
  const removed = await render(REMOVED);
  try {
    assert.match(rowText(rows(removed.dialog)[0]!), /\bremoved\b/);
  } finally {
    await removed.unmount();
  }

  const changed = await render(CHANGED);
  try {
    const text = rowText(rows(changed.dialog)[0]!);
    // "modified" is the data-model word; the operator-facing one is "changed".
    assert.match(text, /\bchanged\b/);
    assert.equal(text.includes("modified"), false, "the diff vocabulary must not leak");
  } finally {
    await changed.unmount();
  }
});

test("the glyph stays decoration: hidden from the accessibility tree, never alone", async () => {
  const rendered = await render(ADDED);
  try {
    for (const row of rows(rendered.dialog)) {
      const glyph = row.querySelector(".diff-glyph");
      assert.ok(glyph, "each row keeps its visual marker");
      assert.equal(
        glyph!.getAttribute("aria-hidden"),
        "true",
        "the glyph must not be announced alongside the word",
      );
    }
  } finally {
    await rendered.unmount();
  }
});

test("the status word rides with the field: the cell is a row header", async () => {
  const rendered = await render(CHANGED);
  try {
    const row = rows(rendered.dialog)[0]!;
    const head = row.querySelector('th[scope="row"]');
    assert.ok(head, "the field cell must be a scoped row header, not a bare <td>");
    assert.match(head!.textContent ?? "", /paused/);
    assert.match(head!.textContent ?? "", /changed/);
    const columns = Array.from(
      rendered.dialog.querySelectorAll<HTMLTableCellElement>('thead th[scope="col"]'),
    ).map((cell) => cell.textContent?.trim());
    assert.deepEqual(columns, ["Field", "Current", "New"]);
    assert.ok(
      rendered.dialog.querySelector("caption"),
      "the table needs a caption so the header cells have context",
    );
  } finally {
    await rendered.unmount();
  }
});

test("a summary sentence states the shape of the diff in words", async () => {
  const rendered = await render(ADDED);
  try {
    const summary = rendered.dialog.querySelector(".diff-summary");
    // Two added fields, one of them an empty array: the count is the row count.
    assert.equal(summary?.textContent?.trim(), "2 changes: 2 added.");
  } finally {
    await rendered.unmount();
  }
});

test("a one-row diff reads as one change, not one changes", async () => {
  const rendered = await render(CHANGED);
  try {
    assert.equal(
      rendered.dialog.querySelector(".diff-summary")?.textContent?.trim(),
      "1 change: 1 changed.",
    );
  } finally {
    await rendered.unmount();
  }
});

// ─ 2. Values, warnings and the empty diff are prose too ─────────────────────

test("values are rendered as words a reader can say aloud", async () => {
  const rendered = await render(ADDED);
  try {
    const [, current, next] = Array.from(rows(rendered.dialog)[1]!.cells).map(
      (cell) => cell.textContent,
    );
    // An empty allowlist is "none", not a blank cell that reads as a missing row.
    assert.equal(current, "—");
    assert.equal(next, "none");
  } finally {
    await rendered.unmount();
  }

  const boolean = await render(CHANGED);
  try {
    const cells = Array.from(rows(boolean.dialog)[0]!.cells).map((cell) => cell.textContent);
    assert.deepEqual(cells.slice(1), ["no", "yes"]);
  } finally {
    await boolean.unmount();
  }
});

test("a warning carries the word 'Warning' and hides its glyph", async () => {
  const warned: PolicyDiff = {
    entries: [{ field: "window_cap", oldValue: 5n, newValue: 1n, status: "modified" }],
    warnings: ["New policy lowers the rolling-window cap."],
  };
  const rendered = await render(warned);
  try {
    const notice = rendered.dialog.querySelector(".notice");
    assert.ok(notice, "the warning must reuse the shared notice tier");
    assert.match(notice!.textContent ?? "", /Warning/);
    assert.match(notice!.textContent ?? "", /lowers the rolling-window cap/);
    assert.equal(notice!.querySelector("span[aria-hidden]")?.textContent?.trim(), "⚠");
    // The badge used to paint its own `#fff8c5` panel behind `--text`; the tier
    // owns the surface now, so the component must not override it.
    assert.equal(
      /background/.test(notice!.getAttribute("style") ?? ""),
      false,
      "an inline background here reintroduces the unreadable badge",
    );
  } finally {
    await rendered.unmount();
  }
});

test("an identical policy says so and shows no table", async () => {
  const rendered = await render(ALL_UNCHANGED);
  try {
    assert.equal(rows(rendered.dialog).length, 0, "unchanged rows must not be listed");
    assert.match(rendered.dialog.textContent ?? "", /identical to the one currently installed/);
    assert.equal(rendered.dialog.querySelector("table"), null);
    assert.equal(rendered.dialog.querySelector(".diff-summary"), null);
  } finally {
    await rendered.unmount();
  }
});

test("unchanged fields drop out of both the rows and the count", async () => {
  const mixed: PolicyDiff = {
    entries: [
      ...ALL_UNCHANGED.entries,
      ...CHANGED.entries,
      { field: "per_tx_cap", oldValue: 2n, newValue: 2n, status: "unchanged" },
    ],
    warnings: [],
  };
  const rendered = await render(mixed);
  try {
    const listed = rows(rendered.dialog);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.dataset.status, "modified");
    assert.equal(
      rendered.dialog.querySelector(".diff-summary")?.textContent?.trim(),
      "1 change: 1 changed.",
    );
  } finally {
    await rendered.unmount();
  }
});

test("the diff the calculator produces is the diff that reads in words", async () => {
  // End to end on purpose: a label asserted only against a hand-built fixture
  // would keep passing if `computePolicyDiff` started emitting a status the
  // modal has no word for.
  const computed = computePolicyDiff(policy(), policy({ per_tx_cap: 2_000_000n, paused: true }));
  const rendered = await render(computed);
  try {
    const text = rows(rendered.dialog).map(rowText).join("\n");
    assert.match(text, /per_tx_cap \(changed\)/);
    assert.match(text, /paused \(changed\)/);
    // Everything the operator is *not* changing is absent, so the rows that
    // remain are exactly what the summary counts.
    assert.equal(text.includes("window_cap"), false);
    assert.equal(
      rendered.dialog.querySelector(".diff-summary")?.textContent?.trim(),
      "2 changes: 2 changed.",
    );
  } finally {
    await rendered.unmount();
  }
});

test("confirming still requires the operator, and cancelling never signs", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let confirmations = 0;
  let cancellations = 0;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      react.createElement(PolicyDiffModal, {
        diff: ADDED,
        onConfirm: () => {
          confirmations += 1;
        },
        onCancel: () => {
          cancellations += 1;
        },
      }),
    );
  });
  try {
    const [confirm, cancel] = Array.from(container.querySelectorAll("button"));
    await act(async () => {
      confirm!.click();
    });
    assert.equal(confirmations, 1);
    await act(async () => {
      cancel!.click();
    });
    assert.equal(cancellations, 1);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// ─ 3. The palette is the accessible one, measured ───────────────────────────

const css = readFileSync("app/globals.css", "utf8");

/** `:root` custom properties, the only palette the interface may use. */
const TOKENS: Record<string, string> = (() => {
  const block = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens[match[1]!] = match[2]!.trim();
  }
  return tokens;
})();

/** Resolve a declaration value (`var(--ok)`, `#37d67a`) to a hex colour. */
function hex(value: string, depth = 0): string {
  if (depth > 4) throw new Error(`token indirection too deep: ${value}`);
  const variable = /var\((--[\w-]+)\)/.exec(value);
  if (variable) {
    const resolved = TOKENS[variable[1]!];
    assert.ok(resolved, `globals.css must define ${variable[1]} for "${value}" to resolve`);
    return hex(resolved, depth + 1);
  }
  const literal = /(#[0-9a-fA-F]{6})\b/.exec(value);
  assert.ok(literal, `"${value}" is not a resolvable colour`);
  return literal[1]!.toLowerCase();
}

/** The first rule whose selector matches, as a declaration block. */
function declarations(selector: RegExp): string {
  const start = css.search(selector);
  assert.ok(start >= 0, `globals.css must contain a rule for ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function textColor(selector: RegExp): string {
  const value = declarations(selector);
  assert.match(value, /(^|;)\s*color:/, `${selector} must set a colour`);
  return hex(/(?:^|;)\s*color:\s*([^;]+)/.exec(value)![1]!.trim());
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const unit = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  const [red, green, blue] = channels as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2.1 contrast ratio, the same formula axe would use with a real layout. */
function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

const PANEL = hex(TOKENS["--panel"]!);

test("every diff status colour clears WCAG AA on the surface it is painted on", () => {
  // 13px bold text is still small text: the AA floor is 4.5:1, not 3:1. The
  // glyphs this replaced measured 3.57 / 3.39 / 3.72 / 2.84 against this panel.
  for (const status of ["added", "removed", "modified", "unchanged"] as const) {
    const color = textColor(new RegExp(`\\.diff-${status} \\.diff-glyph\\s*\\{`));
    const ratio = contrast(color, PANEL);
    assert.ok(
      ratio >= 4.5,
      `.diff-${status} glyph colour ${color} reads ${ratio}:1 on ${PANEL}; needs 4.5:1`,
    );
  }
  assert.equal(contrast(textColor(/\.diff-status\s*\{/), PANEL) >= 4.5, true);
  assert.equal(contrast(textColor(/\.diff-table th\[scope="row"\]\s*\{/), PANEL) >= 4.5, true);
  assert.equal(contrast(textColor(/\.diff-table td\s*\{/), PANEL) >= 4.5, true);
  assert.equal(contrast(textColor(/\.diff-table th\[scope="col"\]\s*\{/), PANEL) >= 4.5, true);
});

test("status colours come from the shared tiers, not a local palette", () => {
  assert.equal(textColor(/\.diff-added \.diff-glyph\s*\{/), hex("var(--ok)"));
  assert.equal(textColor(/\.diff-removed \.diff-glyph\s*\{/), hex("var(--danger)"));
  assert.equal(textColor(/\.diff-modified \.diff-glyph\s*\{/), hex("var(--warn)"));
  assert.equal(textColor(/\.diff-unchanged \.diff-glyph\s*\{/), hex("var(--muted)"));
  // The row marker is the second non-text cue and must agree with the glyph:
  // a row whose bar and sign disagree tells the operator nothing.
  for (const status of ["added", "removed", "modified", "unchanged"] as const) {
    const marker = declarations(new RegExp(`\\.diff-${status} th\\[scope="row"\\]\\s*\\{`));
    assert.match(marker, /box-shadow: inset 3px 0 0 /, `a ${status} row needs its inset marker`);
    assert.equal(
      hex(/box-shadow:[^;]+/.exec(marker)![0]),
      textColor(new RegExp(`\\.diff-${status} \\.diff-glyph\\s*\\{`)),
      `the ${status} marker and glyph must be the same colour`,
    );
  }
});

test("the warning notice is legible, which the pale badge was not", () => {
  // `.notice` deliberately sets no `color`, so it inherits `--text` from `body`.
  const notice = declarations(/\.notice\s*\{/);
  assert.equal(/(^|;)\s*color:/.test(notice), false, "the tier inherits the page text colour");
  const surface = hex(/background:\s*([^;]+)/.exec(notice)![1]!.trim());
  const ratio = contrast(hex(TOKENS["--text"]!), surface);
  // The badge this replaced put the same text colour on `#fff8c5`: 1.11:1.
  assert.ok(ratio >= 4.5, `warning text reads ${ratio}:1 on its ${surface} panel; needs 4.5:1`);
});

test("forced-contrast mode promotes the word over the colour", () => {
  const block = declarations(/@media \(prefers-contrast: more\)\s*\{\s*\.diff-status\s*\{/);
  assert.match(block, /font-weight:\s*700/, "the status word must become emphatic");
  assert.equal(
    hex(/color:\s*([^;]+)/.exec(block)![1]!.trim()),
    hex("var(--text)"),
    "the label moves to full-contrast text",
  );
});

test("the component carries no palette, so contrast cannot drift silently", () => {
  const source = readFileSync("components/PolicyDiffModal.tsx", "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "");
  const stray = /#[0-9a-fA-F]{3,8}\b/.exec(code);
  assert.equal(stray, null, `hardcoded colour "${stray?.[0]}" belongs in globals.css as a token`);
  assert.equal(/\bstyle=\{\{[^}]*\b(color|background)/.test(code), false);
});
