import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "../ui/primitives";
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
      <I18nProvider locale="zh-CN">
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>
  );
}
