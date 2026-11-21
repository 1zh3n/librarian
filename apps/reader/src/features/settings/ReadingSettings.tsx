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
    <Dialog title="应用设置" busy={saving} onClose={close} classes={styles}>
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
        </div>
      )}
    </Dialog>
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
      <Tabs
        value={tab}
        onChange={setTab}
        label="应用设置"
        listClassName={styles.tabList}
        tabClassName={styles.tab}
        items={[
          { id: "appearance", label: "外观" },
          { id: "reading", label: "阅读与布局" },
          { id: "shortcuts", label: "快捷键" },
        ]}
      >
        <TabPanel id="appearance" keepMounted className={styles.panel}>
          <Select
            label="主题"
            value={theme}
            onChange={setTheme}
            entries={themes}
            className={styles.field}
          />
          <Select
            label="字体"
            value={font}
            onChange={setFont}
            entries={fonts}
            className={styles.field}
          />
          <Checkbox className={styles.checkbox} checked={eink} onChange={setEink}>
            墨水屏
          </Checkbox>
          <Checkbox className={styles.checkbox} checked={reduceMotion} onChange={setReduceMotion}>
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
      </Tabs>
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
