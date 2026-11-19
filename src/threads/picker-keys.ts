export const isNextKey = (e: React.KeyboardEvent) => e.key === "ArrowDown" || (e.ctrlKey && e.key === "n");
export const isPreviousKey = (e: React.KeyboardEvent) => e.key === "ArrowUp" || (e.ctrlKey && e.key === "p");
export const isAcceptKey = (e: React.KeyboardEvent) => (e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing;
