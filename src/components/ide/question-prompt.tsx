"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { HelpCircle, Send, Check, Clock, Sparkles, ChevronRight, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QuestionPromptState, QuestionItemState } from "@/stores/app-store";

export const QUESTION_AUTO_TIMEOUT_MS = 300_000; // 5 minutes

export interface QuestionAnswerPayload {
  answers?: Array<{
    questionIndex: number;
    question: string;
    selectedOptions?: string[];
    text?: string;
  }>;
  selectedOptions?: string[];
  text?: string;
}

interface QuestionPromptProps {
  prompt: QuestionPromptState;
  onResolve: (answer: QuestionAnswerPayload) => void;
}

interface QuestionAnswerState {
  selected: string[];
  text: string;
}

/**
 * Isolated Countdown Timer & Progress Bar component.
 * Ticking state is contained purely within this component so that second-by-second updates
 * do not re-render the question list, options, or active input fields.
 */
const QuestionCountdown = React.memo(function QuestionCountdown({
  timeoutMs = QUESTION_AUTO_TIMEOUT_MS,
  onTimeout,
}: {
  timeoutMs?: number;
  onTimeout: () => void;
}) {
  const [remaining, setRemaining] = React.useState(timeoutMs);
  const onTimeoutRef = React.useRef(onTimeout);

  React.useEffect(() => {
    onTimeoutRef.current = onTimeout;
  });

  React.useEffect(() => {
    setRemaining(timeoutMs);
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const left = Math.max(0, timeoutMs - elapsed);
      setRemaining(left);
      if (left <= 0) {
        clearInterval(interval);
        onTimeoutRef.current();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [timeoutMs]);

  const secondsLeft = Math.ceil(remaining / 1000);
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const timerLabel = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  const progressPct = Math.max(0, Math.min(100, (remaining / timeoutMs) * 100));

  return (
    <React.Fragment>
      <span className="text-[11px] font-mono text-muted-foreground flex items-center gap-1 shrink-0">
        <Clock className="size-3 text-muted-foreground/70" />
        {timerLabel}
      </span>
      {/* Absolute or contained progress bar */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-muted overflow-hidden">
        <div
          className="h-full bg-brand transition-all duration-1000 ease-linear"
          style={{ width: `${progressPct}%` }}
        />
      </div>
    </React.Fragment>
  );
});

export const QuestionPromptCard = React.memo(function QuestionPromptCard({
  prompt,
  onResolve,
}: QuestionPromptProps) {
  const questions: QuestionItemState[] = React.useMemo(() => {
    if (prompt.questions && prompt.questions.length > 0) {
      return prompt.questions;
    }
    if (prompt.question) {
      return [
        {
          question: prompt.question,
          options: prompt.options,
          isMultiSelect: prompt.isMultiSelect,
        },
      ];
    }
    return [];
  }, [prompt]);

  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [answersState, setAnswersState] = React.useState<Record<number, QuestionAnswerState>>({});
  const [submitting, setSubmitting] = React.useState(false);

  const resolveRef = React.useRef(onResolve);
  React.useEffect(() => {
    resolveRef.current = onResolve;
  });

  // Reset state when prompt id changes
  React.useEffect(() => {
    const initial: Record<number, QuestionAnswerState> = {};
    questions.forEach((_, idx) => {
      initial[idx] = { selected: [], text: "" };
    });
    setAnswersState(initial);
    setCurrentIndex(0);
    setSubmitting(false);
  }, [prompt.id, questions]);

  const handleTimeout = React.useCallback(() => {
    resolveRef.current({
      text: "User did not answer within timeout. Proceed using best judgment.",
      answers: questions.map((q, idx) => ({
        questionIndex: idx,
        question: q.question,
        text: "Timed out",
      })),
    });
  }, [questions]);

  const totalQuestions = questions.length;
  const isLastQuestion = currentIndex === totalQuestions - 1;
  const currentQuestion = questions[currentIndex];
  const currentAnswer = answersState[currentIndex] ?? { selected: [], text: "" };

  const hasSelection = (ans?: QuestionAnswerState) =>
    Boolean(ans?.selected && ans.selected.length > 0);

  const isQuestionAnswered = React.useCallback(
    (q: QuestionItemState | undefined, ans: QuestionAnswerState | undefined) => {
      if (!q) return false;
      const hasText = Boolean(ans?.text && ans.text.trim().length > 0);
      const hasOptions = Boolean(q.options && q.options.length > 0);
      if (hasOptions) return hasSelection(ans) || hasText;
      return hasText;
    },
    [],
  );

  const isCurrentAnswered = isQuestionAnswered(currentQuestion, currentAnswer);

  const allAnswered = React.useMemo(
    () => questions.every((q, idx) => isQuestionAnswered(q, answersState[idx])),
    [questions, answersState, isQuestionAnswered],
  );

  const unansweredCount = React.useMemo(
    () => questions.filter((q, idx) => !isQuestionAnswered(q, answersState[idx])).length,
    [questions, answersState, isQuestionAnswered],
  );

  const toggleOption = React.useCallback((opt: string, isMulti: boolean) => {
    setAnswersState((prev) => {
      const current = prev[currentIndex] ?? { selected: [], text: "" };
      let nextSelected: string[];
      if (isMulti) {
        nextSelected = current.selected.includes(opt)
          ? current.selected.filter((o) => o !== opt)
          : [...current.selected, opt];
      } else {
        nextSelected = current.selected.includes(opt) ? [] : [opt];
      }
      return {
        ...prev,
        [currentIndex]: { ...current, selected: nextSelected },
      };
    });
  }, [currentIndex]);

  const setText = React.useCallback((text: string) => {
    setAnswersState((prev) => {
      const current = prev[currentIndex] ?? { selected: [], text: "" };
      return {
        ...prev,
        [currentIndex]: { ...current, text },
      };
    });
  }, [currentIndex]);

  const handleNext = React.useCallback(() => {
    if (currentIndex < totalQuestions - 1) {
      setCurrentIndex((prev) => prev + 1);
    }
  }, [currentIndex, totalQuestions]);

  const handleBack = React.useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex((prev) => prev - 1);
    }
  }, [currentIndex]);

  const handleSubmit = React.useCallback(() => {
    if (submitting) return;
    setSubmitting(true);

    const structuredAnswers = questions.map((q, idx) => {
      const ans = answersState[idx] ?? { selected: [], text: "" };
      return {
        questionIndex: idx,
        question: q.question,
        selectedOptions: ans.selected.length > 0 ? ans.selected : undefined,
        text: ans.text.trim().length > 0 ? ans.text.trim() : undefined,
      };
    });

    const firstAns = answersState[0] ?? { selected: [], text: "" };
    resolveRef.current({
      answers: structuredAnswers,
      selectedOptions: firstAns.selected.length > 0 ? firstAns.selected : undefined,
      text: firstAns.text.trim().length > 0 ? firstAns.text.trim() : undefined,
    });
  }, [answersState, questions, submitting]);

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (isLastQuestion) {
        if (allAnswered) {
          handleSubmit();
        } else {
          const firstUnanswered = questions.findIndex(
            (q, idx) => !isQuestionAnswered(q, answersState[idx]),
          );
          if (firstUnanswered >= 0) setCurrentIndex(firstUnanswered);
        }
      } else if (isCurrentAnswered) {
        handleNext();
      }
    }
  }, [allAnswered, answersState, handleNext, handleSubmit, isCurrentAnswered, isLastQuestion, isQuestionAnswered, questions]);

  if (!currentQuestion) return null;

  const hasOptions = currentQuestion.options && currentQuestion.options.length > 0;
  const isMulti = Boolean(currentQuestion.isMultiSelect);

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="p-3"
      role="dialog"
      aria-live="assertive"
      aria-label="Clarification Prompt"
      onKeyDown={handleKeyDown}
    >
      <div className="relative rounded-lg border border-brand/40 bg-card overflow-hidden shadow-xs pb-1">
        {/* Header with Step Progress & Isolated Countdown */}
        <div className="flex items-center justify-between gap-2 p-3 pb-2.5 bg-brand/5 border-b border-border/50">
          <div className="flex items-center gap-2 min-w-0">
            <div className="size-6 rounded-md bg-brand/15 flex items-center justify-center text-brand shrink-0">
              <HelpCircle className="size-3.5" />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1">
                <Sparkles className="size-3 text-brand" />
                {totalQuestions > 1
                  ? `Question ${currentIndex + 1} of ${totalQuestions}`
                  : "HermOS needs clarification"}
              </span>

              {/* Step indicator pills */}
              {totalQuestions > 1 && (
                <div className="flex items-center gap-1 ml-1">
                  {questions.map((q, idx) => {
                    const isAnswered = isQuestionAnswered(q, answersState[idx]);
                    const isActive = idx === currentIndex;

                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setCurrentIndex(idx)}
                        className={cn(
                          "h-1.5 rounded-full transition-all duration-200",
                          isActive
                            ? "w-5 bg-brand"
                            : isAnswered
                              ? "w-2.5 bg-brand/50 hover:bg-brand/70"
                              : "w-2 bg-muted-foreground/30 hover:bg-muted-foreground/50",
                        )}
                        title={`Go to Question ${idx + 1}`}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <QuestionCountdown
            timeoutMs={QUESTION_AUTO_TIMEOUT_MS}
            onTimeout={handleTimeout}
          />
        </div>

        {/* Current Question Body with smooth slide animation */}
        <div className="p-3 space-y-3">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentIndex}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="space-y-3"
            >
              {/* Question title */}
              <div className="text-[13px] font-medium text-foreground leading-relaxed">
                {currentQuestion.question}
              </div>

              {/* Options list */}
              {hasOptions && (
                <div className="space-y-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {isMulti ? "Select one or more options:" : "Select an option:"}
                  </div>
                  <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                    {currentQuestion.options!.map((opt, optIdx) => {
                      const isSelected = currentAnswer.selected.includes(opt);
                      return (
                        <button
                          key={optIdx}
                          type="button"
                          onClick={() => toggleOption(opt, isMulti)}
                          className={cn(
                            "w-full flex items-start gap-2.5 p-2 rounded-md text-left text-xs transition-all border",
                            isSelected
                              ? "border-brand bg-brand/10 text-foreground font-medium shadow-xs"
                              : "border-border/60 hover:border-border hover:bg-muted/50 text-foreground/85",
                          )}
                        >
                          {isMulti ? (
                            <div
                              className={cn(
                                "mt-0.5 size-4 rounded-[4px] border flex items-center justify-center shrink-0 transition-colors",
                                isSelected
                                  ? "border-brand bg-brand text-brand-foreground"
                                  : "border-muted-foreground/40 bg-input/20",
                              )}
                            >
                              {isSelected && <Check className="size-3" />}
                            </div>
                          ) : (
                            <div
                              className={cn(
                                "mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 transition-colors",
                                isSelected
                                  ? "border-brand bg-brand text-brand-foreground"
                                  : "border-muted-foreground/40 bg-input/20",
                              )}
                            >
                              {isSelected && <Check className="size-2.5" />}
                            </div>
                          )}
                          <span className="flex-1 leading-snug">{opt}</span>
                          <kbd className="text-[10px] text-muted-foreground/60 px-1 py-0.2 rounded border border-border/40 font-mono">
                            {optIdx + 1}
                          </kbd>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Custom write-in textarea */}
              <div>
                <div className="text-[10px] font-medium text-muted-foreground mb-1">
                  {hasOptions ? "Or write custom answer / instructions:" : "Your answer:"}
                </div>
                <textarea
                  value={currentAnswer.text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={
                    hasOptions
                      ? "Type custom answer or extra instructions (optional)..."
                      : "Type your answer here..."
                  }
                  className="w-full min-h-[48px] max-h-24 text-xs p-2 rounded-md bg-muted/40 border border-border/70 focus:outline-hidden focus:ring-1 focus:ring-brand focus:border-brand placeholder:text-muted-foreground/60 resize-y"
                  rows={2}
                />
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer Navigation Bar (Back, Next, Submit) */}
        <div className="flex items-center justify-between p-3 pt-2">
          <div className="min-w-0">
            {currentIndex > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleBack}
                className="h-8 gap-1 text-xs"
              >
                <ChevronLeft className="size-3.5" />
                Back
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground hidden sm:inline">
                Press <kbd className="font-mono bg-muted/60 px-1 py-0.5 rounded text-[10px]">Ctrl+Enter</kbd> to {isLastQuestion ? "submit" : "continue"}
              </span>
            )}
            {isLastQuestion && !allAnswered && totalQuestions > 1 && (
              <span className="block text-[11px] text-muted-foreground/80 sm:hidden mt-1">
                Answer all questions to submit
              </span>
            )}
            {isLastQuestion && !allAnswered && (
              <span className="hidden sm:inline text-[11px] text-muted-foreground/80 ml-2">
                {totalQuestions > 1
                  ? unansweredCount === 1
                    ? "1 question left"
                    : `${unansweredCount} questions left`
                  : "Answer the question to submit"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!isLastQuestion ? (
              <Button
                type="button"
                size="sm"
                onClick={handleNext}
                disabled={!isCurrentAnswered}
                className="h-8 gap-1 bg-brand text-brand-foreground hover:bg-brand/90"
              >
                Next
                <ChevronRight className="size-3.5" />
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={handleSubmit}
                disabled={!allAnswered || submitting}
                className="h-8 gap-1.5 bg-brand text-brand-foreground hover:bg-brand/90"
                aria-label="Submit answers"
              >
                <Send className="size-3" />
                {totalQuestions > 1 ? "Submit All Answers" : "Submit Answer"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
});
