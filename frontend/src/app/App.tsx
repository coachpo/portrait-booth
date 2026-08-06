import type { RouteObject } from "react-router-dom";

import { CreatePage } from "../create/create-page";
import { HomePage } from "../pages/home-page";
import { NotFoundPage } from "../pages/not-found-page";
import { PrivacyPage } from "../pages/privacy-page";
import { RetrievePage } from "../pages/retrieve-page";
import { Layout } from "./layout";

/**
 * 路由表（数据路由形态）：main.tsx 与测试共用同一份定义。
 * 数据路由是 useBlocker 的前置条件——声明式 <BrowserRouter> 下直接调用会抛错。
 */
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/create", element: <CreatePage /> },
      { path: "/retrieve", element: <RetrievePage /> },
      { path: "/privacy", element: <PrivacyPage /> },
      // 兜底路由：没有它时未匹配地址渲染成一块空白页
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
