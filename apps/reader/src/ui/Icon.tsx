import {
  AlignLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Eye,
  EyeOff,
  FileText,
  Folder,
  History,
  Link,
  Paperclip,
  Plus,
  PanelRight,
  PanelRightClose,
  Search,
  Settings,
  Sparkles,
  X,
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
  eye: Eye,
  "eye-off": EyeOff,
  "file-text": FileText,
  folder: Folder,
  history: History,
  link: Link,
  plus: Plus,
  paperclip: Paperclip,
  "panel-right": PanelRight,
  "panel-right-close": PanelRightClose,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  x: X,
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
