import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <section aria-label="首页">
      <h1>Portrait Booth</h1>
      <p>
        按签发机关的模板要求，在浏览器内拍摄或上传照片、裁剪成规定尺寸，并检查输出是否符合模板。
        照片默认不离开你的设备；只有你明确选择暂存时才会上传。
      </p>

      <div className="home-actions">
        <article>
          <h2>创建照片</h2>
          <p className="muted">选择模板 → 拍摄或上传 → 确认 → 编辑 → 终态检查与导出。</p>
          <Link className="primary-link" to="/create">
            开始创建
          </Link>
        </article>
        <article>
          <h2>取回照片</h2>
          <p className="muted">用 6 位取回码取回此前暂存的照片，或用删除密钥立即删除。</p>
          <Link className="primary-link" to="/retrieve">
            输入取回码
          </Link>
        </article>
      </div>

      <p className="muted">
        姿态、曝光与清晰度检查为启发式判断，未经官方容差校准，不代表签发机关一定受理。
        具体要求请以模板中标注的官方来源为准，详见
        <Link to="/privacy">隐私与留存说明</Link>。
      </p>
    </section>
  );
}
