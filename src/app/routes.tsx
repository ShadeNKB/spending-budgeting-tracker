import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "./AppShell";
import { PulseScreen } from "../features/pulse/PulseScreen";
import { LedgerScreen } from "../features/ledger/LedgerScreen";
import { InsightsScreen } from "../features/insights/InsightsScreen";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/pulse" replace /> },
      { path: "pulse", element: <PulseScreen /> },
      { path: "ledger", element: <LedgerScreen /> },
      { path: "insights", element: <InsightsScreen /> },
      { path: "*", element: <Navigate to="/pulse" replace /> },
    ],
  },
]);
