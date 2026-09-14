"use client";

import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/stores/app-store";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary caught error]:", error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      const lang = useAppStore.getState().language;
      const title = this.props.fallbackTitle
        ? t(this.props.fallbackTitle, lang)
        : t("something_went_wrong", lang);
      const fallbackDesc = t("error_occurred", lang);
      const tryAgain = t("try_again", lang);

      return (
        <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center bg-background/50 backdrop-blur-xs">
          <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive mb-3">
            <AlertTriangle className="size-6" />
          </div>
          <h3 className="text-base font-semibold text-foreground">
            {title}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground max-w-md font-mono">
            {this.state.error?.message || fallbackDesc}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={this.handleReset}
            className="mt-4 gap-1.5 text-xs"
          >
            <RefreshCw className="size-3.5" />
            {tryAgain}
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
