/**
 * Which palette the interface uses.
 *
 * Dark is the default and what the design system is built for. Light exists
 * because this is a flight-operations screen: a pilot may open it on a tablet in
 * daylight, where a near-black canvas is not a style choice but an unreadable
 * one. The choice is the person's and it is remembered, because somebody who
 * flies outdoors will make it once and not want to make it again.
 */
export type Theme = "dark" | "light";

const KEY = "aerotunnel.theme";

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // Private browsing, or storage switched off. Falling through to the default
    // is correct — a theme preference is not worth an error boundary.
  }
  return "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Nothing to do: the theme is applied for this page either way.
  }
}
