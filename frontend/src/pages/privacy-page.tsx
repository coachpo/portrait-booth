/**
 * 隐私与留存说明（SPEC §3.1 / §9.2）。
 * 留存时长、取回方式与上传上限全部来自 /api/v1/service-policy——
 * 这些数字由服务端政策决定，页面上不得硬编码。
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  fetchServicePolicy,
  formatMaxUpload,
  formatRetention,
  retrievalModeLabel,
  type ServicePolicy,
} from "../api/service-policy";

export function PrivacyPage() {
  const [policy, setPolicy] = useState<ServicePolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchServicePolicy().then(
      (p) => {
        if (!cancelled) setPolicy(p);
      },
      () => {
        if (!cancelled) setError("暂时无法读取服务政策，请稍后重试。");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <section aria-label="隐私说明">
      <h1>隐私与留存说明</h1>

      <h2>照片在什么时候离开你的设备</h2>
      <p>
        选择模板、拍摄或上传、编辑与终态渲染全部在你的浏览器内完成，照片不会离开设备。
        只有当你在终态页明确点击「暂存并生成取回码」时，成品照片才会上传到服务器。
      </p>

      <h2>服务端政策</h2>
      {error && (
        <div role="alert" className="template-error">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </button>
        </div>
      )}
      {!policy && !error && <p aria-live="polite">正在读取服务政策…</p>}
      {policy && (
        <dl className="final-details">
          <div>
            <dt>暂存留存时长</dt>
            <dd>
              {formatRetention(policy.temporaryStorageTtlSeconds)}（到期自动删除，不提供续期）
            </dd>
          </div>
          <div>
            <dt>取回方式</dt>
            <dd>{retrievalModeLabel(policy.retrievalMode)}</dd>
          </div>
          <div>
            <dt>单张上传上限</dt>
            <dd>{formatMaxUpload(policy.maxUploadBytes)}</dd>
          </div>
          <div>
            <dt>政策版本</dt>
            <dd>{policy.policyVersion}</dd>
          </div>
        </dl>
      )}

      <h2>暂存前你会知道的事</h2>
      <ul>
        <li>上传目的：仅用于凭取回码取回这张照片，不做其他用途。</li>
        <li>留存时长：以上方服务端政策为准；保存成功后的响应里会给出权威到期时间。</li>
        <li>取回码：6 位字符，只在你的浏览器里显示一次，服务端只保存它的指纹。</li>
        <li>删除密钥：与取回码分开，是你主动删除这张照片的唯一凭证。</li>
        <li>取回码遗失后无法找回，也无法通过邮箱或手机号恢复——服务端没有这些信息。</li>
      </ul>

      <h2>不会做的事</h2>
      <ul>
        <li>不要求账号、邮箱或手机号，不建立用户画像。</li>
        <li>不在本地持久化照片、编辑状态或人脸关键点。</li>
        <li>不把照片、取回码或删除密钥写入日志、URL 或缓存。</li>
        <li>不把姿态与曝光检查表述为官方认证——它们是未经校准的启发式判断。</li>
      </ul>

      <div className="step-actions">
        <Link to="/create">开始创建照片</Link>
        <Link to="/retrieve">用取回码取回照片</Link>
      </div>
    </section>
  );
}
