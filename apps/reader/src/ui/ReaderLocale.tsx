import { I18nProvider } from "react-aria-components";
import type { ReactNode } from "react";

export function ReaderLocale({ children }: { children: ReactNode }) {
  return <I18nProvider locale="zh-CN">{children}</I18nProvider>;
}
