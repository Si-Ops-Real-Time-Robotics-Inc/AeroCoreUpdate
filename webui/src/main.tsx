import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ApiError } from "./lib/api";
import { router } from "./router";
import "./theme.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 means the token is gone; retrying with the same one cannot help.
      // Branching on the typed status rather than on message text, because the
      // message is prose and gets reworded.
      retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status === 401),
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
