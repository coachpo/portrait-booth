import { Link, useLocation } from "react-router-dom";

/** Fallback for unmatched routes. Without it these addresses render a blank page. */
export function NotFoundPage() {
  const location = useLocation();
  return (
    <section aria-label="Page not found">
      <h1>Page not found</h1>
      <p className="muted">No page found for {location.pathname}.</p>
      <div className="step-actions">
        <Link to="/">Back to home</Link>
        <Link to="/create">Create photo</Link>
        <Link to="/retrieve">Retrieve photo</Link>
      </div>
    </section>
  );
}
