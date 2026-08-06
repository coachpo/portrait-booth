import { Link, useLocation } from "react-router-dom";

/** 未匹配路由的兜底。没有它时这些地址渲染成一块空白页。 */
export function NotFoundPage() {
  const location = useLocation();
  return (
    <section aria-label="页面不存在">
      <h1>页面不存在</h1>
      <p className="muted">找不到 {location.pathname} 对应的页面。</p>
      <div className="step-actions">
        <Link to="/">回到首页</Link>
        <Link to="/create">创建照片</Link>
        <Link to="/retrieve">取回照片</Link>
      </div>
    </section>
  );
}
