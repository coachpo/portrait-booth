import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <section aria-label="Home">
      <h1>Portrait Booth</h1>
      <p>
        Take or upload a photo in your browser, crop it to the issuing authority's template
        requirements, and check the output against the template. Photos stay on your device by
        default; they are only uploaded when you explicitly choose to stage.
      </p>

      <div className="home-actions">
        <article>
          <h2>Create a photo</h2>
          <p className="muted">
            Choose a template → take or upload → confirm → edit → final checks and export.
          </p>
          <Link className="primary-link" to="/create">
            Start creating
          </Link>
        </article>
        <article>
          <h2>Retrieve a photo</h2>
          <p className="muted">
            Retrieve a previously staged photo with your 6-character code, or delete it immediately
            with the delete secret.
          </p>
          <Link className="primary-link" to="/retrieve">
            Enter retrieval code
          </Link>
        </article>
      </div>

      <p className="muted">
        Pose, exposure, and sharpness checks are heuristic judgments, not calibrated to official
        tolerances, and do not guarantee acceptance by the issuing authority. Follow the official
        sources cited in each template; see the <Link to="/privacy">privacy & retention</Link> page.
      </p>
    </section>
  );
}
