import { AiSettings } from "./AiSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { Dialog } from "../../ui/Dialog";
import { useState } from "react";
import { Button } from "../../ui/Button";
import { Checkbox, Field, Form, Select } from "../../ui/Forms";
import { Feedback } from "../../ui/Feedback";
import { Tabs, TabPanel } from "../../ui/Tabs";
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
  account,
  isAdmin,
  retry,
  save,
  close,
}: SettingsActions & {
  preferences: DevicePreferences | undefined;
  loading: boolean;
  account: string | undefined;
  isAdmin: boolean | undefined;
  retry: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("appearance");
  const [visitedAi, setVisitedAi] = useState(false);
  const [visitedConnections, setVisitedConnections] = useState(false);
  return (
    <Dialog
      title="应用设置"
      busy={saving}
      onClose={close}
      classes={
        tab === "connections"
          ? { overlay: styles.overlay, modal: styles.modalWide, dialog: styles.dialog }
          : { overlay: styles.overlay, modal: styles.modal, dialog: styles.dialog }
      }
    >
      <Tabs
        value={tab}
        disabled={saving}
        onChange={(id) => {
          setTab(id);
          if (id === "ai") setVisitedAi(true);
          if (id === "connections") setVisitedConnections(true);
        }}
        label="应用设置"
        listClassName={styles.tabList}
        tabClassName={styles.tab}
        items={[
          { id: "appearance", label: "外观" },
          { id: "reading", label: "阅读与布局" },
          { id: "shortcuts", label: "快捷键" },
          { id: "ai", label: "AI" },
          { id: "connections", label: "连接" },
        ]}
      >
        {preferences ? (
          <fieldset
            className={styles.device}
            hidden={tab === "ai" || tab === "connections"}
            disabled={saving}
            aria-label="设备偏好"
          >
            <PreferencesForm
              preferences={preferences}
              saving={saving}
              setSaving={setSaving}
              setTab={setTab}
              save={save}
              close={close}
            />
          </fieldset>
        ) : (
          tab !== "ai" && (
            <TabPanel id={tab} className={styles.fields}>
              {loading ? (
                <Feedback>正在读取设备设置…</Feedback>
              ) : (
                <Feedback tone="error" className={styles.error}>
                  无法读取设备设置。
                </Feedback>
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
            </TabPanel>
          )
        )}
        <TabPanel id="ai" keepMounted className={styles.aiPanel}>
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
              <Feedback>暂时无法确认账号权限。</Feedback>
            ))}
          <div className={styles.actions}>
            <Button className={styles.button} isDisabled={saving} onPress={close}>
              关闭
            </Button>
          </div>
        </TabPanel>
        <TabPanel id="connections" keepMounted>
          {visitedConnections &&
            (account && isAdmin !== undefined ? (
              <ConnectionsSettings
                key={account}
                account={account}
                isAdmin={isAdmin}
                active={tab === "connections"}
                busy={saving}
                setBusy={setSaving}
                close={close}
              />
            ) : (
              <Feedback>暂时无法确认账号权限。</Feedback>
            ))}
        </TabPanel>
      </Tabs>
    </Dialog>
  );
}

function PreferencesForm({
  preferences,
  setTab,
  saving,
  setSaving,
  save,
  close,
}: SettingsActions & {
  preferences: DevicePreferences;
  setTab: (tab: string) => void;
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
      className={styles.fields}
      validationBehavior="aria"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
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
      <TabPanel id="appearance" keepMounted className={styles.panel}>
        <Select
          label="主题"
          value={theme}
          disabled={saving}
          onChange={setTheme}
          entries={themes}
          className={styles.field}
        />
        <Select
          label="字体"
          value={font}
          disabled={saving}
          onChange={setFont}
          entries={fonts}
          className={styles.field}
        />
        <Checkbox className={styles.checkbox} disabled={saving} checked={eink} onChange={setEink}>
          墨水屏
        </Checkbox>
        <Checkbox
          className={styles.checkbox}
          disabled={saving}
          checked={reduceMotion}
          onChange={setReduceMotion}
        >
          减少动画
        </Checkbox>
      </TabPanel>
      <TabPanel id="reading" keepMounted className={styles.panel}>
        <Field
          label="字号"
          className={styles.field}
          name="fontSize"
          type="number"
          required
          validationBehavior="native"
          defaultValue={String(preferences.fontSize)}
          inputClassName={styles.input}
          min={16}
          max={28}
          step={1}
        />
        <Field
          label="行高"
          className={styles.field}
          name="lineHeight"
          type="number"
          required
          validationBehavior="native"
          defaultValue={String(preferences.lineHeight)}
          inputClassName={styles.input}
          min={1.4}
          max={2.4}
          step={0.01}
        />
        <Field
          label="每行汉字数"
          className={styles.field}
          name="measure"
          type="number"
          required
          validationBehavior="native"
          defaultValue={String(preferences.measure)}
          inputClassName={styles.input}
          min={28}
          max={56}
          step={1}
        />
        <Field
          label="空间目录宽度"
          className={styles.field}
          name="sidebarWidth"
          type="number"
          required
          validationBehavior="native"
          defaultValue={String(preferences.sidebarWidth)}
          inputClassName={styles.input}
          min={176}
          max={360}
          step={1}
        />
        <Field
          label="文档工具宽度"
          className={styles.field}
          name="toolsWidth"
          type="number"
          required
          validationBehavior="native"
          defaultValue={String(preferences.toolsWidth)}
          inputClassName={styles.input}
          min={200}
          max={480}
          step={1}
        />
      </TabPanel>
      <TabPanel id="shortcuts" keepMounted className={styles.panel}>
        <Field
          label="专注快捷键"
          className={styles.field}
          name="focusKey"
          defaultValue={preferences.focusKey}
          inputClassName={styles.input}
          maxLength={1}
          pattern="[A-Za-z]?"
          placeholder="留空关闭"
        />
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
      </TabPanel>
      {error && (
        <Feedback tone="error" className={styles.error}>
          无法保存设置，请重试。
        </Feedback>
      )}
      <div className={styles.actions}>
        <Button className={styles.button} isDisabled={saving} onPress={close}>
          取消
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          保存设置
        </Button>
      </div>
    </Form>
  );
}
