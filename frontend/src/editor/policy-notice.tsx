/**
 * 编辑器政策清单（P2）：把模板限制渲染成可见清单。
 * 只读展示、无 role="alert"（避免与既有的分辨率/越界告警混用定位）。
 */

import type { EditorPolicy } from "../lib/templates/policy";

export function PolicyNotices({ policy }: { policy: EditorPolicy }) {
  if (policy.notices.length === 0) return null;
  return (
    <div className="policy-notices">
      <h3>模板限制</h3>
      <ul>
        {policy.notices.map((n) => (
          <li key={n.id}>
            <strong>{n.level === "forbidden" ? "禁止" : "警告"}：</strong>
            {n.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
