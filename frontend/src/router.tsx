import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";

import { CenteredSpinner } from "@/components/common";
import { AppLayout } from "@/components/layout";
import { AuditPage } from "@/pages/audit";
import { CustomRulesPage } from "@/pages/customrules";
import { InstancesPage } from "@/pages/instances";
import { PoliciesPage } from "@/pages/policies";
import { SearchPage } from "@/pages/search";
import { SyncPage } from "@/pages/sync";
import { UrlsPage } from "@/pages/urls";

// 数据校验页含 ECharts，体积较大，懒加载以保持主包精简
const ValidationPage = lazy(() =>
  import("@/pages/validation").then((m) => ({ default: m.ValidationPage }))
);

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/customrules" replace /> },
      { path: "customrules", element: <CustomRulesPage /> },
      { path: "urls", element: <UrlsPage /> },
      { path: "policies", element: <PoliciesPage /> },
      {
        path: "validation",
        element: (
          <Suspense fallback={<CenteredSpinner label="加载可视化…" />}>
            <ValidationPage />
          </Suspense>
        ),
      },
      { path: "sync", element: <SyncPage /> },
      { path: "search", element: <SearchPage /> },
      { path: "audit", element: <AuditPage /> },
      { path: "instances", element: <InstancesPage /> },
    ],
  },
]);
