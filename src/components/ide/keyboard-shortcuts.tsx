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
import { useTranslation } from "@/hooks/use-translation";
import { RIGHT_PANEL_TABS } from "@/components/panels/right-panel";

interface ShortcutGroup {
  label: string;
  items: { keys: string[]; description: string }[];
}

/**
 * Keyboard shortcuts overlay — opened via ⌘? or ⌘/. Renders a clean
 * two-column table grouped by category. Uses the shared Dialog primitive
 * so it composes correctly with the rest of the IDE shell overlays.
 */
export function KeyboardShortcuts() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.shortcutsOpen);
  const setOpen = useAppStore((s) => s.setShortcutsOpen);

  const groups: ShortcutGroup[] = React.useMemo(() => {
    const panelTabItems = RIGHT_PANEL_TABS.slice(0, 9).map((tab, i) => ({
      keys: ["⌘", String(i + 1)],
      description: t("ks_tab_suffix").replace("{tab}", t(tab.value)),
    }));

    return [
      {
        label: t("ks_group_general"),
        items: [
          { keys: ["⌘", "K"], description: t("ks_open_command_palette") },
          { keys: ["⌘", "/"], description: t("ks_show_keyboard_shortcuts") },
          { keys: ["⌘", ","], description: t("ks_open_settings") },
          { keys: ["Esc"], description: t("ks_close_dialog_overlay") },
        ],
      },
      {
        label: t("ks_group_conversation"),
        items: [
          { keys: ["⌘", "↵"], description: t("ks_send_message") },
          { keys: ["⌘", "N"], description: t("cmd_new_conversation") },
          { keys: ["⌘", "E"], description: t("ks_export_as_markdown") },
          { keys: ["⌘", "⇧", "A"], description: t("ks_select_all_conversations") },
        ],
      },
      {
        label: t("ks_group_navigation"),
        items: [
          { keys: ["⌘", "B"], description: t("ks_toggle_sidebar") },
          { keys: ["⌘", "J"], description: t("ks_toggle_right_panel") },
          ...panelTabItems,
          { keys: ["⌘", "⇧", "P"], description: t("ks_command_palette_alias") },
        ],
      },
      {
        label: t("ks_group_editor"),
        items: [
          { keys: ["⌘", "↵"], description: t("ks_send_save_edited") },
          { keys: ["Esc"], description: t("ks_cancel_edit_mode") },
          { keys: ["⌘", "⇧", "F"], description: t("cmd_find_in_files") },
          { keys: ["⌘", "L"], description: t("cmd_go_to_line") },
          { keys: ["⌘", "\\"], description: t("ks_toggle_split_editor") },
        ],
      },
    ];
  }, [t]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 py-4 border-b">
          <DialogTitle className="text-sm font-semibold tracking-tight">
            {t("keyboard_shortcuts_title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("keyboard_shortcuts_desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x">
          {groups.map((group, gi) => (
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
  if (index === 0) return "sm:pe-2";
  if (index === 1) return "sm:ps-2";
  if (index === 2) return "sm:pe-2 sm:pt-2 border-t sm:border-t-0";
  return "sm:ps-2 sm:pt-2 border-t sm:border-t-0";
}
