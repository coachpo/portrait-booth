import { Routes, Route, Link } from "react-router-dom";

import { CreatePage } from "../create/create-page";
import { RetrievePage } from "../pages/retrieve-page";

export function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <main className="container">
            <h1>Portrait Booth</h1>
            <nav>
              <Link to="/create">创建照片</Link>
              <Link to="/retrieve">取回照片</Link>
            </nav>
          </main>
        }
      />
      <Route path="/create" element={<CreatePage />} />
      <Route path="/retrieve" element={<RetrievePage />} />
    </Routes>
  );
}
