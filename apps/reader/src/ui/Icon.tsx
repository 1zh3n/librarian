import {
  AlignLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileText,
  History,
  Link,
  PanelRight,
  PanelRightClose,
  Search,
  Settings,
  Sparkles,
} from "lucide-static";
import styles from "./Icon.module.css";

// Only trusted, bundled Lucide SVGs can supply the markup for a Reader icon.
const glyphs = {
  "align-left": AlignLeft,
  "book-open": BookOpen,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  ellipsis: Ellipsis,
  "file-text": FileText,
  history: History,
  link: Link,
  "panel-right": PanelRight,
  "panel-right-close": PanelRightClose,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
} as const;

export function Icon({ name, className }: { name: keyof typeof glyphs; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-icon={name}
      className={className ? `${styles.icon} ${className}` : styles.icon}
      dangerouslySetInnerHTML={{ __html: glyphs[name] }}
    />
  );
}
