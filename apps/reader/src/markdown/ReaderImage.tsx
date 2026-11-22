import { useState } from "react";
import type { ComponentProps } from "react";
import styles from "./ReaderSurface.module.css";

export function ReaderImage({
  src,
  alt,
  ...props
}: ComponentProps<"img"> & { src: string; alt?: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const label = alt?.trim() || "图片无法加载";
  if (failed) {
    return <span className={styles.imageFallback}>{label}</span>;
  }
  return (
    <img
      {...props}
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      onError={(event) => {
        props.onError?.(event);
        setFailed(true);
      }}
    />
  );
}
