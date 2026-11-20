import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { api } from "../../api/client";
import type { DevicePreferences } from "../../api/client";

const defaults: DevicePreferences = {
  theme: "system",
  font: "serif",
  layout: "custom",
  fontSize: 18,
  lineHeight: 1.85,
  measure: 42,
  navigation: null,
  sidebarWidth: 236,
  toolsWidth: 256,
  eink: false,
  reduceMotion: false,
  focusKey: "f",
};

function browserDeviceId() {
  const key = "librarian.device";
  const create = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  try {
    const existing = window.localStorage.getItem(key);
    if (existing && /^[a-zA-Z0-9_-]{8,64}$/u.test(existing)) return existing;
    const id = create();
    window.localStorage.setItem(key, id);
    return id;
  } catch {
    return create();
  }
}

export function useDevicePreferences(enabled: boolean) {
  const [device] = useState(browserDeviceId);
  const client = useQueryClient();
  const queryKey = ["device-preferences", device] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.getDevicePreferences(device, signal),
    enabled,
  });
  const mutation = useMutation({
    scope: { id: device },
    mutationFn: async (patch: Partial<DevicePreferences>) => {
      await client.cancelQueries({ queryKey, exact: true });
      const preferences = await api.getDevicePreferences(device);
      return api.saveDevicePreferences(device, { ...preferences, ...patch });
    },
    onSuccess: (value) => client.setQueryData(queryKey, value),
  });

  const preferences = query.data ?? defaults;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = preferences.theme;
    root.dataset.eink = String(preferences.eink);
    root.dataset.reduceMotion = String(preferences.reduceMotion);
    root.dataset.readingFont = preferences.font;
    root.style.setProperty("--reading-size", `${preferences.fontSize}px`);
    root.style.setProperty("--reading-measure", String(preferences.measure));
    root.style.setProperty("--reading-line-height", String(preferences.lineHeight));
  }, [preferences]);

  return {
    preferences,
    save: mutation.mutateAsync,
  };
}
