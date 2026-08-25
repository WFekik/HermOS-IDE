"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppStore } from "@/stores/app-store";
import { RIGHT_PANEL_TABS } from "@/components/panels/right-panel";

interface ShortcutGroup {
  label: string;
  items: { keys: string[]; description: string }[];
}

const PANEL_TAB_ITEMS = RIGHT_PANEL_TABS.slice(0, 9).map((tab, i) => ({
  keys: ["⌘", String(i + 1)],
  description: `${tab.label} tab`,
}));

const GROUPS: ShortcutGroup[] = [
  {
    label: "General",
    items: [
      { keys: ["⌘", "K"], description: "Open command palette" },
      { keys: ["⌘", "/"], description: "Show keyboard shortcuts" },
      { keys: ["⌘", ","], description: "Open settings" },
      { keys: ["Esc"], description: "Close dialog / overlay" },
    ],
  },
  {
    label: "Conversation",
    items: [
      { keys: ["⌘", "↵"], description: "Send message" },
      { keys: ["⌘", "N"], description: "New conversation" },
      { keys: ["⌘", "E"], description: "Export as Markdown" },
      { keys: ["⌘", "⇧", "A"], description: "Select all conversations" },
    ],
  },
  {
    label: "Navigation",
    items: [
      { keys: ["⌘", "B"], description: "Toggle sidebar" },
      { keys: ["⌘", "J"], description: "Toggle right panel" },
      ...PANEL_TAB_ITEMS,
      { keys: ["⌘", "⇧", "P"], description: "Command palette (alias)" },
    ],
  },
  {
    label: "Editor",
    items: [
      { keys: ["⌘", "↵"], description: "Send / save edited message" },
      { keys: ["Esc"], description: "Cancel edit mode" },
      { keys: ["⌘", "⇧", "F"], description: "Find in files" },
      { keys: ["⌘", "L"], description: "Go to line" },
      { keys: ["⌘", "\\"], description: "Toggle split editor" },
    ],
  },
];

/**
 * Keyboard shortcuts overlay — opened via ⌘? or ⌘/. Renders a clean
 * two-column table grouped by category. Uses the shared Dialog primitive
 * so it composes correctly with the rest of the IDE shell overlays.
 */
export function KeyboardShortcuts() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const setOpen = useAppStore((s) => s.setShortcutsOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 py-4 border-b">
          <DialogTitle className="text-sm font-semibold tracking-tight">
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="text-xs">
            The shortcuts below work across the HermOS IDE. On Windows/Linux,
            use <kbd className="font-mono text-[10px]">Ctrl</kbd> in place of{" "}
            <kbd className="font-mono text-[10px]">⌘</kbd>.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x">
          {GROUPS.map((group, gi) => (
            <section
              key={group.label}
              className={cnPad(gi)}
              aria-labelledby={`shortcuts-group-${group.label}`}
            >
              <h3
                id={`shortcuts-group-${group.label}`}
                className="px-4 pt-4 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {group.label}
              </h3>
              <ul className="px-2 pb-3">
                {group.items.map((item, ii) => (
                  <li
                    key={`${group.label}-${ii}`}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-accent/50 transition-colors"
                  >
                    <span className="text-xs text-foreground/90">{item.description}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {item.keys.map((k, ki) => (
                        <kbd
                          key={ki}
                          className="inline-flex items-center justify-center min-w-[1.25rem] rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Apply padding based on grid position so borders line up. */
function cnPad(index: number): string {
  // On small screens everything stacks vertically; on >= sm we use 2 cols.
  if (index === 0) return "sm:pr-2";
  if (index === 1) return "sm:pl-2";
  if (index === 2) return "sm:pr-2 sm:pt-2 border-t sm:border-t-0";
  return "sm:pl-2 sm:pt-2 border-t sm:border-t-0";
}
