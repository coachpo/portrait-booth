import type { RouteObject } from "react-router-dom";

import { CreatePage } from "../create/create-page";
import { HomePage } from "../pages/home-page";
import { NotFoundPage } from "../pages/not-found-page";
import { PrivacyPage } from "../pages/privacy-page";
import { RetrievePage } from "../pages/retrieve-page";
import { TemplateDetailPage } from "../pages/template-detail-page";
import { Layout } from "./layout";

/**
 * Route table (data-router form): shared between main.tsx and tests.
 * Data routers are a prerequisite of useBlocker - calling it under the
 * declarative <BrowserRouter> throws.
 */
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/create", element: <CreatePage /> },
      { path: "/retrieve", element: <RetrievePage /> },
      { path: "/privacy", element: <PrivacyPage /> },
      { path: "/templates/:revisionId", element: <TemplateDetailPage /> },
      // Fallback route: without it, unmatched addresses render a blank page
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
