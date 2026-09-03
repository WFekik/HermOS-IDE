import type {
  PptSlide,
  SlideCard,
  SlideColumn,
  SlideTable,
  SlideStep,
  SlideQuote,
} from "./types";

/**
 * Pure isomorphic layout resolvers for HermOS Office Studio.
 * Zero Node.js dependencies (no fs, child_process, or db).
 * Safe to import in both Client Components and Server Components.
 */

export function resolveSlideCards(slide: PptSlide): SlideCard[] {
  if (slide.cards && slide.cards.length > 0) return slide.cards;
  if (slide.bullets && slide.bullets.length > 0) {
    return slide.bullets.map((b, i) => ({
      title: `Key Highlight ${i + 1}`,
      description: b,
      badge: `Key Point`,
    }));
  }
  return [
    {
      title: "Strategic Objective",
      description: "Core platform milestone and architectural deliverables",
      badge: "Milestone",
    },
    {
      title: "Performance Impact",
      description: "High-throughput processing with sub-100ms response targets",
      badge: "Metrics",
    },
    {
      title: "Operational Excellence",
      description: "End-to-end observability, automated testing, and zero-downtime releases",
      badge: "Operations",
    },
  ];
}

export function resolveSlideColumns(slide: PptSlide): SlideColumn[] {
  if (slide.columns && slide.columns.length === 2) return slide.columns;
  if (slide.bullets && slide.bullets.length > 1) {
    const mid = Math.ceil(slide.bullets.length / 2);
    return [
      { heading: "Current Overview", bullets: slide.bullets.slice(0, mid) },
      { heading: "Target State", bullets: slide.bullets.slice(mid) },
    ];
  }
  return [
    {
      heading: "Core Capabilities",
      bullets: ["Modern architectural design", "Scalable, resilient processing"],
    },
    {
      heading: "Strategic Focus",
      bullets: ["Continuous quality verification", "Enterprise compliance and telemetry"],
    },
  ];
}

export function resolveSlideTable(slide: PptSlide): SlideTable {
  if (slide.table && slide.table.headers && slide.table.headers.length > 0) return slide.table;
  if (slide.bullets && slide.bullets.length > 0) {
    return {
      headers: ["Metric", "Target Value", "Status"],
      rows: slide.bullets.map((b, i) => [`Key Metric ${i + 1}`, b, "On Track"]),
    };
  }
  return {
    headers: ["Component", "Throughput", "Latency (p95)", "Status"],
    rows: [
      ["API Gateway", "50K req/s", "12ms", "On Track"],
      ["Compute Engine", "120 nodes", "45ms", "On Track"],
      ["Data Pipeline", "1.2 TB/hr", "80ms", "Exceeding"],
    ],
  };
}

export function resolveSlideSteps(slide: PptSlide): SlideStep[] {
  if (slide.steps && slide.steps.length > 0) return slide.steps;
  if (slide.bullets && slide.bullets.length > 0) {
    return slide.bullets.map((b, i) => ({
      step: `0${i + 1}`,
      title: `Phase ${i + 1}`,
      description: b,
    }));
  }
  return [
    { step: "01", title: "Discovery", description: "Baseline discovery and architectural scoping" },
    { step: "02", title: "Execution", description: "Core service implementation and automated testing" },
    { step: "03", title: "Delivery", description: "Progressive staged rollout with live observability" },
  ];
}

export function resolveSlideQuote(slide: PptSlide): SlideQuote {
  if (slide.quote && slide.quote.text) return slide.quote;
  if (slide.bullets && slide.bullets.length > 0) {
    return { text: slide.bullets[0], author: "Executive Leadership", role: "HermOS Platform" };
  }
  return {
    text: "Excellence is not an exception, it is a prevailing attitude. Design with purpose and deliver with velocity.",
    author: "Executive Leadership",
    role: "Engineering & Architecture",
  };
}
