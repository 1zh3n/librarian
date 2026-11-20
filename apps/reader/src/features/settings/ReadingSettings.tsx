import { useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  Form,
  Heading,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Popover,
  Select,
  SelectValue,
  TextField,
} from "../../ui/primitives";
import type { DevicePreferences } from "../../api/client";
import styles from "./ReadingSettings.module.css";

const themes = [
  { id: "system", name: "跟随系统" },
  { id: "light", name: "浅色" },
  { id: "dark", name: "深色" },
];
const fonts = [
  { id: "serif", name: "衬线" },
  { id: "sans", name: "无衬线" },
];

export function ReadingSettings({
  preferences,
  save,
  close,
}: {
  preferences: DevicePreferences;
  save: (changes: Partial<DevicePreferences>) => Promise<DevicePreferences>;
  close: () => void;
}) {
  const [theme, setTheme] = useState(preferences.theme);
  const [font, setFont] = useState(preferences.font);
  const [eink, setEink] = useState(preferences.eink);
  const [reduceMotion, setReduceMotion] = useState(preferences.reduceMotion);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  return (
    <ModalOverlay
      isOpen
      isDismissable={!saving}
      isKeyboardDismissDisabled={saving}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      className={styles.overlay}
    >
      <Modal className={styles.modal}>
        <Dialog className={styles.dialog}>
          <Heading slot="title">阅读设置</Heading>
          <Form
            className={styles.fields}
            validationBehavior="native"
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              const number = (name: string) => Number(fields.get(name));
              const key = fields.get("focusKey");
              setSaving(true);
              setError(false);
              void save({
                theme,
                font,
                eink,
                reduceMotion,
                fontSize: number("fontSize"),
                lineHeight: number("lineHeight"),
                measure: number("measure"),
                sidebarWidth: number("sidebarWidth"),
                toolsWidth: number("toolsWidth"),
                focusKey: typeof key === "string" ? key.toLowerCase().trim() : preferences.focusKey,
              })
                .then(close, () => setError(true))
                .finally(() => setSaving(false));
            }}
          >
            <Select
              value={theme}
              onChange={(value) => {
                const next = themes.find((item) => item.id === value)?.id;
                if (next === "system" || next === "light" || next === "dark") setTheme(next);
              }}
              className={styles.field}
            >
              <Label>主题</Label>
              <Button className={styles.input}>
                <SelectValue />
              </Button>
              <Popover className={styles.options}>
                <ListBox items={themes}>
                  {(item) => (
                    <ListBoxItem className={styles.option} id={item.id}>
                      {item.name}
                    </ListBoxItem>
                  )}
                </ListBox>
              </Popover>
            </Select>
            <Select
              value={font}
              onChange={(value) => {
                if (value === "serif" || value === "sans") setFont(value);
              }}
              className={styles.field}
            >
              <Label>字体</Label>
              <Button className={styles.input}>
                <SelectValue />
              </Button>
              <Popover className={styles.options}>
                <ListBox items={fonts}>
                  {(item) => (
                    <ListBoxItem className={styles.option} id={item.id}>
                      {item.name}
                    </ListBoxItem>
                  )}
                </ListBox>
              </Popover>
            </Select>
            <TextField
              className={styles.field}
              name="fontSize"
              type="number"
              isRequired
              defaultValue={String(preferences.fontSize)}
            >
              <Label>字号</Label>
              <Input className={styles.input} min={16} max={28} step={1} />
            </TextField>
            <TextField
              className={styles.field}
              name="lineHeight"
              type="number"
              isRequired
              defaultValue={String(preferences.lineHeight)}
            >
              <Label>行高</Label>
              <Input className={styles.input} min={1.4} max={2.4} step={0.01} />
            </TextField>
            <TextField
              className={styles.field}
              name="measure"
              type="number"
              isRequired
              defaultValue={String(preferences.measure)}
            >
              <Label>每行汉字数</Label>
              <Input className={styles.input} min={28} max={56} step={1} />
            </TextField>
            <TextField className={styles.field} name="focusKey" defaultValue={preferences.focusKey}>
              <Label>专注快捷键</Label>
              <Input
                className={styles.input}
                maxLength={1}
                pattern="[A-Za-z]?"
                placeholder="留空关闭"
              />
            </TextField>
            <TextField
              className={styles.field}
              name="sidebarWidth"
              type="number"
              isRequired
              defaultValue={String(preferences.sidebarWidth)}
            >
              <Label>空间目录宽度</Label>
              <Input className={styles.input} min={176} max={360} step={1} />
            </TextField>
            <TextField
              className={styles.field}
              name="toolsWidth"
              type="number"
              isRequired
              defaultValue={String(preferences.toolsWidth)}
            >
              <Label>文档工具宽度</Label>
              <Input className={styles.input} min={200} max={480} step={1} />
            </TextField>
            <Checkbox className={styles.checkbox} isSelected={eink} onChange={setEink}>
              <span className={styles.mark} aria-hidden="true" /> 墨水屏
            </Checkbox>
            <Checkbox
              className={styles.checkbox}
              isSelected={reduceMotion}
              onChange={setReduceMotion}
            >
              <span className={styles.mark} aria-hidden="true" /> 减少动画
            </Checkbox>
            {error && (
              <p className={styles.error} role="alert">
                无法保存设置，请重试。
              </p>
            )}
            <div className={styles.actions}>
              <Button className={styles.button} isDisabled={saving} onPress={close}>
                取消
              </Button>
              <Button type="submit" className={styles.button} isDisabled={saving}>
                保存设置
              </Button>
            </div>
          </Form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
