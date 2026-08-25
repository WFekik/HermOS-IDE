import { describe, it, expect, vi } from "vitest";
import {
  publishTodos,
  subscribeTodoUpdates,
  type AgentTodoLite,
} from "./todo-pubsub";

describe("Todo Pub/Sub", () => {
  it("should deliver published todos to subscriber", () => {
    const listener = vi.fn();
    const todos: AgentTodoLite[] = [
      { id: "1", content: "Fix bug", status: "pending", priority: "high" },
    ];

    subscribeTodoUpdates("user-1", "conv-1", listener);
    publishTodos("user-1", "conv-1", todos);

    expect(listener).toHaveBeenCalledWith(todos);
  });

  it("should not deliver to wrong channel", () => {
    const listener = vi.fn();

    subscribeTodoUpdates("user-1", "conv-1", listener);
    publishTodos("user-2", "conv-2", [{ id: "1", content: "other", status: "done", priority: "low" }]);

    expect(listener).not.toHaveBeenCalled();
  });

  it("should support multiple subscribers on same channel", () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const todos: AgentTodoLite[] = [];

    subscribeTodoUpdates("user-1", "conv-1", listener1);
    subscribeTodoUpdates("user-1", "conv-1", listener2);
    publishTodos("user-1", "conv-1", todos);

    expect(listener1).toHaveBeenCalledWith(todos);
    expect(listener2).toHaveBeenCalledWith(todos);
  });

  it("should stop delivering after unsubscribe", () => {
    const listener = vi.fn();

    const unsubscribe = subscribeTodoUpdates("user-1", "conv-1", listener);
    unsubscribe();
    publishTodos("user-1", "conv-1", [{ id: "1", content: "x", status: "todo", priority: "med" }]);

    expect(listener).not.toHaveBeenCalled();
  });

  it("should handle unsubscribe idempotently", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTodoUpdates("user-1", "conv-1", listener);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("should not throw when publishing with no subscribers", () => {
    expect(() =>
      publishTodos("user-1", "conv-1", [{ id: "1", content: "x", status: "todo", priority: "med" }]),
    ).not.toThrow();
  });

  it("should handle subscriber that throws without breaking others", () => {
    const badListener = vi.fn().mockImplementation(() => { throw new Error("oops"); });
    const goodListener = vi.fn();

    subscribeTodoUpdates("user-1", "conv-1", badListener);
    subscribeTodoUpdates("user-1", "conv-1", goodListener);
    publishTodos("user-1", "conv-1", []);

    expect(goodListener).toHaveBeenCalled();
  });
});
