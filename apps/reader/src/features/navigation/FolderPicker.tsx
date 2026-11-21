import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { Select } from "../../ui/Forms";
import styles from "../document/CreateDocumentDialog.module.css";
import { CreateFolderForm } from "./CreateFolderForm";
import { foldersQuery } from "./fileActions";

export function FolderPicker({
  workspace,
  value,
  onChange,
  disabled = false,
  creating,
  onCreatingChange,
}: {
  workspace: string;
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
  creating?: boolean;
  onCreatingChange?: (open: boolean) => void;
}) {
  const folders = useQuery({ ...foldersQuery(workspace), enabled: Boolean(workspace) });
  const button = useRef<HTMLButtonElement>(null);
  const [localCreating, setLocalCreating] = useState(false);
  const adding = creating ?? localCreating;
  function setAdding(open: boolean) {
    setLocalCreating(open);
    onCreatingChange?.(open);
  }
  const entries = (folders.data?.folders ?? []).map((path) => ({ value: path, label: path }));
  return (
    <>
      <Select
        label="目标目录"
        searchLabel="搜索目录"
        value={value || "/"}
        disabled={disabled || adding || !folders.isSuccess}
        entries={[{ value: "/", label: "根目录" }, ...entries]}
        onChange={(next) => onChange(next === "/" ? "" : next)}
      />
      {folders.isError && (
        <Feedback tone="error" className={styles.error}>
          无法加载目录。<Button onPress={() => void folders.refetch()}>重试</Button>
        </Feedback>
      )}
      {adding ? (
        <CreateFolderForm
          workspace={workspace}
          parent={value}
          close={() => {
            setAdding(false);
            requestAnimationFrame(() => button.current?.focus());
          }}
          created={(path) => {
            onChange(path);
            setAdding(false);
            requestAnimationFrame(() => button.current?.focus());
          }}
        />
      ) : (
        <Button
          ref={button}
          className={styles.newFolder}
          isDisabled={disabled || !folders.isSuccess}
          onPress={() => setAdding(true)}
        >
          新建文件夹
        </Button>
      )}
    </>
  );
}
