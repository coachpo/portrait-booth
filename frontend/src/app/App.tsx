import { Routes, Route } from "react-router-dom";

import { CreatePage } from "../create/create-page";
import { HomePage } from "../pages/home-page";
import { NotFoundPage } from "../pages/not-found-page";
import { PrivacyPage } from "../pages/privacy-page";
import { RetrievePage } from "../pages/retrieve-page";
import { Layout } from "./layout";

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/create" element={<CreatePage />} />
        <Route path="/retrieve" element={<RetrievePage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        {/* 兜底路由：没有它时未匹配地址渲染成一块空白页 */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}
