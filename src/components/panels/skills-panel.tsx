"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Sparkles,
  Play,
  Loader2,
  Bot,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppStore } from "@/stores/app-store";
import { toast } from "sonner";
import { useTranslation } from "@/hooks/use-translation";
import { getSkillDisplayName, getSkillDescription, getSkillToolDescription } from "@/lib/i18n";
import type { PluginDTO } from "@/lib/types";

export function SkillsPanel() {
  const { t } = useTranslation();
  const skills = useAppStore((s) => s.skills);
  const toggle = useAppStore((s) => s.togglePlugin);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const refreshSkills = useAppStore((s) => s.refreshSkills);

  const [invoke, setInvoke] = React.useState<PluginDTO | null>(null);
  const [invokeTool, setInvokeTool] = React.useState<any | null>(null);
  const [input, setInput] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);

  React.useEffect(() => {
    refreshSkills();
  }, [refreshSkills]);

  const run = async () => {
    if (!invoke || !invokeTool) return;
    setResult(null);
    setRunning(true);

    try {
      let parsedArgs = {};
      if (input.trim()) {
        try {
          parsedArgs = JSON.parse(input);
        } catch {
          // If not valid JSON, treat as a single string arg if schema allows
          parsedArgs = { input };
        }
      }

      // Execute plugin tool API
      const res = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "execute_plugin_tool",
          pluginName: invoke.name,
          toolName: invokeTool.name,
          args: parsedArgs,
        }),
      });

      const data = await res.json();
      if (data.ok) {
        setResult(JSON.stringify(data.result, null, 2));
      } else {
        setResult(`${t("error")}: ${data.error || t("execution_failed")}`);
      }
    } catch (e: any) {
      setResult(`${t("error")}: ${e.message || String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-brand" />
          <span className="text-sm font-medium">{t("skills_and_custom_tools")}</span>
          <Badge variant="secondary" className="text-[10px]">{skills.length}</Badge>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 grid grid-cols-1 gap-2">
          {skills.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
              {t("no_custom_skills")}
            </div>
          ) : (
            skills.map((skill) => {
              const enabled = skill.enabled;
              const manifestTools = (skill.manifest as any)?.tools || [];

              return (
                <motion.div
                  key={skill.id}
                  layout
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.15 }}
                  className="rounded-lg border bg-background p-3 flex flex-col gap-2"
                >
                  <div className="flex items-start gap-2">
                    <div className="size-7 rounded-md bg-brand/10 flex items-center justify-center shrink-0">
                      <Sparkles className="size-3.5 text-brand" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium">{getSkillDisplayName(skill.name, t)}</span>
                        <Badge variant="outline" className="text-[9px] h-3.5 text-brand border-brand/40">
                          v{skill.version}
                        </Badge>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">{getSkillDescription(skill.name, skill.description, t) || t("no_description")}</div>
                    </div>
                    <Switch
                      checked={enabled}
                      onCheckedChange={(v) => {
                        toggle(skill.id, v);
                      }}
                      aria-label={t("toggle_skill", { name: getSkillDisplayName(skill.name, t) })}
                    />
                  </div>

                  {manifestTools.length > 0 && (
                    <div className="border-t pt-2 mt-1 space-y-1.5">
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        {t("exported_tools")}
                      </div>
                      {manifestTools.map((tool: any) => (
                        <div key={tool.name} className="flex items-center justify-between gap-2 p-1.5 rounded bg-muted/40 hover:bg-muted/70 transition-colors">
                          <div className="min-w-0 flex-1">
                            <code className="text-[10px] font-mono text-brand block truncate">{tool.name}</code>
                            <span className="text-[9px] text-muted-foreground block truncate">{getSkillToolDescription(tool.name, tool.description, t)}</span>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-1.5 text-[9px] gap-0.5"
                              disabled={!enabled}
                              onClick={() => {
                                setInvoke(skill);
                                setInvokeTool(tool);
                                setInput(JSON.stringify(tool.inputSchema?.properties || {}, null, 2));
                                setResult(null);
                              }}
                            >
                              <Play className="size-2" /> {t("test")}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-1.5 mt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px] w-full"
                      onClick={() => {
                        if (!activeConversationId) {
                          toast.error(t("open_conversation_first"));
                          return;
                        }
                        setComposerDraft(t("use_skill_draft").replace("{name}", skill.name));
                        toast.success(t("mentioned_skill_in_composer", { name: skill.name }));
                      }}
                    >
                      <Bot className="size-3" /> {t("mention_in_chat")}
                    </Button>
                  </div>
                </motion.div>
              );
            })
          )}
        </div>
      </ScrollArea>

      <Dialog open={invoke !== null} onOpenChange={(o) => !o && setInvoke(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="size-4 text-brand" />
              {t("test_tool", { tool: invokeTool?.name ?? "", skill: getSkillDisplayName(invoke?.name ?? "", t) })}
            </DialogTitle>
            <DialogDescription className="text-xs">{getSkillToolDescription(invokeTool?.name ?? "", invokeTool?.description, t)}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <div className="text-[10px] font-semibold text-muted-foreground">{t("input_arguments_json")}</div>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="min-h-[100px] text-xs font-mono"
            />
            {result && (
              <>
                <div className="text-[10px] font-semibold text-muted-foreground mt-2">{t("output_result")}</div>
                <pre className="rounded-md border bg-muted/30 p-2.5 text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {result}
                </pre>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setInvoke(null)}>{t("close")}</Button>
            <Button size="sm" onClick={run} disabled={running}>
              {running ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> {t("executing")}…
                </>
              ) : (
                <>
                  <Play className="size-3.5" /> {t("execute")}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
