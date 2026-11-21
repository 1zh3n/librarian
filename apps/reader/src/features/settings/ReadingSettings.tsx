import { useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  Form,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "../../ui/primitives";
import { SettingsChoice } from "./SettingsChoice";
import { AiSettings } from "./AiSettings";
import { Tabs } from "../../ui/Tabs";
import type { DevicePreferences } from "../../api/client";
import styles from "./ReadingSettings.module.css";

const themes = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const;
const fonts = [
  { value: "serif", label: "衬线" },
  { value: "sans", label: "无衬线" },
] as const;

type SettingsActions = {
  save: (changes: Partial<DevicePreferences>) => Promise<DevicePreferences>;
  close: () => void;
};

export function ReadingSettings({
  preferences,
  loading,
  isAdmin,
  account,
  retry,
  save,
  close,
}: SettingsActions & {
  preferences: DevicePreferences | undefined;
  loading: boolean;
  isAdmin: boolean | undefined;
  account: string | undefined;
  retry: () => void;
}) {
  const [tab, setTab] = useState("appearance");
  const [visitedAi, setVisitedAi] = useState(false);
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
          <Tabs
            isDisabled={saving}
            selectedKey={tab}
            onSelectionChange={(key) => {
              setTab(String(key));
              if (key === "ai") setVisitedAi(true);
            }}
          >
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
              <Tabs.Tab id="ai" className={styles.tab}>
                AI
              </Tabs.Tab>
            </Tabs.List>

            {preferences ? (
              <PreferencesForm
                tab={tab}
                setTab={setTab}
                preferences={preferences}
                saving={saving}
                setSaving={setSaving}
                save={save}
                close={close}
              />
            ) : (
              tab !== "ai" && (
                <Tabs.Panel id={tab} className={styles.fields}>
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
                </Tabs.Panel>
              )
            )}
            <Tabs.Panel id="ai" shouldForceMount className={styles.aiPanel}>
              {visitedAi &&
                (account && isAdmin !== undefined ? (
                  <AiSettings
                    key={account}
                    username={account}
                    isAdmin={isAdmin}
                    active={tab === "ai"}
                    busy={saving}
                    setBusy={setSaving}
                  />
                ) : (
                  <p>暂时无法确认账号权限。</p>
                ))}
              <div className={styles.actions}>
                <Button className={styles.button} isDisabled={saving} onPress={close}>
                  关闭
                </Button>
              </div>
            </Tabs.Panel>
          </Tabs>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function PreferencesForm({
  tab,
  setTab,
  preferences,
  saving,
  setSaving,
  save,
  close,
}: SettingsActions & {
  tab: string;
  setTab: (tab: string) => void;
  preferences: DevicePreferences;
  saving: boolean;
  setSaving: (saving: boolean) => void;
}) {
  const [theme, setTheme] = useState(preferences.theme);
  const [font, setFont] = useState(preferences.font);
  const [eink, setEink] = useState(preferences.eink);
  const [reduceMotion, setReduceMotion] = useState(preferences.reduceMotion);
  const [error, setError] = useState(false);
  return (
    <Form
      hidden={tab === "ai"}
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
      <Tabs.Panel id="appearance" shouldForceMount className={styles.panel}>
        <SettingsChoice label="主题" value={theme} entries={themes} onChange={setTheme} />
        <SettingsChoice label="字体" value={font} entries={fonts} onChange={setFont} />
        <Checkbox className={styles.checkbox} isSelected={eink} onChange={setEink}>
          <span className={styles.mark} aria-hidden="true" /> 墨水屏
        </Checkbox>
        <Checkbox className={styles.checkbox} isSelected={reduceMotion} onChange={setReduceMotion}>
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
