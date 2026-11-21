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
import { Tabs } from "../../ui/Tabs";
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

type SettingsActions = {
  save: (changes: Partial<DevicePreferences>) => Promise<DevicePreferences>;
  close: () => void;
};

export function ReadingSettings({
  preferences,
  loading,
  retry,
  save,
  close,
}: SettingsActions & {
  preferences: DevicePreferences | undefined;
  loading: boolean;
  retry: () => void;
}) {
  const [saving, setSaving] = useState(false);
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
          <Heading slot="title">应用设置</Heading>
          {preferences ? (
            <PreferencesForm
              preferences={preferences}
              saving={saving}
              setSaving={setSaving}
              save={save}
              close={close}
            />
          ) : (
            <div className={styles.fields}>
              {loading ? (
                <output>正在读取设备设置…</output>
              ) : (
                <p className={styles.error} role="alert">
                  无法读取设备设置。
                </p>
              )}
              <div className={styles.actions}>
                <Button className={styles.button} onPress={close}>
                  关闭
                </Button>
                {!loading && (
                  <Button className={styles.button} onPress={retry}>
                    重试
                  </Button>
                )}
              </div>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function PreferencesForm({
  preferences,
  saving,
  setSaving,
  save,
  close,
}: SettingsActions & {
  preferences: DevicePreferences;
  saving: boolean;
  setSaving: (saving: boolean) => void;
}) {
  const [theme, setTheme] = useState(preferences.theme);
  const [font, setFont] = useState(preferences.font);
  const [eink, setEink] = useState(preferences.eink);
  const [reduceMotion, setReduceMotion] = useState(preferences.reduceMotion);
  const [tab, setTab] = useState("appearance");
  const [error, setError] = useState(false);
  return (
    <Form
      className={styles.fields}
      validationBehavior="aria"
      onSubmit={(event) => {
        event.preventDefault();
        // Reveal the tab before the browser focuses an invalid field.
        const invalid = event.currentTarget.querySelector<HTMLInputElement>("input:invalid");
        if (invalid) {
          setTab(invalid.name === "focusKey" ? "shortcuts" : "reading");
          requestAnimationFrame(() => invalid.reportValidity());
          return;
        }
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
      <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(String(key))}>
        <Tabs.List aria-label="应用设置" className={styles.tabList}>
          <Tabs.Tab id="appearance" className={styles.tab}>
            外观
          </Tabs.Tab>
          <Tabs.Tab id="reading" className={styles.tab}>
            阅读与布局
          </Tabs.Tab>
          <Tabs.Tab id="shortcuts" className={styles.tab}>
            快捷键
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel id="appearance" shouldForceMount className={styles.panel}>
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
              <span aria-hidden="true">⌄</span>
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
              <span aria-hidden="true">⌄</span>
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
        </Tabs.Panel>
        <Tabs.Panel id="reading" shouldForceMount className={styles.panel}>
          <TextField
            className={styles.field}
            name="fontSize"
            type="number"
            isRequired
            validationBehavior="native"
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
            validationBehavior="native"
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
            validationBehavior="native"
            defaultValue={String(preferences.measure)}
          >
            <Label>每行汉字数</Label>
            <Input className={styles.input} min={28} max={56} step={1} />
          </TextField>
          <TextField
            className={styles.field}
            name="sidebarWidth"
            type="number"
            isRequired
            validationBehavior="native"
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
            validationBehavior="native"
            defaultValue={String(preferences.toolsWidth)}
          >
            <Label>文档工具宽度</Label>
            <Input className={styles.input} min={200} max={480} step={1} />
          </TextField>
        </Tabs.Panel>
        <Tabs.Panel id="shortcuts" shouldForceMount className={styles.panel}>
          <TextField className={styles.field} name="focusKey" defaultValue={preferences.focusKey}>
            <Label>专注快捷键</Label>
            <Input
              className={styles.input}
              maxLength={1}
              pattern="[A-Za-z]?"
              placeholder="留空关闭"
            />
          </TextField>
          <dl className={styles.shortcuts}>
            <dt>快速打开</dt>
            <dd>
              <kbd>Ctrl / ⌘</kbd> + <kbd>K</kbd>
            </dd>
            <dt>编辑正文</dt>
            <dd>
              <kbd>Alt</kbd> + <kbd>E</kbd>
            </dd>
            <dt>完整源码</dt>
            <dd>
              <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>E</kbd>
            </dd>
          </dl>
        </Tabs.Panel>
      </Tabs>
      {error && (
        <p className={styles.error} role="alert">
          无法保存设置，请重试。
        </p>
      )}
      <div className={styles.actions}>
        <Button className={styles.button} isDisabled={saving} onPress={close}>
          取消
        </Button>
        <Button type="submit" variant="primary" isDisabled={saving}>
          保存设置
        </Button>
      </div>
    </Form>
  );
}
