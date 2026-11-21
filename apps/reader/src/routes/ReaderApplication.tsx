import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ReaderLocale } from "../ui/ReaderLocale";
import { router } from "./router";
import "../styles/tokens.css";
import "../ui/theme.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      retry: false,
    },
  },
});

export function ReaderApplication() {
  return (
    <QueryClientProvider client={queryClient}>
      <ReaderLocale>
        <RouterProvider router={router} />
      </ReaderLocale>
    </QueryClientProvider>
  );
}
