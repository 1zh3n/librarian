import { AiSettings } from "./AiSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { Dialog } from "../../ui/Dialog";
import { useEffect, useRef, useState } from "react";
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

type Draft = {
  theme: DevicePreferences["theme"];
  font: DevicePreferences["font"];
  eink: boolean;
  reduceMotion: boolean;
  fontSize: string;
  lineHeight: string;
  measure: string;
  sidebarWidth: string;
  toolsWidth: string;
  focusKey: string;
};

function draftFrom(preferences: DevicePreferences): Draft {
  return {
    theme: preferences.theme,
    font: preferences.font,
    eink: preferences.eink,
    reduceMotion: preferences.reduceMotion,
    fontSize: String(preferences.fontSize),
    lineHeight: String(preferences.lineHeight),
    measure: String(preferences.measure),
    sidebarWidth: String(preferences.sidebarWidth),
    toolsWidth: String(preferences.toolsWidth),
    focusKey: preferences.focusKey,
  };
}

function patchFrom(draft: Draft): { patch?: Partial<DevicePreferences>; error?: string } {
  const fontSize = Number(draft.fontSize);
  const lineHeight = Number(draft.lineHeight);
  const measure = Number(draft.measure);
  const sidebarWidth = Number(draft.sidebarWidth);
  const toolsWidth = Number(draft.toolsWidth);
  const focusKey = draft.focusKey.toLowerCase().trim();
  if (fontSize < 16 || fontSize > 28)
    return { error: "字号需在 16–28 之间；修改已保留，请修正后重试。" };
  if (lineHeight < 1.4 || lineHeight > 2.4)
    return { error: "行高需在 1.4–2.4 之间；修改已保留，请修正后重试。" };
  if (measure < 28 || measure > 56)
    return { error: "每行汉字数需在 28–56 之间；修改已保留，请修正后重试。" };
  if (sidebarWidth < 176 || sidebarWidth > 360)
    return { error: "空间目录宽度需在 176–360 之间；修改已保留，请修正后重试。" };
  if (toolsWidth < 200 || toolsWidth > 480)
    return { error: "文档工具宽度需在 200–480 之间；修改已保留，请修正后重试。" };
  if (!/^[a-z]?$/u.test(focusKey)) return { error: "专注快捷键只能是一个英文字母，或留空。" };
  return {
    patch: {
      theme: draft.theme,
      font: draft.font,
      eink: draft.eink,
      reduceMotion: draft.reduceMotion,
      fontSize,
      lineHeight,
      measure,
      sidebarWidth,
      toolsWidth,
      focusKey,
    },
  };
}

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
  const [closing, setClosing] = useState(false);
  const [tab, setTab] = useState("reading");
  const [visitedAi, setVisitedAi] = useState(false);
  const [visitedConnections, setVisitedConnections] = useState(false);
  const flush = useRef<(() => Promise<boolean>) | null>(null);
  const showPreferences = tab === "reading" || tab === "shortcuts";
  async function requestClose() {
    if (saving || closing) return;
    setClosing(true);
    const ok = (await flush.current?.()) ?? true;
    setClosing(false);
    if (ok) close();
    else setTab("reading");
  }
  return (
    <Dialog
      title="应用设置"
      showClose
      closeLabel="关闭应用设置"
      busy={saving || closing}
      onClose={() => void requestClose()}
      classes={{ overlay: styles.overlay, modal: styles.modal, dialog: styles.dialog }}
      headerClassName={styles.dialogHeader}
      closeClassName={styles.dialogClose}
    >
      <Tabs
        className={styles.settings}
        value={tab}
        disabled={saving || closing}
        onChange={(id) => {
          setTab(id);
          if (id === "ai") setVisitedAi(true);
          if (id === "connections") setVisitedConnections(true);
        }}
        label="应用设置"
        listClassName={styles.tabList}
        tabClassName={styles.tab}
        items={[
          { id: "reading", label: "阅读" },
          { id: "shortcuts", label: "快捷键" },
          { id: "ai", label: "AI" },
          { id: "connections", label: "连接" },
        ]}
      >
        {preferences ? (
          <PreferencesForm
            preferences={preferences}
            saving={saving || closing}
            hidden={!showPreferences}
            setSaving={setSaving}
            save={save}
            flushRef={flush}
          />
        ) : showPreferences ? (
          <div className={styles.state}>
            {loading ? (
              <Feedback>正在读取设备设置…</Feedback>
            ) : (
              <Feedback tone="error">无法读取设备设置。</Feedback>
            )}
            {!loading && (
              <div className={styles.actions}>
                <Button variant="outline" onPress={retry}>
                  重试
                </Button>
              </div>
            )}
          </div>
        ) : null}
        <TabPanel id="ai" keepMounted className={styles.scrollPanel}>
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
        </TabPanel>
        <TabPanel id="connections" keepMounted className={styles.scrollPanel}>
          {visitedConnections &&
            (account && isAdmin !== undefined ? (
              <ConnectionsSettings
                key={account}
                account={account}
                isAdmin={isAdmin}
                active={tab === "connections"}
                busy={saving}
                setBusy={setSaving}
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
  hidden,
  saving,
  setSaving,
  save,
  flushRef,
}: {
  preferences: DevicePreferences;
  hidden: boolean;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  save: (changes: Partial<DevicePreferences>) => Promise<DevicePreferences>;
  flushRef: { current: (() => Promise<boolean>) | null };
}) {
  const [draft, setDraft] = useState(() => draftFrom(preferences));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const latest = useRef(draft);
  const timer = useRef<number | undefined>(undefined);
  const savedTimer = useRef<number | undefined>(undefined);
  const changeVersion = useRef(0);
  const savedVersion = useRef(0);
  const running = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      if (timer.current) window.clearTimeout(timer.current);
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
    },
    [],
  );
  function update(patch: Partial<Draft>) {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setDraft(next);
    changeVersion.current += 1;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      void flush();
    }, 250);
  }
  function flush(): Promise<boolean> {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    if (savedVersion.current === changeVersion.current) return Promise.resolve(true);
    if (running.current) return running.current;
    const promise = (async () => {
      setSaving(true);
      let ok = true;
      while (savedVersion.current !== changeVersion.current) {
        const version = changeVersion.current;
        const parsed = patchFrom(latest.current);
        if (!parsed.patch) {
          if (mounted.current) {
            setStatus("error");
            setMessage(parsed.error ?? "请检查设置后再试。");
          }
          ok = false;
          break;
        }
        if (mounted.current) {
          setStatus("saving");
          setMessage("");
        }
        try {
          await save(parsed.patch);
          savedVersion.current = version;
          if (version === changeVersion.current && mounted.current) {
            setStatus("saved");
            if (savedTimer.current) window.clearTimeout(savedTimer.current);
            savedTimer.current = window.setTimeout(() => setStatus("idle"), 1_500);
          }
        } catch {
          if (version === changeVersion.current && mounted.current) {
            setStatus("error");
            setMessage("无法保存设置，请重试。");
          }
          ok = false;
          break;
        }
      }
      if (mounted.current) setSaving(false);
      return ok;
    })();
    running.current = promise;
    void promise.finally(() => {
      if (running.current === promise) running.current = null;
    });
    return promise;
  }
  useEffect(() => {
    flushRef.current = flush;
    return () => {
      flushRef.current = null;
    };
  });
  return (
    <Form
      className={styles.form}
      hidden={hidden}
      onSubmit={(event) => {
        event.preventDefault();
        void flush();
      }}
    >
      <TabPanel id="reading" keepMounted className={styles.panel}>
        <Select
          label="主题"
          value={draft.theme}
          disabled={saving}
          onChange={(theme) => update({ theme })}
          entries={themes}
          className={styles.field}
        />
        <Select
          label="字体"
          value={draft.font}
          disabled={saving}
          onChange={(font) => update({ font })}
          entries={fonts}
          className={styles.field}
        />
        <Checkbox
          className={styles.checkbox}
          disabled={saving}
          checked={draft.eink}
          onChange={(eink) => update({ eink })}
        >
          墨水屏
        </Checkbox>
        <Checkbox
          className={styles.checkbox}
          disabled={saving}
          checked={draft.reduceMotion}
          onChange={(reduceMotion) => update({ reduceMotion })}
        >
          减少动画
        </Checkbox>
        <Field
          label="字号"
          className={styles.field}
          name="fontSize"
          type="number"
          required
          disabled={saving}
          validationBehavior="native"
          value={draft.fontSize}
          onChange={(fontSize) => update({ fontSize })}
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
          disabled={saving}
          validationBehavior="native"
          value={draft.lineHeight}
          onChange={(lineHeight) => update({ lineHeight })}
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
          disabled={saving}
          validationBehavior="native"
          value={draft.measure}
          onChange={(measure) => update({ measure })}
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
          disabled={saving}
          validationBehavior="native"
          value={draft.sidebarWidth}
          onChange={(sidebarWidth) => update({ sidebarWidth })}
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
          disabled={saving}
          validationBehavior="native"
          value={draft.toolsWidth}
          onChange={(toolsWidth) => update({ toolsWidth })}
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
          disabled={saving}
          value={draft.focusKey}
          onChange={(focusKey) => update({ focusKey })}
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
      <div
        className={styles.formStatus}
        data-active={status !== "idle" || undefined}
        aria-live="polite"
      >
        {status === "saving" && <span className={styles.saveNote}>正在保存…</span>}
        {status === "saved" && <span className={styles.saveNote}>已保存</span>}
        {status === "error" && (
          <Feedback tone="error" className={styles.error}>
            {message}
            <Button size="sm" variant="outline" onPress={() => void flush()}>
              重试
            </Button>
          </Feedback>
        )}
      </div>
    </Form>
  );
}
