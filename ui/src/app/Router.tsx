import { createBrowserRouter, RouterProvider } from "react-router";

import { StepLayout } from "@/components/layout/StepLayout";

const router = createBrowserRouter([
  {
    path: "/",
    element: <StepLayout />,
  },
  {
    path: "*",
    element: <StepLayout />,
  },
]);

export function Router() {
  return <RouterProvider router={router} />;
}
