/**
 * App shell: header navigation, main content area, and footer.
 * Every page must have a way back home - dead-end inner pages are the most
 * easily overlooked usability defect.
 */

import { Link, NavLink, Outlet } from "react-router-dom";

import { ErrorBoundary } from "./error-boundary";

const NAV = [
  { to: "/create", label: "Create photo" },
  { to: "/retrieve", label: "Retrieve photo" },
  { to: "/privacy", label: "Privacy" },
];

export function Layout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          Portrait Booth
        </Link>
        <nav aria-label="Main navigation">
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
          Photo checks are heuristic judgments, not calibrated to official tolerances, and do not
          guarantee acceptance by the issuing authority. Template content follows each issuing
          authority's official guidance.
        </p>
        <p className="muted">
          <Link to="/privacy">Privacy & retention</Link>
        </p>
      </footer>
    </div>
  );
}
