/**
 * Editor policy list (P2): render template restrictions as a visible list.
 * Read-only display, no role="alert" (to avoid mixing with the existing
 * resolution/out-of-bounds warnings).
 */

import type { EditorPolicy } from "../lib/templates/policy";

export function PolicyNotices({ policy }: { policy: EditorPolicy }) {
  if (policy.notices.length === 0) return null;
  return (
    <div className="policy-notices">
      <h3>Template restrictions</h3>
      <ul>
        {policy.notices.map((n) => (
          <li key={n.id}>
            <strong>{n.level === "forbidden" ? "Forbidden" : "Warning"}: </strong>
            {n.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
