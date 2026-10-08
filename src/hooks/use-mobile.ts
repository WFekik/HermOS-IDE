import * as React from "react";

export const MOBILE_BREAKPOINT = 768;
export const TABLET_BREAKPOINT = 1024;

export function isMobileWidth(width: number): boolean {
  return width < MOBILE_BREAKPOINT;
}

export function isTabletWidth(width: number): boolean {
  return width >= 768 && width < TABLET_BREAKPOINT;
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return isMobileWidth(window.innerWidth);
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      setIsMobile(isMobileWidth(window.innerWidth));
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return isMobile;
}

export function useIsTablet() {
  const [isTablet, setIsTablet] = React.useState<boolean | undefined>(() => {
    if (typeof window === "undefined") return false;
    return isTabletWidth(window.innerWidth);
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      setIsTablet(isTabletWidth(window.innerWidth));
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return !!isTablet;
}