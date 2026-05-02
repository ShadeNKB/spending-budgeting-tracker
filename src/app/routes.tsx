import { createBrowserRouter, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";
import { AppShell } from "./AppShell";
import { PulseScreen } from "../features/pulse/PulseScreen";

const LedgerScreen = lazy(() =>
  import("../features/ledger/LedgerScreen").then((m) => ({ default: m.LedgerScreen }))
);
const InsightsScreen = lazy(() =>
  import("../features/insights/InsightsScreen").then((m) => ({ default: m.InsightsScreen }))
);

function LazyScreen({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      // Render PulseScreen directly at "/" — avoids Navigate redirect that causes
      // AnimatePresence mode="wait" to show a blank frame on first cold visit.
      { index: true, element: <PulseScreen /> },
      { path: "pulse", element: <PulseScreen /> },
      { path: "ledger", element: <LazyScreen><LedgerScreen /></LazyScreen> },
      { path: "insights", element: <LazyScreen><InsightsScreen /></LazyScreen> },
      { path: "*", element: <Navigate to="/pulse" replace /> },
    ],
  },
]);
