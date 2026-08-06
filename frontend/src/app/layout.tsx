/**
 * 应用外壳：页头导航、主内容区与页脚。
 * 每个页面都必须有回到首页的出口——内页走进死胡同是最容易被忽略的可用性缺陷。
 */

import { Link, NavLink, Outlet } from "react-router-dom";

import { ErrorBoundary } from "./error-boundary";

const NAV = [
  { to: "/create", label: "创建照片" },
  { to: "/retrieve", label: "取回照片" },
  { to: "/privacy", label: "隐私说明" },
];

export function Layout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          Portrait Booth
        </Link>
        <nav aria-label="主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="container">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
      <footer className="app-footer">
        <p className="muted">
          照片检查为启发式判断，未经官方容差校准，不代表签发机关一定受理。
          模板内容以各签发机关的官方说明为准。
        </p>
        <p className="muted">
          <Link to="/privacy">隐私与留存说明</Link>
        </p>
      </footer>
    </div>
  );
}
